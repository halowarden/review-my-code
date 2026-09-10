import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAIRequestBody,
  buildCategoryTable,
  buildMainComment,
  buildScopeLine,
  createChunkPrompt,
  createFinalDecisionPrompt,
  dedupeInlineComments,
  extractAIOutput,
  filterDiff,
  parseAIParams,
  parseAIResponse,
  parseFinding,
  reconcileInlineComments,
  resolveAIFormat,
  resolveAIRequestUrl,
  resolveReviewSettings,
  shouldIgnorePath,
  splitDiffIntoChunks,
  splitDiffIntoFiles,
} from "../src/reviewFlow.js";
import { REVIEW_PROTOCOL } from "../src/reviewProtocol.js";
import worker, { createReviewJob, isRetriableError, processPullRequestReview, processReviewJob } from "../src/index.js";

const SIMPLE_DIFF =
  "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-console.log(1)\n+console.log(2)\n";

function fileDiff(path, addedLines = 1, filler = "x") {
  const body = Array.from({ length: addedLines }, (_, i) => `+${filler}${i}`).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${addedLines} @@\n${body}\n`;
}

async function hmacHeader(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Most orchestration tests use the raw "prompt" format so the mock can answer with the
// review object directly; the OpenAI default has its own end-to-end test below.
const BASE_ENV = {
  GITHUB_TOKEN: "token",
  GITHUB_WEBHOOK_SECRET: "secret",
  AI_API_URL: "https://ai.example/review",
  AI_API_KEY: "key",
  AI_API_FORMAT: "prompt",
};

const BASE_PAYLOAD = {
  action: "opened",
  repository: { name: "repo", owner: { login: "owner" } },
  pull_request: { number: 12, draft: false },
};

/**
 * Installs a fetch mock. `ai` can be a function (prompt) => response object,
 * and `diff` is the text returned for the PR diff request.
 */
function mockFetch({
  diff = SIMPLE_DIFF,
  ai,
  pullJson = {},
  labelsStatus = 200,
  reactions = [],
  existingReviews = [],
  existingInline = [],
} = {}) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const accept = options.headers?.Accept ?? "";

    if (url === "https://ai.example/review" || url === "https://ai.example/review/chat/completions") {
      const request = JSON.parse(options.body);
      const result = ai
        ? await ai(request.prompt, request)
        : { passed: true, summary: "ok", tags: [], findings: [], inlineComments: [] };
      return result instanceof Response ? result : Response.json(result);
    }
    if (url.endsWith("/pulls/12") && accept.includes("diff")) {
      return new Response(diff, { status: 200 });
    }
    if (url.endsWith("/pulls/12")) {
      return Response.json(pullJson);
    }
    if (url.endsWith("/user")) {
      return Response.json({ login: "review-bot" });
    }
    if (url.includes("/pulls/12/reviews?") && options.method !== "POST") {
      return Response.json(url.includes("page=1") ? existingReviews : []);
    }
    if (url.includes("/pulls/12/comments?") && options.method !== "POST") {
      return Response.json(url.includes("page=1") ? existingInline : []);
    }
    if (url.includes("/issues/12/reactions") && options.method !== "POST" && options.method !== "DELETE") {
      return Response.json(reactions);
    }
    if (url.includes("/issues/12/labels")) {
      return new Response(labelsStatus === 200 ? "{}" : "missing labels", { status: labelsStatus });
    }
    return Response.json({});
  };
  return { calls, restore: () => (global.fetch = originalFetch) };
}

function reviewCalls(calls) {
  return calls.filter((call) => call.url.includes("/pulls/12/reviews") && call.options.method === "POST");
}

function postedReviewBody(calls) {
  const [call] = reviewCalls(calls);
  return call ? JSON.parse(call.options.body) : null;
}

function reactionContents(calls) {
  return calls
    .filter((call) => call.url.endsWith("/issues/12/reactions") && call.options.method === "POST")
    .map((call) => JSON.parse(call.options.body).content);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

test("createChunkPrompt embeds the review protocol, chunk context, file lists, and output contract", () => {
  const prompt = createChunkPrompt({
    owner: "owner",
    repo: "repo",
    pullNumber: 7,
    chunkIndex: 1,
    totalChunks: 3,
    diffChunk: "diff --git a/x.js b/x.js",
    reviewedPaths: ["src/x.js", "test/x.test.js"],
    ignoredPaths: ["package-lock.json"],
  });

  assert.match(prompt, /owner\/repo#7/);
  assert.match(prompt, /chunk 2\/3/);
  assert.ok(prompt.includes(REVIEW_PROTOCOL));
  assert.match(prompt, /- test\/x\.test\.js/);
  assert.match(prompt, /Skipped \(not reviewed by policy\)\n- package-lock\.json/);
  assert.match(prompt, /🔴 Blocking/);
  assert.match(prompt, /Report only High and Medium findings/);
  assert.match(prompt, /never a removed \(-\) line/);
  assert.match(prompt, /"inlineComments"/);
  assert.ok(prompt.endsWith("diff --git a/x.js b/x.js"));
});

test("createChunkPrompt in single-chunk mode asks for a final verdict directly", () => {
  const prompt = createChunkPrompt({
    owner: "o",
    repo: "r",
    pullNumber: 1,
    chunkIndex: 0,
    totalChunks: 1,
    diffChunk: "d",
  });

  assert.match(prompt, /complete reviewable diff/);
  assert.match(prompt, /⛔ Needs rework/);
  assert.doesNotMatch(prompt, /Chunk context/);
});

test("createFinalDecisionPrompt keeps the adjudicator marker and adjudication rules", () => {
  const findings = ["🔴 🐛 **A** — a.js:1 — breaks", "🔴 🐛 **A** — a.js:1 — breaks"];
  const inline = [{ path: "a.js", line: 1, body: "🔴 🐛 breaks" }];
  const prompt = createFinalDecisionPrompt({
    owner: "owner",
    repo: "repo",
    pullNumber: 7,
    chunkFindings: findings,
    chunkInlineComments: inline,
    totalChunks: 4,
    reviewedChunks: 3,
  });

  assert.match(prompt, /final review adjudicator/);
  assert.match(prompt, /split into 4 chunks and 3 of them were reviewed/);
  assert.match(prompt, /Merge duplicates/);
  assert.match(prompt, /Resolve contradictions/);
  assert.match(prompt, /passed is true only when no 🔴 blocking finding survives/);
  assert.match(prompt, /Reconcile inline comments/);
  assert.ok(prompt.includes(JSON.stringify(findings)));
  assert.ok(prompt.endsWith(JSON.stringify(inline)));
});

test("createFinalDecisionPrompt tolerates a missing chunk count", () => {
  const prompt = createFinalDecisionPrompt({ owner: "o", repo: "r", pullNumber: 1, chunkFindings: [] });
  assert.match(prompt, /split into several chunks/);
});

// ---------------------------------------------------------------------------
// Diff filtering and chunking
// ---------------------------------------------------------------------------

test("shouldIgnorePath skips lockfiles, caches, generated and binary assets by default", () => {
  for (const path of [
    "package-lock.json",
    "apps/web/package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "node_modules/left-pad/index.js",
    "packages/a/node_modules/b/c.js",
    "dist/bundle.js",
    "src/app.min.js",
    "src/app.js.map",
    ".next/server/page.js",
    "coverage/lcov.info",
    "src/__snapshots__/a.test.js.snap",
    "assets/logo.png",
  ]) {
    assert.equal(shouldIgnorePath(path), true, `${path} should be ignored`);
  }
  for (const path of ["src/index.js", "package.json", "docs/lockfile-guide.md", "src/build.js", "lockbox.js"]) {
    assert.equal(shouldIgnorePath(path), false, `${path} should be reviewed`);
  }
});

test("resolveReviewSettings merges REVIEW_IGNORE_PATTERNS and validates numbers", () => {
  const settings = resolveReviewSettings({ REVIEW_IGNORE_PATTERNS: "generated/, **/*.gen.ts", AI_MAX_CHUNKS: "2" });
  assert.equal(settings.maxChunks, 2);
  assert.equal(shouldIgnorePath("src/generated/schema.ts", settings.ignorePatterns), true);
  assert.equal(shouldIgnorePath("src/api.gen.ts", settings.ignorePatterns), true);
  assert.equal(shouldIgnorePath("src/api.ts", settings.ignorePatterns), false);
  assert.throws(() => resolveReviewSettings({ AI_MAX_CHUNK_CHARS: "lots" }), /positive integer/);
  assert.throws(() => resolveReviewSettings({ AI_CONCURRENCY: "0" }), /positive integer/);
});

test("splitDiffIntoFiles extracts paths for added, deleted, and renamed files", () => {
  const diff =
    fileDiff("src/a.js") +
    "diff --git a/old.js b/old.js\ndeleted file mode 100644\n--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n" +
    "diff --git a/from.js b/to.js\nsimilarity index 100%\nrename from from.js\nrename to to.js\n" +
    "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
  const files = splitDiffIntoFiles(diff);

  assert.deepEqual(
    files.map((file) => [file.path, file.hasHunks]),
    [
      ["src/a.js", true],
      ["old.js", true],
      ["to.js", false],
      ["img.png", false],
    ],
  );
});

test("filterDiff drops ignored, binary, and rename-only files and reports them", () => {
  const diff =
    fileDiff("src/a.js") +
    fileDiff("package-lock.json", 3) +
    "diff --git a/from.js b/to.js\nsimilarity index 100%\nrename from from.js\nrename to to.js\n" +
    "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
  const result = filterDiff(diff);

  assert.deepEqual(result.reviewedPaths, ["src/a.js"]);
  assert.deepEqual(result.ignoredPaths, ["package-lock.json", "img.png"]);
  assert.deepEqual(result.emptyPaths, ["to.js"]);
  assert.match(result.diff, /^diff --git a\/src\/a\.js/);
  assert.doesNotMatch(result.diff, /package-lock/);
});

test("splitDiffIntoChunks keeps whole files together and splits big files at hunk boundaries", () => {
  const small = fileDiff("a.js", 2);
  const big = `diff --git a/big.js b/big.js\n--- a/big.js\n+++ b/big.js\n@@ -1,0 +1,3 @@\n+one\n+two\n+three\n@@ -10,0 +20,3 @@\n+four\n+five\n+six\n@@ -30,0 +50,3 @@\n+seven\n+eight\n+nine\n`;
  const diff = small + fileDiff("b.js", 2) + big;
  const maxChunkSize = 130;
  const chunks = splitDiffIntoChunks(diff, maxChunkSize);

  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= maxChunkSize), "chunks respect the size budget");
  // Every chunk starts with a file header, never mid-file.
  assert.ok(chunks.every((chunk) => chunk.startsWith("diff --git ")));
  // The big file is split at hunk boundaries and each piece carries the file header.
  const bigChunks = chunks.filter((chunk) => chunk.includes("b/big.js"));
  assert.ok(bigChunks.length >= 2);
  assert.ok(bigChunks.every((chunk) => /\+\+\+ b\/big\.js\n@@ /.test(chunk)));
  // Nothing is lost: every added line appears exactly once across chunks.
  for (const word of ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]) {
    assert.equal(chunks.filter((chunk) => chunk.includes(`+${word}`)).length, 1, word);
  }
});

test("splitDiffIntoChunks returns a single chunk when the diff fits", () => {
  const diff = fileDiff("a.js", 3) + fileDiff("b.js", 3);
  assert.deepEqual(splitDiffIntoChunks(diff), [diff]);
});

test("splitDiffIntoChunks falls back to line splitting for plain text", () => {
  const diff = "a".repeat(30) + "\n" + "b".repeat(30) + "\n" + "c".repeat(30);
  const chunks = splitDiffIntoChunks(diff, 40);

  assert.equal(chunks.length, 3);
  assert.equal(chunks.join("\n"), diff);
});

test("splitDiffIntoChunks hard-limits chunk size for oversized lines", () => {
  const diff = "x".repeat(105);
  const chunks = splitDiffIntoChunks(diff, 20);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 20));
});

// ---------------------------------------------------------------------------
// Parsing and formatting helpers
// ---------------------------------------------------------------------------

test("dedupeInlineComments removes duplicates and invalid comments", () => {
  const input = [
    { path: "src/a.js", line: 10, body: "Fix this" },
    { path: "src/a.js", line: 10, body: "fix this " },
    { path: "src/a.js", line: 0, body: "Zero line rejected" },
    { path: "src/a.js", line: 1.5, body: "Decimal rejected" },
    { path: "src/b.js", line: 2, body: "Nit" },
    { path: "", line: 2, body: "Missing path" },
  ];

  const result = dedupeInlineComments(input);
  assert.deepEqual(result, [
    { path: "src/a.js", line: 10, body: "Fix this" },
    { path: "src/b.js", line: 2, body: "Nit" },
  ]);
});

test("parseAIResponse supports nested output JSON strings and fenced JSON", () => {
  const parsed = parseAIResponse({
    output: JSON.stringify({
      passed: true,
      summary: "Looks good",
      tags: ["security", 42, ""],
      inlineComments: [],
      findings: ["ok", null],
    }),
  });

  assert.equal(parsed.passed, true);
  assert.equal(parsed.summary, "Looks good");
  assert.deepEqual(parsed.tags, ["security"]);
  assert.deepEqual(parsed.findings, ["ok"]);

  const fenced = parseAIResponse("```json\n{\"passed\": false, \"summary\": \"\", \"findings\": [\"x\"]}\n```");
  assert.equal(fenced.passed, false);
  assert.equal(fenced.summary, "AI review completed.");
  assert.deepEqual(fenced.findings, ["x"]);
});

