import {
  buildAIRequestBody,
  buildMainComment,
  buildScopeLine,
  createChunkPrompt,
  createFinalDecisionPrompt,
  dedupeInlineComments,
  extractAIOutput,
  reconcileInlineComments,
  filterDiff,
  parseAIParams,
  parseAIResponse,
  resolveAIFormat,
  resolveAIRequestUrl,
  resolveReviewSettings,
  splitDiffIntoChunks,
} from "./reviewFlow.js";

const REVIEW_LABELS = {
  reviewed: "ai-reviewed",
  passed: "ai-review:passed",
  needsFixes: "ai-review:needs-fixes",
};

const RETRY_DELAY_SECONDS = 60;
// GitHub caps webhook payloads at 25 MB, but pull_request events are well under 1 MB.
const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;
const SIGNATURE_HEADER_PATTERN = /^sha256=[0-9a-f]{64}$/i;
const REVIEWED_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;

function log(level, message, fields = {}) {
  const line = JSON.stringify({ message, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

class ReviewError extends Error {
  constructor(message, { retriable = false, status } = {}) {
    super(message);
    this.name = "ReviewError";
    this.retriable = retriable;
    this.status = status;
  }
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export function isRetriableError(error) {
  if (error instanceof ReviewError) {
    return error.retriable;
  }
  // Network-level failures (DNS, reset) surface as TypeError; AbortSignal.timeout
  // raises a DOMException named TimeoutError. Both are worth a retry.
  return error instanceof TypeError || error?.name === "TimeoutError" || error?.name === "AbortError";
}

function fetchWithTimeout(url, init, timeoutMs) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Reads the request body but refuses to buffer more than `limit` bytes, so an
 * unauthenticated caller cannot make the Worker hash a huge payload.
 */
async function readBodyWithLimit(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return null;
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const parts = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyGitHubSignature(body, signatureHeader, secret) {
  if (!signatureHeader || !secret) {
    return false;
  }

  if (!SIGNATURE_HEADER_PATTERN.test(signatureHeader)) {
    return false;
  }
  const signature = signatureHeader.slice("sha256=".length);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const actual = encoder.encode(toHex(digest));
  const expected = encoder.encode(signature.toLowerCase());
  if (actual.length !== expected.length) {
    return false;
  }
  return constantTimeEqual(actual, expected);
}

function constantTimeEqual(a, b) {
  // Workers expose crypto.subtle.timingSafeEqual; Node (tests) does not.
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function githubApiRequest(env, path, { method = "GET", body, headers = {}, nonFatalStatuses = [] } = {}) {
  const { githubTimeoutMs } = resolveReviewSettings(env);
  const response = await fetchWithTimeout(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "review-my-code-bot",
      ...headers,
    },
    body,
  }, githubTimeoutMs);

  if (!response.ok) {
    if (nonFatalStatuses.includes(response.status)) {
      return response;
    }
    const text = (await response.text()).slice(0, 500);
    throw new ReviewError(`GitHub API request failed (${response.status}) for ${method} ${path}: ${text}`, {
      retriable: isRetriableStatus(response.status),
      status: response.status,
    });
  }

  return response;
}

async function requestAIReview(env, prompt) {
  const format = resolveAIFormat(env.AI_API_FORMAT);
  const { aiTimeoutMs } = resolveReviewSettings(env);
  const response = await fetchWithTimeout(
    resolveAIRequestUrl(env),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify(buildAIRequestBody(env, prompt)),
    },
    aiTimeoutMs,
  );

  if (!response.ok) {
    const text = (await response.text()).slice(0, 500);
    throw new ReviewError(`AI API request failed (${response.status}): ${text}`, {
      retriable: isRetriableStatus(response.status),
      status: response.status,
    });
  }

  let payload;
  try {
    payload = await response.json();
    return parseAIResponse(extractAIOutput(payload, format));
  } catch (error) {
    // Malformed model output is not worth a redelivery; the next push re-triggers a review.
    throw new ReviewError(`AI API returned unparseable JSON: ${error.message}`, { retriable: false });
  }
}

function shouldHandleEvent(action, draft) {
  if (draft) {
    return false;
  }
  return ["opened", "synchronize", "reopened", "ready_for_review"].includes(action);
}

/**
 * Turns a pull_request webhook payload into the minimal job stored on the queue.
 * Returns null when the event should be ignored.
 */
export function createReviewJob(payload) {
  const { repository, pull_request: pullRequest, action } = payload ?? {};
  if (!repository?.owner?.login || !repository?.name || !pullRequest?.number) {
    return null;
  }
  if (!shouldHandleEvent(action, pullRequest.draft)) {
    return null;
  }
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pullNumber: pullRequest.number,
    headSha: pullRequest.head?.sha ?? null,
    action,
  };
}

function parseReviewableLinesFromDiff(diff) {
  const reviewableByPath = new Map();
  const lines = diff.split("\n");
  let currentPath = null;
  let rightLine = null;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const nextPath = line.slice(4).trim();
      currentPath = nextPath.startsWith("b/") ? nextPath.slice(2) : nextPath;
      if (currentPath === "/dev/null") {
        currentPath = null;
      }
      if (currentPath && !reviewableByPath.has(currentPath)) {
        reviewableByPath.set(currentPath, new Set());
      }
      rightLine = null;
      continue;
    }

    if (line.startsWith("@@ ")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      rightLine = match ? Number(match[1]) : null;
      continue;
    }

    if (!currentPath || rightLine === null) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      reviewableByPath.get(currentPath).add(rightLine);
      rightLine += 1;
    } else if (line.startsWith(" ")) {
      reviewableByPath.get(currentPath).add(rightLine);
      rightLine += 1;
    }
    // "-" lines belong to the left side and "\" is the no-newline marker: neither advances.
  }

  return reviewableByPath;
}

