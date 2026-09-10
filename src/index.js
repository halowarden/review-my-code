import {
  buildMainComment,
  createChunkPrompt,
  createFinalDecisionPrompt,
  dedupeInlineComments,
  parseAIResponse,
  splitDiffIntoChunks,
} from "./reviewFlow.js";

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

  const [, signature] = signatureHeader.split("=");
  if (!signature) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return toHex(digest) === signature;
}

async function githubApiRequest(env, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${text}`);
  }

  return response;
}

async function requestAIReview(env, prompt) {
  const response = await fetch(env.AI_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer ".concat(env.AI_API_KEY),
    },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    throw new Error(`AI API request failed (${response.status}): ${await response.text()}`);
  }

  const payload = await response.json();
  return parseAIResponse(payload);
}

function shouldHandleEvent(action, draft) {
  if (draft) {
    return false;
  }
  return ["opened", "synchronize", "reopened", "ready_for_review"].includes(action);
}

async function processPullRequestReview(env, payload) {
  const { repository, pull_request: pullRequest, action } = payload;
  if (!repository || !pullRequest || !shouldHandleEvent(action, pullRequest.draft)) {
    return { skipped: true };
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const pullNumber = pullRequest.number;

  const diffResponse = await githubApiRequest(env, `/repos/${owner}/${repo}/pulls/${pullNumber}`, {
    headers: { Accept: "application/vnd.github.v3.diff" },
  });
  const diff = await diffResponse.text();
  const chunks = splitDiffIntoChunks(diff);

  const chunkResults = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const prompt = createChunkPrompt({
      owner,
      repo,
      pullNumber,
      chunkIndex: i,
      totalChunks: chunks.length,
      diffChunk: chunks[i],
    });
    chunkResults.push(await requestAIReview(env, prompt));
  }

  const finalDecision = await requestAIReview(
    env,
    createFinalDecisionPrompt({
      owner,
      repo,
      pullNumber,
      chunkFindings: chunkResults.map((result) => result.findings),
    }),
  );

  const inlineComments = dedupeInlineComments(chunkResults.flatMap((result) => result.inlineComments));
  const findings = finalDecision.findings.length
    ? finalDecision.findings
    : chunkResults.flatMap((result) => result.findings);
  const passed = finalDecision.passed;
  const tags = new Set(["ai-reviewed", passed ? "ai-review:passed" : "ai-review:needs-fixes"]);
  for (const tag of [...chunkResults.flatMap((result) => result.tags), ...finalDecision.tags]) {
    if (typeof tag === "string" && tag.trim()) {
      tags.add(tag.trim());
    }
  }

  const commentResponse = await githubApiRequest(env, `/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body: buildMainComment({ summary: finalDecision.summary, findings, passed }),
    }),
  });
  const mainComment = await commentResponse.json();

  await githubApiRequest(env, `/repos/${owner}/${repo}/issues/comments/${mainComment.id}/reactions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github.squirrel-girl-preview+json" },
    body: JSON.stringify({ content: passed ? "+1" : "-1" }),
  });

  if (inlineComments.length > 0) {
    await githubApiRequest(env, `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        body: "Inline AI review comments.",
        event: "COMMENT",
        comments: inlineComments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: "RIGHT",
          body: comment.body,
        })),
      }),
    });
  }

  await githubApiRequest(env, `/repos/${owner}/${repo}/issues/${pullNumber}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [...tags] }),
  });

  return {
    skipped: false,
    passed,
    inlineCommentsCount: inlineComments.length,
    tagCount: tags.size,
  };
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return jsonResponse({ message: "Use POST /webhook" }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse({ message: "Not found" }, 404);
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_WEBHOOK_SECRET || !env.AI_API_URL || !env.AI_API_KEY) {
      return jsonResponse({ message: "Missing required environment variables" }, 500);
    }

    const event = request.headers.get("x-github-event");
    if (event !== "pull_request") {
      return jsonResponse({ skipped: true, reason: "Unsupported event type" });
    }

    const body = await request.text();
    const signatureHeader = request.headers.get("x-hub-signature-256");
    const isValid = await verifyGitHubSignature(body, signatureHeader, env.GITHUB_WEBHOOK_SECRET);
    if (!isValid) {
      return jsonResponse({ message: "Invalid signature" }, 401);
    }

    try {
      const payload = JSON.parse(body);
      const result = await processPullRequestReview(env, payload);
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ message: error.message }, 500);
    }
  },
};

export { processPullRequestReview, shouldHandleEvent, verifyGitHubSignature };