test("parseAIParams accepts empty, JSON objects, and rejects invalid values", () => {
  assert.deepEqual(parseAIParams(undefined), {});
  assert.deepEqual(parseAIParams(""), {});
  assert.deepEqual(parseAIParams('{"temperature":0,"max_tokens":4000}'), { temperature: 0, max_tokens: 4000 });
  assert.throws(() => parseAIParams("not json"), /AI_PARAMS must be a JSON object/);
  assert.throws(() => parseAIParams("[1]"), /AI_PARAMS must be a JSON object/);
  assert.throws(() => parseAIParams('{"prompt":"x"}'), /must not set "prompt"/);
  assert.throws(() => parseAIParams('{"model":"x"}'), /must not set "model"/);
});

test("buildAIRequestBody merges AI_MODEL and AI_PARAMS around the prompt", () => {
  const env = { AI_API_FORMAT: "prompt" };
  assert.deepEqual(buildAIRequestBody(env, "p"), { prompt: "p" });
  assert.deepEqual(buildAIRequestBody({ ...env, AI_MODEL: "  " }, "p"), { prompt: "p" });
  assert.deepEqual(
    buildAIRequestBody({ ...env, AI_MODEL: "claude-sonnet-5", AI_PARAMS: '{"temperature":0}' }, "p"),
    { temperature: 0, model: "claude-sonnet-5", prompt: "p" },
  );
});