function buildReviewComments(inlineComments, reviewableByPath) {
  return inlineComments
    .filter((comment) => reviewableByPath.get(comment.path)?.has(comment.line))
    .map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    }));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      // Claimed synchronously: JavaScript runs one task at a time and there is no
      // await between the read and the increment, so two runners never share an index.
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

const BOT_REACTIONS = ["eyes", "+1", "-1", "confused"];
// Hidden markers let later runs find and refresh this bot's own review and inline comments.
const MAIN_MARKER = "<!-- review-my-code:main -->";
const INLINE_MARKER = "<!-- review-my-code:inline -->";

async function getBotLogin(env) {
  try {
    const response = await githubApiRequest(env, "/user", { nonFatalStatuses: [403, 404] });
    if (!response.ok) {
      return null;
    }
    const user = await response.json();
    return user?.login ?? null;
  } catch (error) {
    log("error", "Could not resolve bot login", { error: error.message });
    return null;
  }
}

/** Follows page numbers until a short page; capped to keep a runaway PR bounded. */
async function githubListAll(env, path, { maxPages = 10 } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await githubApiRequest(env, `${path}${separator}per_page=100&page=${page}`);
    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    items.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return items;
}

async function findMainReview(env, job, login) {
  if (!login) {
    return null;
  }
  const { owner, repo, pullNumber } = job;
  const reviews = await githubListAll(env, `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`);
  const mine = reviews.filter(
    (review) => review?.user?.login === login && typeof review.body === "string" && review.body.includes(MAIN_MARKER),
  );
  return mine.length ? mine[mine.length - 1] : null;
}

