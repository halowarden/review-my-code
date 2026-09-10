import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMainComment,
  dedupeInlineComments,
  parseAIResponse,
  splitDiffIntoChunks,
} from "../src/reviewFlow.js";

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
    { path: "src/b.js", line: 2, body: "Nit" },
    { path: "", line: 2, body: "Missing path" },
  ];

  const result = dedupeInlineComments(input);
  assert.deepEqual(result, [
    { path: "src/a.js", line: 10, body: "Fix this" },
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