test("openai format builds chat messages, resolves the URL, and unwraps choices", () => {
  const env = { AI_API_FORMAT: "openai", AI_API_URL: "https://ai.example/compatible-mode/v1/", AI_MODEL: "qwen3.8-max" };
  const body = buildAIRequestBody(env, "review this");
  assert.deepEqual(buildAIRequestBody({ AI_API_FORMAT: "prompt" }, "p"), { prompt: "p" });
  assert.equal(body.model, "qwen3.8-max");
  assert.equal(body.prompt, undefined);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.deepEqual(body.messages[1], { role: "user", content: "review this" });

  assert.equal(resolveAIRequestUrl(env), "https://ai.example/compatible-mode/v1/chat/completions");
  assert.equal(
    resolveAIRequestUrl({ ...env, AI_API_URL: "https://ai.example/v1/chat/completions" }),
    "https://ai.example/v1/chat/completions",
  );
  assert.equal(resolveAIRequestUrl({ AI_API_URL: "https://ai.example/review", AI_API_FORMAT: "prompt" }), "https://ai.example/review");

  assert.equal(resolveAIFormat(undefined), "openai");
  assert.equal(resolveAIFormat(""), "openai");
  assert.equal(resolveAIFormat(" Prompt "), "prompt");
  assert.throws(() => resolveAIFormat("anthropic"), /AI_API_FORMAT must be one of/);

  const wrapped = { choices: [{ message: { role: "assistant", content: '{"passed":true,"summary":"ok"}' } }] };
  assert.equal(extractAIOutput(wrapped, "openai"), '{"passed":true,"summary":"ok"}');
  assert.throws(() => extractAIOutput({ choices: [] }, "openai"), /no choices\[0\]/);
  assert.deepEqual(extractAIOutput({ passed: true }, "prompt"), { passed: true });
  assert.throws(() => extractAIOutput({ passed: true }), /no choices\[0\]/, "default format is openai");
});

