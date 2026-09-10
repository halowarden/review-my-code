const MAX_DIFF_CHUNK_SIZE = 12000;

export function splitDiffIntoChunks(diff, maxChunkSize = MAX_DIFF_CHUNK_SIZE) {
  if (!diff || diff.length <= maxChunkSize) {
    return diff ? [diff] : [];
  }

  const chunks = [];
  let currentChunk = "";
  const lines = diff.split("\n");

  for (const line of lines) {
    const candidate = currentChunk ? `${currentChunk}\n${line}` : line;
    if (candidate.length > maxChunkSize && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = line;
      continue;
    }
    currentChunk = candidate;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export function dedupeInlineComments(inlineComments = []) {
  const unique = [];
  const seen = new Set();

  for (const comment of inlineComments) {
    const key = [
      comment?.path ?? "",
      comment?.line ?? "",
      (comment?.body ?? "").trim().toLowerCase(),
    ].join("|");

    if (
      !comment?.path ||
      comment?.line === undefined ||
      comment?.line === null ||
      Number.isNaN(Number(comment?.line)) ||
      !comment?.body ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    unique.push(comment);
  }

  return unique;
}

function normalizeAIJson(payload) {
  if (typeof payload === "string") {
    return JSON.parse(payload);
  }
  if (payload && typeof payload === "object" && typeof payload.output === "string") {
    return JSON.parse(payload.output);
  }
  return payload;
}

export function parseAIResponse(payload) {
  const parsed = normalizeAIJson(payload);
  return {
    passed: Boolean(parsed?.passed),
    summary: parsed?.summary ?? "AI review completed.",
    tags: Array.isArray(parsed?.tags) ? parsed.tags : [],
    inlineComments: Array.isArray(parsed?.inlineComments) ? parsed.inlineComments : [],
    findings: Array.isArray(parsed?.findings) ? parsed.findings : [],
  };
}

export function createChunkPrompt({ owner, repo, pullNumber, chunkIndex, totalChunks, diffChunk }) {
  return `You are an expert code-review agent. Review pull request ${owner}/${repo}#${pullNumber}.

Return strict JSON only with this schema:
{
  "passed": boolean,
  "summary": "string",
  "tags": ["string"],
  "findings": ["string"],
  "inlineComments": [
    {"path":"file/path.ext","line":123,"body":"actionable comment"}
  ]
}

Rules:
- Focus on correctness, security, data leaks, and broken behavior.
- Keep inline comments precise and non-duplicative.
- Use only files/lines visible in this diff chunk.
- If no issues, inlineComments must be [].
- Add tags indicating result quality, such as "ai-review:passed" or "ai-review:needs-fixes".

Chunk ${chunkIndex + 1}/${totalChunks} diff:
${diffChunk}`;
}

export function createFinalDecisionPrompt({ owner, repo, pullNumber, chunkFindings }) {
  return `You are a final review adjudicator for PR ${owner}/${repo}#${pullNumber}.
Given chunk-level findings from an earlier split diff review, remove duplicates and decide final status.

Return strict JSON only:
{
  "passed": boolean,
  "summary": "string",
  "tags": ["string"],
  "findings": ["string"]
}

Chunk findings:
${JSON.stringify(chunkFindings)}`;
}

export function buildMainComment({ summary, findings, passed }) {
  const emoji = passed ? "✅" : "❌";
  const heading = `${emoji} AI Review ${passed ? "Passed" : "Needs Attention"}`;
  const findingsBlock =
    findings.length === 0 ? "- No actionable issues found." : findings.map((item) => `- ${item}`).join("\n");
  return `${heading}

${summary}

**Findings**
${findingsBlock}`;
}