async function deleteBotInlineComments(env, job, login) {
  if (!login) {
    return 0;
  }
  const { owner, repo, pullNumber } = job;
  const comments = await githubListAll(env, `/repos/${owner}/${repo}/pulls/${pullNumber}/comments`);
  let deleted = 0;
  for (const comment of comments) {
    if (comment?.user?.login === login && typeof comment.body === "string" && comment.body.includes(INLINE_MARKER)) {
      await githubApiRequest(env, `/repos/${owner}/${repo}/pulls/comments/${comment.id}`, {
        method: "DELETE",
        nonFatalStatuses: [403, 404],
      });
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Replaces the bot's own reaction on the pull request itself: 👀 while a review
 * is running, 👍/👎 when it is done, 😕 when it failed. Reactions are cosmetic,
 * so permission problems are logged and never fail the review.
 */
async function setPullRequestReaction(env, job, content, login) {
  const { owner, repo, pullNumber } = job;
  const base = `/repos/${owner}/${repo}/issues/${pullNumber}/reactions`;
  try {
    const listResponse = await githubApiRequest(env, `${base}?per_page=100`, { nonFatalStatuses: [403, 404] });
    const existing = listResponse.ok ? await listResponse.json() : [];
    for (const reaction of Array.isArray(existing) ? existing : []) {
      if (reaction?.user?.login === login && BOT_REACTIONS.includes(reaction.content) && reaction.content !== content) {
        await githubApiRequest(env, `${base}/${reaction.id}`, { method: "DELETE", nonFatalStatuses: [403, 404] });
      }
    }
    if (!existing.some?.((reaction) => reaction?.user?.login === login && reaction.content === content)) {
      await githubApiRequest(env, base, {
        method: "POST",
        nonFatalStatuses: [403, 404, 422],
        body: JSON.stringify({ content }),
      });
    }
  } catch (error) {
    log("error", "Failed to update PR reaction", { owner, repo, pullNumber, content, error: error.message });
  }
}

async function isHeadStale(env, job) {
  if (!job.headSha) {
    return false;
  }
  const response = await githubApiRequest(env, `/repos/${job.owner}/${job.repo}/pulls/${job.pullNumber}`);
  const pull = await response.json();
  return Boolean(pull?.head?.sha) && pull.head.sha !== job.headSha;
}

export async function processReviewJob(env, job) {
  const { owner, repo, pullNumber } = job;
  const settings = resolveReviewSettings(env);
  const logFields = { owner, repo, pullNumber, headSha: job.headSha };

  if (await isHeadStale(env, job)) {
    log("info", "Skipping stale review job: PR head moved on", logFields);
    return { skipped: true, reason: "stale-head" };
  }

  // Optional KV marker: a redelivered or replayed webhook for an already reviewed
  // head costs one KV read instead of a full set of AI calls.
  const reviewedKey = job.headSha ? `reviewed:${owner}/${repo}/${pullNumber}/${job.headSha}` : null;
  if (env.REVIEW_STATE && reviewedKey && (await env.REVIEW_STATE.get(reviewedKey))) {
    log("info", "Skipping review job: head already reviewed", logFields);
    return { skipped: true, reason: "already-reviewed" };
  }

  const diffResponse = await githubApiRequest(env, `/repos/${owner}/${repo}/pulls/${pullNumber}`, {
    headers: { Accept: "application/vnd.github.v3.diff" },
  });
  const rawDiff = await diffResponse.text();
  const filtered = filterDiff(rawDiff, settings.ignorePatterns);

  if (!filtered.diff) {
    log("info", "Nothing to review after filtering", { ...logFields, ignored: filtered.ignoredPaths.length });
    return { skipped: true, reason: "nothing-to-review", ignoredPaths: filtered.ignoredPaths };
  }

  const login = await getBotLogin(env);
  await setPullRequestReaction(env, job, "eyes", login);
  try {
    return await runReview(env, job, settings, filtered, reviewedKey, login);
  } catch (error) {
    await setPullRequestReaction(env, job, "confused", login);
    throw error;
  }
}

async function runReview(env, job, settings, filtered, reviewedKey, login) {
  const { owner, repo, pullNumber } = job;
  const logFields = { owner, repo, pullNumber, headSha: job.headSha };

  const allChunks = splitDiffIntoChunks(filtered.diff, settings.maxChunkChars);
  const chunks = allChunks.slice(0, settings.maxChunks);
  const unreviewedChunks = allChunks.length - chunks.length;
  const reviewableByPath = parseReviewableLinesFromDiff(filtered.diff);

  const chunkOutcomes = await mapWithConcurrency(chunks, settings.concurrency, (chunk, index) =>
    requestAIReview(
      env,
      createChunkPrompt({
        owner,
        repo,
        pullNumber,
        chunkIndex: index,
        totalChunks: chunks.length,
        diffChunk: chunk,
        reviewedPaths: filtered.reviewedPaths,
        ignoredPaths: filtered.ignoredPaths,
      }),
    ),
  );

  const chunkResults = [];
  let failedChunks = 0;
  let firstFailure = null;
  chunkOutcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      chunkResults.push(outcome.value);
    } else {
      failedChunks += 1;
      firstFailure ??= outcome.reason;
      log("error", "Chunk review failed", { ...logFields, chunkIndex: index, error: outcome.reason?.message });
    }
  });

  if (chunkResults.length === 0) {
    throw firstFailure ?? new ReviewError("All chunk reviews failed", { retriable: true });
  }

  // One successful chunk needs no adjudication: its result is already final.
  const decision =
    chunkResults.length === 1
      ? chunkResults[0]
      : await requestAIReview(
          env,
          createFinalDecisionPrompt({
            owner,
            repo,
            pullNumber,
            chunkFindings: chunkResults.flatMap((result) => result.findings),
            chunkInlineComments: dedupeInlineComments(chunkResults.flatMap((result) => result.inlineComments)),
            totalChunks: chunks.length,
            reviewedChunks: chunkResults.length,
          }),
        );

  const findings = decision.findings.length ? decision.findings : chunkResults.flatMap((result) => result.findings);
  const passed = decision.passed;
  const tags = [...new Set([...chunkResults.flatMap((result) => result.tags), ...decision.tags].map((tag) => tag.trim()))];
  // Single chunk: the chunk's comments are final. Several chunks: the adjudicator
  // returns the comments whose findings survived, with severity reconciled.
  const chunkInlineComments = dedupeInlineComments(chunkResults.flatMap((result) => result.inlineComments));
  const inlineComments =
    chunkResults.length === 1
      ? chunkInlineComments
      : dedupeInlineComments(reconcileInlineComments(decision.inlineComments, chunkInlineComments, findings));
  const reviewComments = buildReviewComments(inlineComments, reviewableByPath);
  const scope = buildScopeLine({
    reviewedPaths: filtered.reviewedPaths,
    ignoredPaths: filtered.ignoredPaths,
    emptyPaths: filtered.emptyPaths,
    totalChunks: allChunks.length,
    failedChunks,
    unreviewedChunks,
  });

  const body = buildMainComment({
    summary: decision.summary,
    findings,
    passed,
    scope,
    tags,
    owner,
    repo,
    headSha: job.headSha,
  });
  const mainBody = `${body}\n\n${MAIN_MARKER}`;
  const inline = reviewComments.map((comment) => ({ ...comment, body: `${comment.body}\n\n${INLINE_MARKER}` }));
  const commitFields = job.headSha ? { commit_id: job.headSha } : {};
  const reviewsPath = `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;

  // One review per PR: later runs update its body in place and replace the inline
  // comments. GitHub cannot attach new inline comments to a submitted review, so
  // refreshed inline comments ride on a short follow-up review.
  const existingReview = await findMainReview(env, job, login);
  const deletedInline = await deleteBotInlineComments(env, job, login);

  async function createReview(reviewBody, comments) {
    const response = await githubApiRequest(env, reviewsPath, {
      method: "POST",
      nonFatalStatuses: comments.length ? [422] : [],
      body: JSON.stringify({ ...commitFields, body: reviewBody, event: "COMMENT", comments }),
    });
    if (response.ok) {
      return comments.length;
    }
    log("error", "Inline comments rejected, posting review body only", {
      ...logFields,
      status: response.status,
      detail: (await response.text()).slice(0, 300),
    });
    await githubApiRequest(env, reviewsPath, {
      method: "POST",
      body: JSON.stringify({ ...commitFields, body: reviewBody, event: "COMMENT", comments: [] }),
    });
    return 0;
  }

  let postedInline = 0;
  if (existingReview) {
    await githubApiRequest(env, `${reviewsPath}/${existingReview.id}`, {
      method: "PUT",
      body: JSON.stringify({ body: mainBody }),
    });
    if (inline.length) {
      const shortSha = job.headSha ? job.headSha.slice(0, 7) : "latest";
      postedInline = await createReview(
        `Inline comments refreshed for \`${shortSha}\`. The summary is in the review above.`,
        inline,
      );
    }
  } else {
    postedInline = await createReview(mainBody, inline);
  }

  await setPullRequestReaction(env, job, passed ? "+1" : "-1", login);

  // Only well-known labels are applied; AI-provided tags stay in the comment so a
  // typo from the model can never create or fail on arbitrary repository labels.
  const labels = [REVIEW_LABELS.reviewed, passed ? REVIEW_LABELS.passed : REVIEW_LABELS.needsFixes];
  await githubApiRequest(env, `/repos/${owner}/${repo}/issues/${pullNumber}/labels`, {
    method: "POST",
    nonFatalStatuses: [403, 404, 422],
    body: JSON.stringify({ labels }),
  });
  await githubApiRequest(env, `/repos/${owner}/${repo}/issues/${pullNumber}/labels/${encodeURIComponent(passed ? REVIEW_LABELS.needsFixes : REVIEW_LABELS.passed)}`, {
    method: "DELETE",
    nonFatalStatuses: [403, 404, 422],
  });

  if (env.REVIEW_STATE && reviewedKey) {
    await env.REVIEW_STATE.put(reviewedKey, new Date().toISOString(), { expirationTtl: REVIEWED_MARKER_TTL_SECONDS });
  }

  log("info", "Review posted", {
    ...logFields,
    passed,
    chunks: chunks.length,
    failedChunks,
    unreviewedChunks,
    inlineComments: postedInline,
    deletedInline,
    updatedExistingReview: Boolean(existingReview),
    aiCalls: chunks.length + (chunkResults.length > 1 ? 1 : 0),
  });

  return {
    skipped: false,
    passed,
    chunkCount: chunks.length,
    failedChunks,
    unreviewedChunks,
    inlineCommentsCount: postedInline,
    updatedExistingReview: Boolean(existingReview),
    tagCount: tags.length,
  };
}