test("default (openai) format end-to-end posts to chat/completions and parses the choice content", async () => {
  const { calls, restore } = mockFetch({
    ai: (prompt, request) => {
      assert.ok(Array.isArray(request.messages));
      assert.equal(request.response_format.type, "json_object");
      return { choices: [{ message: { content: '{"passed":true,"summary":"✅ Mergeable","tags":[],"findings":[],"inlineComments":[]}' } }] };
    },
  });
  try {
    const result = await processPullRequestReview(
      {
        ...BASE_ENV,
        AI_API_FORMAT: undefined,
        AI_PARAMS: '{"response_format":{"type":"json_object"}}',
      },
      BASE_PAYLOAD,
    );
    assert.equal(result.passed, true);
    assert.ok(calls.some((call) => call.url === "https://ai.example/review/chat/completions"));
  } finally {
    restore();
  }
});

test("buildScopeLine reports coverage honestly", () => {
  assert.equal(buildScopeLine({ reviewedPaths: ["a"] }), "Reviewed: 1 file");
  assert.equal(
    buildScopeLine({ reviewedPaths: ["a", "b"], ignoredPaths: ["lock"], emptyPaths: ["r"], totalChunks: 3, failedChunks: 1, unreviewedChunks: 2 }),
    "Reviewed: 2 files in 3 chunks — skipped 2 (lockfiles, generated, binary, or no content changes) — ⚠️ 2 chunks not reviewed: diff exceeds the review budget — ⚠️ 1 chunk not reviewed: AI request failed",
  );
});

test("parseFinding splits protocol-formatted lines and keeps unknown lines raw", () => {
  assert.deepEqual(
    parseFinding("🔴 🛡️ **Retry storm** — src/a.js:12 — retries without backoff — add jitter"),
    {
      raw: "🔴 🛡️ **Retry storm** — src/a.js:12 — retries without backoff — add jitter",
      severity: "🔴",
      category: "🛡",
      title: "Retry storm",
      location: "src/a.js:12",
      details: "retries without backoff — add jitter",
    },
  );
  const noLocation = parseFinding("🟡 🧹 **Naming** — hides the unit");
  assert.equal(noLocation.location, null);
  assert.equal(noLocation.details, "hides the unit");
  const raw = parseFinding("Something odd");
  assert.equal(raw.severity, null);
  assert.equal(raw.title, "Something odd");
});

test("reconcileInlineComments prefers the adjudicator and falls back to matching chunk comments", () => {
  const chunk = [
    { path: "a.js", line: 1, body: "keep" },
    { path: "b.js", line: 9, body: "dropped finding" },
  ];
  const findings = ["🔴 🐛 **A** — a.js:1 — x", "🟡 🧹 **No location** — y"];
  assert.deepEqual(reconcileInlineComments([{ path: "z.js", line: 2, body: "adj" }], chunk, findings), [
    { path: "z.js", line: 2, body: "adj" },
  ]);
  assert.deepEqual(reconcileInlineComments([], chunk, findings), [{ path: "a.js", line: 1, body: "keep" }]);
  assert.deepEqual(reconcileInlineComments(undefined, chunk, []), []);
});

test("multi-chunk review keeps chunk inline comments when the adjudicator omits them", async () => {
  const { calls, restore } = mockFetch({
    diff: fileDiff("a.js", 3) + fileDiff("b.js", 3),
    ai: (prompt) =>
      prompt.includes("final review adjudicator")
        ? { passed: false, summary: "⛔", tags: [], findings: ["🔴 🐛 **A** — a.js:1 — x"] }
        : {
            passed: false,
            summary: "chunk",
            tags: [],
            findings: ["🔴 🐛 **A** — a.js:1 — x", "🟡 🧹 **B** — b.js:1 — y"],
            inlineComments: [
              { path: "a.js", line: 1, body: "🔴 🐛 x" },
              { path: "b.js", line: 1, body: "🟡 🧹 y" },
            ],
          },
  });
  try {
    await processPullRequestReview({ ...BASE_ENV, AI_MAX_CHUNK_CHARS: "120" }, BASE_PAYLOAD);
    const comments = postedReviewBody(calls).comments;
    assert.deepEqual(comments.map((comment) => `${comment.path}:${comment.line}`), ["a.js:1"]);
  } finally {
    restore();
  }
});

test("buildCategoryTable summarises findings per category", () => {
  const table = buildCategoryTable([
    parseFinding("🔴 🐛 **A** — a.js:1 — x"),
    parseFinding("🟡 🐛 **B** — a.js:2 — y"),
    parseFinding("🟡 🧪 **C** — t.js:1 — z"),
  ]);
  assert.match(table, /\| 🐛 Correctness \| ❌ 1 blocking, 1 follow-up \|/);
  assert.match(table, /\| 🧪 Tests \| ⚠️ 1 issue \|/);
  assert.match(table, /\| 🔒 Security \| ✅ Clean \|/);
  assert.match(table, /\| 🛡️ Reliability \| ✅ Clean \|/);
});

