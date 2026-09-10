import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMainComment,
  dedupeInlineComments,
  parseAIResponse,
  splitDiffIntoChunks,
} from "../src/reviewFlow.js";
import { processPullRequestReview } from "../src/index.js";

test("splitDiffIntoChunks splits large diffs into multiple chunks", () => {
  const diff = "a".repeat(30) + "\n" + "b".repeat(30) + "\n" + "c".repeat(30);
  const chunks = splitDiffIntoChunks(diff, 40);

  assert.equal(chunks.length, 3);
  assert.equal(chunks.join("\n"), diff);
});

test("dedupeInlineComments removes duplicates and invalid comments", () => {
  const input = [
    { path: "src/a.js", line: 10, body: "Fix this" },
    { path: "src/a.js", line: 10, body: "fix this " },
    { path: "src/a.js", line: 0, body: "Zero line allowed" },
    { path: "src/b.js", line: 2, body: "Nit" },
    { path: "", line: 2, body: "Missing path" },
  ];

  const result = dedupeInlineComments(input);
  assert.deepEqual(result, [
    { path: "src/a.js", line: 10, body: "Fix this" },
    { path: "src/a.js", line: 0, body: "Zero line allowed" },
    { path: "src/b.js", line: 2, body: "Nit" },
  ]);
});

test("parseAIResponse supports nested output JSON strings", () => {
  const parsed = parseAIResponse({
    output: JSON.stringify({
      passed: true,
      summary: "Looks good",
      tags: ["ai-review:passed"],
      inlineComments: [],
      findings: [],
    }),
  });

  assert.equal(parsed.passed, true);
  assert.equal(parsed.summary, "Looks good");
  assert.deepEqual(parsed.tags, ["ai-review:passed"]);
});

test("buildMainComment includes pass/fail heading and findings", () => {
  const passedComment = buildMainComment({ summary: "ok", findings: [], passed: true });
  const failedComment = buildMainComment({ summary: "needs fixes", findings: ["A"], passed: false });

  assert.match(passedComment, /AI Review Passed/);
  assert.match(failedComment, /AI Review Needs Attention/);
  assert.match(failedComment, /- A/);
});

test("processPullRequestReview posts inline review payload from AI comments", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.includes("/pulls/12") && options.method !== "POST") {
      return new Response("diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-console.log(1)\n+console.log(2)\n", { status: 200 });
    }
    if (url === "https://ai.example/review") {
      const request = JSON.parse(options.body);
      if (request.prompt.includes("final review adjudicator")) {
        return Response.json({
          passed: false,
          summary: "Needs fixes",
          tags: ["ai-review:needs-fixes"],
          findings: ["Fix issue"],
        });
      }
      return Response.json({
        passed: false,
        summary: "Chunk result",
        tags: ["ai-reviewed"],
        findings: ["Fix issue"],
        inlineComments: [{ path: "a.js", line: 1, body: "Use better value" }],
      });
    }
    if (url.includes("/issues/12/comments")) {
      return Response.json({ id: 99 });
    }
    return Response.json({});
  };

  try {
    const result = await processPullRequestReview(
      {
        GITHUB_TOKEN: "token",
        AI_API_URL: "https://ai.example/review",
        AI_API_KEY: "key",
      },
      {
        action: "opened",
        repository: { name: "repo", owner: { login: "owner" } },
        pull_request: { number: 12, draft: false },
      },
    );

    assert.equal(result.skipped, false);
    const reviewCall = calls.find((call) => call.url.includes("/pulls/12/reviews"));
    assert.ok(reviewCall);
    const reviewBody = JSON.parse(reviewCall.options.body);
    assert.equal(reviewBody.comments[0].path, "a.js");
    assert.equal(reviewBody.comments[0].line, 1);
    assert.equal(reviewBody.comments[0].side, "RIGHT");
  } finally {
    global.fetch = originalFetch;
  }
});