export async function processPullRequestReview(env, payload) {
  const job = createReviewJob(payload);
  if (!job) {
    return { skipped: true, reason: "unsupported-event" };
  }
  return processReviewJob(env, job);
}

function validateEnv(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_WEBHOOK_SECRET || !env.AI_API_URL || !env.AI_API_KEY) {
    return "Missing required environment variables";
  }
  try {
    parseAIParams(env.AI_PARAMS);
    resolveAIFormat(env.AI_API_FORMAT);
    resolveReviewSettings(env);
  } catch (error) {
    log("error", "Invalid environment configuration", { error: error.message });
    return `Invalid environment configuration: ${error.message}`;
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return jsonResponse({ message: "Use POST /webhook" }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse({ message: "Not found" }, 404);
    }

    const envError = validateEnv(env);
    if (envError) {
      return jsonResponse({ message: envError }, 500);
    }

    // Cheap rejections first: nothing below reads or hashes the body until the
    // request at least looks like a signed GitHub pull_request delivery.
    const event = request.headers.get("x-github-event");
    if (event !== "pull_request") {
      return jsonResponse({ skipped: true, reason: "Unsupported event type" });
    }

    const signatureHeader = request.headers.get("x-hub-signature-256") ?? "";
    if (!SIGNATURE_HEADER_PATTERN.test(signatureHeader)) {
      return jsonResponse({ message: "Invalid signature" }, 401);
    }

    const body = await readBodyWithLimit(request, MAX_WEBHOOK_BODY_BYTES);
    if (body === null) {
      return jsonResponse({ message: "Payload too large" }, 413);
    }

    const isValid = await verifyGitHubSignature(body, signatureHeader, env.GITHUB_WEBHOOK_SECRET);
    if (!isValid) {
      return jsonResponse({ message: "Invalid signature" }, 401);
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse({ message: "Invalid JSON body" }, 400);
    }

    const job = createReviewJob(payload);
    if (!job) {
      return jsonResponse({ skipped: true, reason: "Unsupported action or draft PR" });
    }

    const deliveryId = request.headers.get("x-github-delivery");
    if (env.REVIEW_QUEUE) {
      // GitHub gives a webhook 10 seconds; the review takes far longer. The queue
      // consumer has 15 minutes of wall time and only CPU time is billed.
      await env.REVIEW_QUEUE.send(job);
      log("info", "Review job queued", { ...job, deliveryId });
      return jsonResponse({ queued: true, ...job }, 202);
    }

    // No queue binding: best effort. waitUntil keeps the Worker alive for at most
    // 30 seconds after the response, so long reviews can be cut off in this mode.
    const work = processReviewJob(env, job).catch((error) => {
      log("error", "Inline review failed", { ...job, deliveryId, error: error.message });
    });
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(work);
    } else {
      await work;
    }
    log("info", "Review job started inline (no REVIEW_QUEUE binding)", { ...job, deliveryId });
    return jsonResponse({ queued: false, inline: true, ...job }, 202);
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        const result = await processReviewJob(env, job);
        log("info", "Queue message processed", { ...job, messageId: message.id, attempt: message.attempts, ...result });
        message.ack();
      } catch (error) {
        const retriable = isRetriableError(error);
        log("error", "Queue message failed", {
          ...job,
          messageId: message.id,
          attempt: message.attempts,
          retriable,
          error: error.message,
        });
        if (retriable) {
          message.retry({ delaySeconds: RETRY_DELAY_SECONDS * message.attempts });
        } else {
          message.ack();
        }
      }
    }
  },
};

export {
  buildReviewComments,
  parseReviewableLinesFromDiff,
  shouldHandleEvent,
  verifyGitHubSignature,
};