test("buildMainComment renders heading, scope, category table, collapsible findings, links, and tags", () => {
  const passedComment = buildMainComment({ summary: "ok", findings: [], passed: true });
  assert.match(passedComment, /^## ✅ AI Review Passed/);
  assert.match(passedComment, /No actionable issues found/);
  assert.doesNotMatch(passedComment, /<details>/);

  const failedComment = buildMainComment({
    summary: "needs fixes",
    findings: ["🔴 🔒 **Token <leak>** — src/a.js:12 — the token is logged; redact it", "plain line"],
    passed: false,
    scope: "Reviewed: 2 files",
    tags: ["security"],
    owner: "owner",
    repo: "repo",
    headSha: "abc123",
  });
  assert.match(failedComment, /^## ❌ AI Review Needs Attention/);
  assert.match(failedComment, /_Reviewed: 2 files_/);
  assert.match(failedComment, /\| 🔒 Security \| ❌ 1 blocking \|/);
  assert.match(failedComment, /\| ❔ Uncategorized \| ⚠️ 1 issue \|/);
  assert.match(failedComment, /\*\*Findings \(2\)\*\*/);
  assert.match(failedComment, /<summary>🔴 🔒 <b>Token &lt;leak&gt;<\/b> — <a href="https:\/\/github.com\/owner\/repo\/blob\/abc123\/src\/a.js#L12"><code>src\/a.js:12<\/code><\/a><\/summary>/);
  assert.match(failedComment, /\n\nthe token is logged; redact it\n\n<\/details>/);
  const escaped = buildMainComment({ summary: "s", findings: ["🟡 🧹 **T** — a.js:1 — use Map<string> not <img>"], passed: true });
  assert.match(escaped, /use Map&lt;string&gt; not &lt;img&gt;/);
  assert.match(failedComment, /- plain line/);
  assert.match(failedComment, /Tags: `security`/);
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

test("createReviewJob extracts the minimal job and ignores drafts and unsupported actions", () => {
  assert.deepEqual(
    createReviewJob({
      action: "synchronize",
      repository: { name: "repo", owner: { login: "owner" } },
      pull_request: { number: 5, draft: false, head: { sha: "abc" } },
    }),
    { owner: "owner", repo: "repo", pullNumber: 5, headSha: "abc", action: "synchronize" },
  );
  assert.equal(createReviewJob({ ...BASE_PAYLOAD, action: "closed" }), null);
  assert.equal(createReviewJob({ ...BASE_PAYLOAD, pull_request: { number: 1, draft: true } }), null);
  assert.equal(createReviewJob({}), null);
});

test("single-chunk PR uses the chunk result directly and makes exactly one AI call", async () => {
  const { calls, restore } = mockFetch({
    ai: () => ({
      passed: false,
      summary: "⛔ Needs rework",
      tags: ["security"],
      findings: ["🔴 🔒 **Bad** — a.js:1 — impact"],
      inlineComments: [{ path: "a.js", line: 1, body: "🔴 🔒 Use better value" }],
    }),
  });

  try {
    const result = await processPullRequestReview(
      { ...BASE_ENV, AI_MODEL: "test-model", AI_PARAMS: '{"temperature":0}' },
      BASE_PAYLOAD,
    );

    assert.equal(result.skipped, false);
    assert.equal(result.passed, false);
    assert.equal(result.chunkCount, 1);

    const aiCalls = calls.filter((call) => call.url === "https://ai.example/review");
    assert.equal(aiCalls.length, 1);
    const requestBody = JSON.parse(aiCalls[0].options.body);
    assert.equal(requestBody.model, "test-model");
    assert.equal(requestBody.temperature, 0);
    assert.match(requestBody.prompt, /complete reviewable diff/);

    assert.equal(reviewCalls(calls).length, 1, "one PR review carries body and inline comments");
    const reviewBody = postedReviewBody(calls);
    assert.equal(reviewBody.event, "COMMENT");
    assert.deepEqual(reviewBody.comments, [
      { path: "a.js", line: 1, side: "RIGHT", body: "🔴 🔒 Use better value\n\n<!-- review-my-code:inline -->" },
    ]);
    assert.match(reviewBody.body, /^## ❌ AI Review Needs Attention/);
    assert.match(reviewBody.body, /Reviewed: 1 file/);
    assert.match(reviewBody.body, /\| 🔒 Security \| ❌ 1 blocking \|/);
    assert.match(reviewBody.body, /<summary>🔴 🔒 <b>Bad<\/b>/);
    assert.match(reviewBody.body, /Tags: `security`/);
    assert.match(reviewBody.body, /<!-- review-my-code:main -->$/);
    assert.match(reviewBody.comments[0].body, /<!-- review-my-code:inline -->$/);
    assert.equal(calls.some((call) => call.url.includes("/issues/12/comments")), false, "no separate issue comment");
    assert.equal(result.updatedExistingReview, false);

    assert.deepEqual(reactionContents(calls), ["eyes", "-1"], "👀 while reviewing, 👎 when done, on the PR itself");

    const labelsCall = calls.find((call) => call.url.endsWith("/issues/12/labels") && call.options.method === "POST");
    assert.deepEqual(JSON.parse(labelsCall.options.body).labels, ["ai-reviewed", "ai-review:needs-fixes"]);
    const removeCall = calls.find((call) => call.options.method === "DELETE");
    assert.match(removeCall.url, /labels\/ai-review%3Apassed$/);

  } finally {
    restore();
  }
});

test("multi-chunk PR runs the adjudicator and honours AI_CONCURRENCY", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { calls, restore } = mockFetch({
    diff: fileDiff("a.js", 3) + fileDiff("b.js", 3) + fileDiff("c.js", 3),
    ai: async (prompt) => {
      if (prompt.includes("final review adjudicator")) {
        assert.match(prompt, /"path":"a\.js","line":1/, "adjudicator receives chunk inline comments");
        return {
          passed: false,
          summary: "⛔ Needs rework",
          tags: [],
          findings: ["merged finding"],
          inlineComments: [{ path: "a.js", line: 1, body: "🟡 🐛 reconciled" }],
        };
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        passed: true,
        summary: "chunk",
        tags: ["tests"],
        findings: ["chunk finding"],
        inlineComments: [
          { path: "a.js", line: 1, body: "🔴 🐛 chunk-level" },
          { path: "b.js", line: 1, body: "🟡 🧹 dropped by adjudicator" },
        ],
      };
    },
  });

  try {
    const result = await processPullRequestReview(
      { ...BASE_ENV, AI_MAX_CHUNK_CHARS: "120", AI_CONCURRENCY: "2" },
      BASE_PAYLOAD,
    );

    assert.equal(result.chunkCount, 3);
    assert.equal(result.passed, false);
    assert.equal(maxInFlight, 2);
    const aiCalls = calls.filter((call) => call.url === "https://ai.example/review");
    assert.equal(aiCalls.length, 4);
    const finalPrompt = JSON.parse(aiCalls[3].options.body).prompt;
    assert.match(finalPrompt, /split into 3 chunks and 3 of them were reviewed/);
    const reviewBody = postedReviewBody(calls);
    assert.match(reviewBody.body, /- merged finding/);
    assert.match(reviewBody.body, /Reviewed: 3 files in 3 chunks/);
    assert.deepEqual(reviewBody.comments, [
      { path: "a.js", line: 1, side: "RIGHT", body: "🟡 🐛 reconciled\n\n<!-- review-my-code:inline -->" },
    ]);
  } finally {
    restore();
  }
});

test("chunk budget caps AI calls and reports unreviewed chunks in scope", async () => {
  const { calls, restore } = mockFetch({
    diff: fileDiff("a.js", 3) + fileDiff("b.js", 3) + fileDiff("c.js", 3),
    ai: (prompt) =>
      prompt.includes("final review adjudicator")
        ? { passed: true, summary: "✅ Mergeable", tags: [], findings: [] }
        : { passed: true, summary: "chunk", tags: [], findings: [], inlineComments: [] },
  });

  try {
    const result = await processPullRequestReview(
      { ...BASE_ENV, AI_MAX_CHUNK_CHARS: "120", AI_MAX_CHUNKS: "2" },
      BASE_PAYLOAD,
    );

    assert.equal(result.chunkCount, 2);
    assert.equal(result.unreviewedChunks, 1);
    assert.equal(calls.filter((call) => call.url === "https://ai.example/review").length, 3);
    assert.match(postedReviewBody(calls).body, /1 chunk not reviewed: diff exceeds the review budget/);
  } finally {
    restore();
  }
});

test("a failed chunk is reported in scope and does not fail the whole review", async () => {
  let chunkCalls = 0;
  const { calls, restore } = mockFetch({
    diff: fileDiff("a.js", 3) + fileDiff("b.js", 3),
    ai: (prompt) => {
      if (prompt.includes("final review adjudicator")) {
        throw new Error("adjudicator should not run for a single successful chunk");
      }
      chunkCalls += 1;
      if (chunkCalls === 1) {
        return new Response("boom", { status: 502 });
      }
      return { passed: true, summary: "ok", tags: [], findings: [], inlineComments: [] };
    },
  });

  try {
    const result = await processPullRequestReview({ ...BASE_ENV, AI_MAX_CHUNK_CHARS: "120" }, BASE_PAYLOAD);

    assert.equal(result.failedChunks, 1);
    assert.equal(result.passed, true);
    assert.match(postedReviewBody(calls).body, /1 chunk not reviewed: AI request failed/);
  } finally {
    restore();
  }
});

test("all chunks failing throws a retriable error and posts nothing", async () => {
  const { calls, restore } = mockFetch({ ai: () => new Response("down", { status: 503 }) });

  try {
    await assert.rejects(processPullRequestReview(BASE_ENV, BASE_PAYLOAD), (error) => {
      assert.equal(isRetriableError(error), true);
      return true;
    });
    assert.equal(reviewCalls(calls).length, 0);
    assert.deepEqual(reactionContents(calls), ["eyes", "confused"]);
  } finally {
    restore();
  }
});

test("AI timeouts are retriable and honour AI_TIMEOUT_MS", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (url.startsWith("https://ai.example/")) {
      assert.ok(options.signal instanceof AbortSignal, "AI request carries an abort signal");
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      });
    }
    if (url.endsWith("/pulls/12") && (options.headers?.Accept ?? "").includes("diff")) {
      return new Response(SIMPLE_DIFF, { status: 200 });
    }
    return Response.json({});
  };
  try {
    await assert.rejects(
      processPullRequestReview({ ...BASE_ENV, AI_TIMEOUT_MS: "20" }, BASE_PAYLOAD),
      (error) => {
        assert.equal(error.name, "TimeoutError");
        assert.equal(isRetriableError(error), true);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("AI 4xx errors are not retriable", async () => {
  const { restore } = mockFetch({ ai: () => new Response("bad key", { status: 401 }) });
  try {
    await assert.rejects(processPullRequestReview(BASE_ENV, BASE_PAYLOAD), (error) => {
      assert.equal(isRetriableError(error), false);
      return true;
    });
  } finally {
    restore();
  }
});

test("lockfile-only PR makes no AI call and posts nothing", async () => {
  const { calls, restore } = mockFetch({ diff: fileDiff("package-lock.json", 5) + fileDiff("node_modules/x/i.js") });

  try {
    const result = await processPullRequestReview(BASE_ENV, BASE_PAYLOAD);

    assert.deepEqual(result, {
      skipped: true,
      reason: "nothing-to-review",
      ignoredPaths: ["package-lock.json", "node_modules/x/i.js"],
    });
    assert.equal(calls.filter((call) => call.url === "https://ai.example/review").length, 0);
    assert.equal(reviewCalls(calls).length, 0);
    assert.deepEqual(reactionContents(calls), [], "no reaction when there is nothing to review");
  } finally {
    restore();
  }
});

test("stale head SHA skips the review before fetching the diff", async () => {
  const { calls, restore } = mockFetch({ pullJson: { head: { sha: "newer" } } });

  try {
    const result = await processReviewJob(BASE_ENV, { owner: "owner", repo: "repo", pullNumber: 12, headSha: "older" });

    assert.deepEqual(result, { skipped: true, reason: "stale-head" });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("REVIEW_STATE marker skips already reviewed heads and is written after posting", async () => {
  const store = new Map();
  const kv = {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value, options) => store.set(key, { value, options }),
  };
  const { calls, restore } = mockFetch({ pullJson: { head: { sha: "abc" } } });

  try {
    const job = { owner: "owner", repo: "repo", pullNumber: 12, headSha: "abc" };
    const first = await processReviewJob({ ...BASE_ENV, REVIEW_STATE: kv }, job);
    assert.equal(first.skipped, false);
    const marker = store.get("reviewed:owner/repo/12/abc");
    assert.ok(marker);
    assert.equal(marker.options.expirationTtl, 30 * 24 * 60 * 60);

    const aiCallsBefore = calls.filter((call) => call.url === "https://ai.example/review").length;
    const second = await processReviewJob({ ...BASE_ENV, REVIEW_STATE: kv }, job);
    assert.deepEqual(second, { skipped: true, reason: "already-reviewed" });
    assert.equal(calls.filter((call) => call.url === "https://ai.example/review").length, aiCallsBefore);
  } finally {
    restore();
  }
});

test("old bot reactions on the PR are removed before the new one is added", async () => {
  const { calls, restore } = mockFetch({
    reactions: [
      { id: 1, content: "-1", user: { login: "review-bot" } },
      { id: 2, content: "+1", user: { login: "someone-else" } },
      { id: 3, content: "heart", user: { login: "review-bot" } },
    ],
  });
  try {
    await processPullRequestReview(BASE_ENV, BASE_PAYLOAD);
    const deletes = calls.filter((call) => call.options.method === "DELETE" && call.url.includes("/reactions/"));
    assert.deepEqual([...new Set(deletes.map((call) => call.url.split("/").pop()))], ["1"], "only the bot's own review reaction is removed");
    assert.deepEqual(reactionContents(calls), ["eyes", "+1"]);
  } finally {
    restore();
  }
});

test("a later run updates the existing bot review in place and replaces inline comments", async () => {
  const { calls, restore } = mockFetch({
    existingReviews: [
      { id: 41, user: { login: "someone-else" }, body: "LGTM <!-- review-my-code:main -->" },
      { id: 42, user: { login: "review-bot" }, body: "## ❌ AI Review Needs Attention\n<!-- review-my-code:main -->" },
      { id: 43, user: { login: "review-bot" }, body: "Inline comments refreshed for `abc`." },
    ],
    existingInline: [
      { id: 7, user: { login: "review-bot" }, body: "old 🔴 <!-- review-my-code:inline -->" },
      { id: 8, user: { login: "review-bot" }, body: "a human-looking reply without marker" },
      { id: 9, user: { login: "someone-else" }, body: "mine <!-- review-my-code:inline -->" },
    ],
    ai: () => ({
      passed: true,
      summary: "✅ Mergeable",
      tags: [],
      findings: ["🟡 🧹 **Nit** — a.js:1 — meh"],
      inlineComments: [{ path: "a.js", line: 1, body: "🟡 🧹 meh" }],
    }),
  });
  try {
    const result = await processReviewJob(BASE_ENV, { owner: "owner", repo: "repo", pullNumber: 12, headSha: "abcdef0123" });
    assert.equal(result.updatedExistingReview, true);

    const put = calls.find((call) => call.options.method === "PUT");
    assert.match(put.url, /\/pulls\/12\/reviews\/42$/);
    assert.match(JSON.parse(put.options.body).body, /^## ✅ AI Review Passed/);

    const deleted = calls.filter((call) => call.options.method === "DELETE" && call.url.includes("/pulls/comments/"));
    assert.deepEqual(deleted.map((call) => call.url.split("/").pop()), ["7"], "only the bot's marked inline comments are deleted");

    const created = reviewCalls(calls);
    assert.equal(created.length, 1, "only the inline follow-up review is created");
    const followUp = JSON.parse(created[0].options.body);
    assert.match(followUp.body, /Inline comments refreshed for `abcdef0`/);
    assert.equal(followUp.comments.length, 1);
    assert.equal(followUp.commit_id, "abcdef0123");
  } finally {
    restore();
  }
});

test("a later run with no inline comments only updates the review body", async () => {
  const { calls, restore } = mockFetch({
    existingReviews: [{ id: 42, user: { login: "review-bot" }, body: "x <!-- review-my-code:main -->" }],
  });
  try {
    await processPullRequestReview(BASE_ENV, BASE_PAYLOAD);
    assert.equal(calls.filter((call) => call.options.method === "PUT").length, 1);
    assert.equal(reviewCalls(calls).length, 0);
  } finally {
    restore();
  }
});

test("inline comments rejected by GitHub fall back to a body-only review", async () => {
  let reviewPosts = 0;
  const originalFetch = global.fetch;
  const { calls, restore } = mockFetch({
    ai: () => ({
      passed: true,
      summary: "ok",
      tags: [],
      findings: ["🟡 🧹 **Nit** — a.js:1 — meh"],
      inlineComments: [{ path: "a.js", line: 1, body: "🟡 🧹 meh" }],
    }),
  });
  const mocked = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (url.includes("/pulls/12/reviews") && options.method === "POST") {
      reviewPosts += 1;
      calls.push({ url, options });
      return reviewPosts === 1 ? new Response("Unprocessable", { status: 422 }) : Response.json({ id: 1 });
    }
    return mocked(url, options);
  };
  try {
    const result = await processPullRequestReview(BASE_ENV, BASE_PAYLOAD);
    assert.equal(reviewPosts, 2);
    assert.equal(result.inlineCommentsCount, 0);
    const second = JSON.parse(reviewCalls(calls)[1].options.body);
    assert.deepEqual(second.comments, []);
    assert.match(second.body, /Nit/);
  } finally {
    restore();
    global.fetch = originalFetch;
  }
});

test("processPullRequestReview filters non-reviewable inline comment lines", async () => {
  const { calls, restore } = mockFetch({
    ai: () => ({
      passed: false,
      summary: "Needs fixes",
      tags: [],
      findings: ["Fix issue"],
      inlineComments: [{ path: "a.js", line: 999, body: "Out of diff" }],
    }),
  });

  try {
    await processPullRequestReview(BASE_ENV, BASE_PAYLOAD);
    const reviewBody = postedReviewBody(calls);
    assert.deepEqual(reviewBody.comments, [], "review is still posted, without the invalid inline comment");
    assert.match(reviewBody.body, /Fix issue/);
  } finally {
    restore();
  }
});

test("processPullRequestReview tolerates missing labels (422 and 404)", async () => {
  for (const status of [422, 404]) {
    const { restore } = mockFetch({ labelsStatus: status });
    try {
      const result = await processPullRequestReview(BASE_ENV, BASE_PAYLOAD);
      assert.equal(result.skipped, false);
      assert.equal(result.passed, true);
    } finally {
      restore();
    }
  }
});

// ---------------------------------------------------------------------------
// Worker entrypoints
// ---------------------------------------------------------------------------

function webhookRequest(body, headers = {}) {
  return new Request("https://bot.example/webhook", {
    method: "POST",
    headers: { "x-github-event": "pull_request", ...headers },
    body,
  });
}

test("worker rejects invalid configuration before doing any work", async () => {
  const { calls, restore } = mockFetch();
  try {
    const response = await worker.fetch(webhookRequest("{}"), { ...BASE_ENV, AI_PARAMS: "{oops" });
    assert.equal(response.status, 500);
    assert.match((await response.json()).message, /Invalid environment configuration: AI_PARAMS/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("worker rejects unsigned, malformed, and oversized requests without reading the payload", async () => {
  const { calls, restore } = mockFetch();
  try {
    const noSignature = await worker.fetch(webhookRequest("{}"), BASE_ENV);
    assert.equal(noSignature.status, 401);

    const badFormat = await worker.fetch(webhookRequest("{}", { "x-hub-signature-256": "sha1=abc" }), BASE_ENV);
    assert.equal(badFormat.status, 401);

    const wrongSecret = await worker.fetch(
      webhookRequest("{}", { "x-hub-signature-256": await hmacHeader("other", "{}") }),
      BASE_ENV,
    );
    assert.equal(wrongSecret.status, 401);

    const big = "x".repeat(3 * 1024 * 1024);
    const oversized = await worker.fetch(
      webhookRequest(big, { "x-hub-signature-256": await hmacHeader("secret", big) }),
      BASE_ENV,
    );
    assert.equal(oversized.status, 413, "size limit rejects even a correctly signed oversized body");

    const otherEvent = await worker.fetch(webhookRequest("{}", { "x-github-event": "push" }), BASE_ENV);
    assert.equal(otherEvent.status, 200);
    assert.equal((await otherEvent.json()).skipped, true);

    assert.equal(calls.length, 0, "no GitHub or AI request is made for rejected webhooks");
  } finally {
    restore();
  }
});

test("worker enqueues a signed pull_request delivery and answers 202 immediately", async () => {
  const sent = [];
  const body = JSON.stringify({ ...BASE_PAYLOAD, pull_request: { number: 12, draft: false, head: { sha: "abc" } } });
  const { calls, restore } = mockFetch();
  try {
    const response = await worker.fetch(
      webhookRequest(body, { "x-hub-signature-256": await hmacHeader("secret", body), "x-github-delivery": "d1" }),
      { ...BASE_ENV, REVIEW_QUEUE: { send: async (message) => sent.push(message) } },
    );

    assert.equal(response.status, 202);
    assert.equal((await response.json()).queued, true);
    assert.deepEqual(sent, [{ owner: "owner", repo: "repo", pullNumber: 12, headSha: "abc", action: "opened" }]);
    assert.equal(calls.length, 0, "the webhook handler itself never calls GitHub or the AI");
  } finally {
    restore();
  }
});

test("worker ignores drafts and unsupported actions after signature validation", async () => {
  const body = JSON.stringify({ ...BASE_PAYLOAD, action: "closed" });
  const sent = [];
  const response = await worker.fetch(
    webhookRequest(body, { "x-hub-signature-256": await hmacHeader("secret", body) }),
    { ...BASE_ENV, REVIEW_QUEUE: { send: async (message) => sent.push(message) } },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).skipped, true);
  assert.equal(sent.length, 0);
});

test("worker falls back to inline processing via waitUntil without a queue binding", async () => {
  const body = JSON.stringify(BASE_PAYLOAD);
  const { calls, restore } = mockFetch();
  const background = [];
  try {
    const response = await worker.fetch(
      webhookRequest(body, { "x-hub-signature-256": await hmacHeader("secret", body) }),
      BASE_ENV,
      { waitUntil: (promise) => background.push(promise) },
    );

    assert.equal(response.status, 202);
    assert.equal((await response.json()).inline, true);
    assert.equal(background.length, 1);
    await Promise.all(background);
    assert.equal(reviewCalls(calls).length, 1);
  } finally {
    restore();
  }
});

test("queue consumer acks successes, retries retriable failures, and drops permanent ones", async () => {
  const events = [];
  const makeMessage = (id, attempts = 1) => ({
    id,
    attempts,
    body: { owner: "owner", repo: "repo", pullNumber: 12, headSha: null },
    ack: () => events.push(`${id}:ack`),
    retry: (options) => events.push(`${id}:retry:${options.delaySeconds}`),
  });

  let mode = "ok";
  const { restore } = mockFetch({
    ai: () => {
      if (mode === "retriable") {
        return new Response("down", { status: 503 });
      }
      if (mode === "permanent") {
        return new Response("bad key", { status: 401 });
      }
      return { passed: true, summary: "ok", tags: [], findings: [], inlineComments: [] };
    },
  });

  try {
    await worker.queue({ messages: [makeMessage("m1")] }, BASE_ENV);
    mode = "retriable";
    await worker.queue({ messages: [makeMessage("m2", 2)] }, BASE_ENV);
    mode = "permanent";
    await worker.queue({ messages: [makeMessage("m3")] }, BASE_ENV);

    assert.deepEqual(events, ["m1:ack", "m2:retry:120", "m3:ack"]);
  } finally {
    restore();
  }
});
