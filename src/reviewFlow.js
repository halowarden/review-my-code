import { REVIEW_PRINCIPLES, REVIEW_PROTOCOL, SEVERITY_MODEL } from "./reviewProtocol.js";

// ~20k tokens of diff per AI call. Most PRs fit in a single chunk, which also
// skips the final adjudication call entirely.
export const DEFAULT_MAX_CHUNK_CHARS = 80_000;
// Hard cap on AI calls per PR. Anything beyond is reported as "not reviewed".
export const DEFAULT_MAX_CHUNKS = 8;
export const DEFAULT_AI_CONCURRENCY = 3;
export const MAX_FILE_LIST_ENTRIES = 200;

// Files that are never worth an AI call: lockfiles, vendored/generated output, caches.
export const DEFAULT_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.lock",
  "**/*.lockb",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/*.pyc",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.pdf",
];

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(glob) {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories; a trailing "**" matches everything.
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

export function parseIgnorePatterns(raw, defaults = DEFAULT_IGNORE_PATTERNS) {
  const extra =
    typeof raw === "string"
      ? raw
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  return [...defaults, ...extra];
}

export function shouldIgnorePath(path, patterns = DEFAULT_IGNORE_PATTERNS) {
  if (!path) {
    return false;
  }
  return patterns.some((pattern) => {
    // A bare directory name such as "generated/" means "anywhere in the tree".
    const normalized = pattern.endsWith("/") ? `**/${pattern}**` : pattern;
    return globToRegExp(normalized.startsWith("**/") || normalized.includes("/") ? normalized : `**/${normalized}`).test(
      path,
    );
  });
}

function stripDiffPrefix(rawPath) {
  const trimmed = rawPath.trim().replace(/^"(.*)"$/, "$1");
  if (trimmed === "/dev/null") {
    return null;
  }
  return trimmed.replace(/^[ab]\//, "");
}

export function extractFilePath(fileDiff) {
  const plus = fileDiff.match(/^\+\+\+ (.+)$/m);
  if (plus) {
    const path = stripDiffPrefix(plus[1]);
    if (path) {
      return path;
    }
  }
  const minus = fileDiff.match(/^--- (.+)$/m);
  if (minus) {
    const path = stripDiffPrefix(minus[1]);
    if (path) {
      return path;
    }
  }
  const header = fileDiff.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/m);
  return header ? header[2] : null;
}

export function splitDiffIntoFiles(diff) {
  if (!diff) {
    return [];
  }
  const files = [];
  const parts = diff.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    files.push({
      path: extractFilePath(part),
      text: part.replace(/\n$/, ""),
      hasHunks: /^@@ /m.test(part),
    });
  }
  return files;
}

/**
 * Drops files that are ignored by pattern or carry nothing reviewable
 * (binary changes, pure renames, mode-only changes).
 */
export function filterDiff(diff, ignorePatterns = DEFAULT_IGNORE_PATTERNS) {
  const files = splitDiffIntoFiles(diff);
  const kept = [];
  const ignoredPaths = [];
  const emptyPaths = [];

  for (const file of files) {
    const label = file.path ?? "(unknown path)";
    if (shouldIgnorePath(file.path, ignorePatterns)) {
      ignoredPaths.push(label);
      continue;
    }
    if (!file.hasHunks) {
      emptyPaths.push(label);
      continue;
    }
    kept.push(file);
  }

  return {
    diff: kept.map((file) => file.text).join("\n"),
    reviewedPaths: kept.map((file) => file.path ?? "(unknown path)"),
    ignoredPaths,
    emptyPaths,
  };
}

function splitTextByLines(text, maxChunkSize) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > maxChunkSize) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += maxChunkSize) {
        chunks.push(line.slice(i, i + maxChunkSize));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChunkSize && current) {
      chunks.push(current);
      current = line;
      continue;
    }
    current = candidate;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function splitFileByHunks(fileText, maxChunkSize) {
  const hunkStart = fileText.search(/^@@ /m);
  if (hunkStart === -1) {
    return splitTextByLines(fileText, maxChunkSize);
  }
  const header = fileText.slice(0, hunkStart).replace(/\n$/, "");
  const hunks = fileText.slice(hunkStart).split(/^(?=@@ )/m);
  const chunks = [];
  let current = header;
  let currentHasHunk = false;

  for (const hunk of hunks) {
    const piece = hunk.replace(/\n$/, "");
    const candidate = `${current}\n${piece}`;
    if (candidate.length <= maxChunkSize) {
      current = candidate;
      currentHasHunk = true;
      continue;
    }
    if (currentHasHunk) {
      chunks.push(current);
      current = header;
      currentHasHunk = false;
    }
    if (`${header}\n${piece}`.length <= maxChunkSize) {
      current = `${header}\n${piece}`;
      currentHasHunk = true;
      continue;
    }
    // A single hunk larger than the budget: last resort, split by lines and
    // prefix each piece with the file header so the model still knows the path.
    for (const part of splitTextByLines(piece, Math.max(1, maxChunkSize - header.length - 1))) {
      chunks.push(`${header}\n${part}`);
    }
  }
  if (currentHasHunk) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Packs whole files into chunks. A file that does not fit is split at hunk
 * boundaries; a hunk that does not fit is split by lines. Plain text without
 * "diff --git" headers falls back to line splitting.
 */
export function splitDiffIntoChunks(diff, maxChunkSize = DEFAULT_MAX_CHUNK_CHARS) {
  if (!diff) {
    return [];
  }
  if (diff.length <= maxChunkSize) {
    return [diff];
  }

  const files = splitDiffIntoFiles(diff);
  if (files.length === 1 && !/^diff --git /m.test(diff)) {
    return splitTextByLines(diff, maxChunkSize);
  }

  const chunks = [];
  let current = "";
  for (const file of files) {
    if (file.text.length > maxChunkSize) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitFileByHunks(file.text, maxChunkSize));
      continue;
    }
    const candidate = current ? `${current}\n${file.text}` : file.text;
    if (candidate.length > maxChunkSize && current) {
      chunks.push(current);
      current = file.text;
      continue;
    }
    current = candidate;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export function readPositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received "${raw}"`);
  }
  return value;
}

export function resolveReviewSettings(env = {}) {
  return {
    maxChunkChars: readPositiveInt(env.AI_MAX_CHUNK_CHARS, DEFAULT_MAX_CHUNK_CHARS),
    maxChunks: readPositiveInt(env.AI_MAX_CHUNKS, DEFAULT_MAX_CHUNKS),
    concurrency: readPositiveInt(env.AI_CONCURRENCY, DEFAULT_AI_CONCURRENCY),
    ignorePatterns: parseIgnorePatterns(env.REVIEW_IGNORE_PATTERNS),
  };
}

export function dedupeInlineComments(inlineComments = []) {
  const unique = [];
  const seen = new Set();

  for (const comment of inlineComments) {
    const lineNumber = Number(comment?.line);
    const key = [comment?.path ?? "", lineNumber, (comment?.body ?? "").trim().toLowerCase()].join("|");

    if (
      !comment?.path ||
      !Number.isInteger(lineNumber) ||
      lineNumber <= 0 ||
      !comment?.body ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    unique.push({ ...comment, line: lineNumber });
  }

  return unique;
}

function stripJsonFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

function normalizeAIJson(payload) {
  if (typeof payload === "string") {
    return JSON.parse(stripJsonFences(payload));
  }
  if (payload && typeof payload === "object" && typeof payload.output === "string") {
    return JSON.parse(stripJsonFences(payload.output));
  }
  return payload;
}

export function parseAIResponse(payload) {
  const parsed = normalizeAIJson(payload);
  return {
    passed: Boolean(parsed?.passed),
    summary: typeof parsed?.summary === "string" && parsed.summary.trim() ? parsed.summary : "AI review completed.",
    tags: Array.isArray(parsed?.tags) ? parsed.tags.filter((tag) => typeof tag === "string" && tag.trim()) : [],
    inlineComments: Array.isArray(parsed?.inlineComments) ? parsed.inlineComments : [],
    findings: Array.isArray(parsed?.findings) ? parsed.findings.filter((item) => typeof item === "string" && item.trim()) : [],
  };
}

export function parseAIParams(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return {};
  }
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("AI_PARAMS must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI_PARAMS must be a JSON object");
  }
  for (const reserved of ["prompt", "model", "messages"]) {
    if (reserved in parsed) {
      throw new Error(`AI_PARAMS must not set "${reserved}"`);
    }
  }
  return parsed;
}

// "openai": POST {model, messages} to <AI_API_URL>/chat/completions, read choices[0].message.content.
// "prompt": POST {model, prompt} to AI_API_URL, read the body as the review JSON.
export const AI_API_FORMATS = ["openai", "prompt"];
export const DEFAULT_AI_API_FORMAT = "openai";

export function resolveAIFormat(raw) {
  const format = typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : DEFAULT_AI_API_FORMAT;
  if (!AI_API_FORMATS.includes(format)) {
    throw new Error(`AI_API_FORMAT must be one of ${AI_API_FORMATS.join(", ")}, received "${raw}"`);
  }
  return format;
}

const REVIEW_SYSTEM_MESSAGE =
  "You are a senior code reviewer. Follow the review policy in the user message exactly and answer with strict JSON only.";

export function buildAIRequestBody(env, prompt) {
  const body = { ...parseAIParams(env.AI_PARAMS) };
  const model = typeof env.AI_MODEL === "string" ? env.AI_MODEL.trim() : "";
  if (model) {
    body.model = model;
  }
  if (resolveAIFormat(env.AI_API_FORMAT) === "openai") {
    body.messages = [
      { role: "system", content: REVIEW_SYSTEM_MESSAGE },
      { role: "user", content: prompt },
    ];
  } else {
    body.prompt = prompt;
  }
  return body;
}

/**
 * Resolves the URL to POST to. For the OpenAI format AI_API_URL may be either the
 * base URL (".../v1") or the full ".../chat/completions" endpoint.
 */
export function resolveAIRequestUrl(env) {
  const url = String(env.AI_API_URL ?? "").trim().replace(/\/+$/, "");
  if (resolveAIFormat(env.AI_API_FORMAT) === "openai" && !url.endsWith("/chat/completions")) {
    return `${url}/chat/completions`;
  }
  return url;
}

/** Unwraps the provider envelope into the review JSON (string or object). */
export function extractAIOutput(payload, format = DEFAULT_AI_API_FORMAT) {
  if (format === "openai") {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("OpenAI-compatible response has no choices[0].message.content");
    }
    return content;
  }
  return payload;
}

function formatFileList(paths = []) {
  if (!paths.length) {
    return "(file list unavailable)";
  }
  const shown = paths.slice(0, MAX_FILE_LIST_ENTRIES).map((path) => `- ${path}`);
  if (paths.length > MAX_FILE_LIST_ENTRIES) {
    shown.push(`- … and ${paths.length - MAX_FILE_LIST_ENTRIES} more`);
  }
  return shown.join("\n");
}

export function createChunkPrompt({
  owner,
  repo,
  pullNumber,
  chunkIndex,
  totalChunks,
  diffChunk,
  reviewedPaths = [],
  ignoredPaths = [],
}) {
  const chunkLabel = `${chunkIndex + 1}/${totalChunks}`;
  const singleChunk = totalChunks === 1;
  const chunkContext = singleChunk
    ? `## Scope
You are looking at the complete reviewable diff of this pull request in one piece. Files listed under "Skipped" were excluded on purpose (lockfiles, vendored or generated output, binaries); do not ask for them.`
    : `## Chunk context
You are looking at diff chunk ${chunkLabel}. Chunks are split at file and hunk boundaries. Other chunks are reviewed separately and a final adjudicator merges every chunk's findings, so:
- review ONLY what is visible in this chunk; do not guess about code you cannot see;
- the full list of reviewed files is below — if a test, caller, or schema you need lives in a file that is not in this chunk, say so explicitly in the finding and treat it as Medium confidence at most;
- report missing tests only when this chunk contains substantial new behavior and no test file for it appears anywhere in the reviewed file list, and phrase it as "no tests found for <behavior>";
- a very large hunk may be cut across chunks; never report syntax errors or incompleteness caused by the cut;
- do not repeat a finding for every occurrence of the same root cause; report it once at the clearest location.`;

  return `You are an expert code-review agent reviewing pull request ${owner}/${repo}#${pullNumber}.
Your goal is to find real defects, security risks, behavioral regressions, and missing validation while producing as little noise as possible. A review with zero findings is a valid and common outcome.

${chunkContext}

## Reviewed files in this PR (all chunks)
${formatFileList(reviewedPaths)}

## Skipped (not reviewed by policy)
${ignoredPaths.length ? formatFileList(ignoredPaths) : "- none"}

${REVIEW_PROTOCOL}

## Output
Return strict JSON only. No markdown fences, no prose before or after the object.
{
  "passed": boolean,
  "summary": "string",
  "tags": ["string"],
  "findings": ["string"],
  "inlineComments": [{"path": "file/path.ext", "line": 123, "body": "string"}]
}

Field rules:
- passed: true unless at least one 🔴 blocking finding exists${singleChunk ? "" : " in this chunk"}.
- summary: ${
    singleChunk
      ? 'the verdict line ("⛔ Needs rework", "⚠️ Mergeable with follow-ups", or "✅ Mergeable"), then one or two sentences of recommendation — what must be fixed before merge, or which follow-ups to open. Do not repeat every finding.'
      : 'one or two sentences — what this chunk changes and the worst issue found, or "No issues found in this chunk."'
  }
- tags: at most three short area tags such as "security", "tests", "compat", "reliability"; [] when clean.
- findings: one formatted finding line per issue (see Finding format), 🔴 before 🟡; [] when clean.
- inlineComments: at most one per finding, only for findings that map to a specific line:
  - path is repository-relative, exactly as it appears after "+++ b/" in the diff;
  - line is the NEW-file line number of an added (+) or context line inside a hunk, computed from the "@@ -a,b +c,d @@" header; never a removed (-) line and never a line outside the hunks;
  - body starts with the same severity and category emoji as the finding and explains the impact and fix direction; do not restate the code;
  - if you cannot pin the line confidently, keep the finding in "findings" and omit the inline comment;
  - [] when there are no findings.

Diff${singleChunk ? "" : ` chunk ${chunkLabel}`}:
${diffChunk}`;
}

export function createFinalDecisionPrompt({ owner, repo, pullNumber, chunkFindings, totalChunks, reviewedChunks }) {
  const chunkCount = Number.isInteger(totalChunks) && totalChunks > 0 ? totalChunks : "several";
  const reviewedCount = Number.isInteger(reviewedChunks) && reviewedChunks > 0 ? reviewedChunks : chunkCount;
  return `You are the final review adjudicator for pull request ${owner}/${repo}#${pullNumber}.
The diff was split into ${chunkCount} chunks and ${reviewedCount} of them were reviewed independently under the policy below. You receive every chunk-level finding and must produce the single authoritative verdict. You do not have access to the diff itself.

${REVIEW_PRINCIPLES}

${SEVERITY_MODEL}

## Adjudication rules
1. Merge duplicates. The same defect reported by several chunks (same path and line, or the same root cause) becomes ONE finding; keep the most precise location and the strongest explanation.
2. Resolve contradictions. If one chunk reports "no tests found" and another chunk's findings show the tests exist, drop the test finding. Never keep a finding that another chunk's evidence refutes.
3. Re-apply the quality gate and severity rules to every surviving finding. Downgrade or drop findings that are speculative, style-only, or lack a concrete failure mode. Upgrade severity only when combining chunks reveals a larger impact than any single chunk could see.
4. Do not invent findings and do not add details that are not supported by the chunk findings.
5. Keep the finding line format: severity emoji, category emoji, bold title, path:line, impact and direction.
6. Sort findings: 🔴 before 🟡; then 🔒 🐛 🛡️ 🔄 before 🧪 🧱 ⚡ 🔭 🧹; then by path.

## Verdict
passed is true only when no 🔴 blocking finding survives adjudication.
Verdict line: "⛔ Needs rework" when any blocking finding survives; "⚠️ Mergeable with follow-ups" when only non-blocking findings survive; "✅ Mergeable" when nothing survives.

## Output
Return strict JSON only. No markdown fences, no prose before or after the object.
{
  "passed": boolean,
  "summary": "string",
  "tags": ["string"],
  "findings": ["string"]
}

Field rules:
- summary: the verdict line, then one or two sentences of recommendation — what must be fixed before merge, or which follow-ups to open. Do not repeat every finding.
- tags: at most three short area tags aggregated from the findings; [] when nothing survives.
- findings: the deduplicated, sorted finding lines; [] when nothing survives.

Chunk findings (JSON array of strings, in chunk order):
${JSON.stringify(chunkFindings)}`;
}

export function buildScopeLine({ reviewedPaths = [], ignoredPaths = [], emptyPaths = [], totalChunks = 1, failedChunks = 0, unreviewedChunks = 0 }) {
  const parts = [`Reviewed: ${reviewedPaths.length} file${reviewedPaths.length === 1 ? "" : "s"}`];
  if (totalChunks > 1) {
    parts[0] += ` in ${totalChunks} chunks`;
  }
  const skipped = ignoredPaths.length + emptyPaths.length;
  if (skipped) {
    parts.push(`skipped ${skipped} (lockfiles, generated, binary, or no content changes)`);
  }
  if (unreviewedChunks) {
    parts.push(`⚠️ ${unreviewedChunks} chunk${unreviewedChunks === 1 ? "" : "s"} not reviewed: diff exceeds the review budget`);
  }
  if (failedChunks) {
    parts.push(`⚠️ ${failedChunks} chunk${failedChunks === 1 ? "" : "s"} not reviewed: AI request failed`);
  }
  return parts.join(" — ");
}

export function buildMainComment({ summary, findings, passed, scope, tags = [] }) {
  const emoji = passed ? "✅" : "❌";
  const heading = `${emoji} AI Review ${passed ? "Passed" : "Needs Attention"}`;
  const findingsBlock =
    findings.length === 0 ? "- No actionable issues found." : findings.map((item) => `- ${item}`).join("\n");
  const sections = [heading];
  if (scope) {
    sections.push(`_${scope}_`);
  }
  sections.push(summary, `**Findings**\n${findingsBlock}`);
  if (tags.length) {
    sections.push(`Tags: ${tags.map((tag) => `\`${tag}\``).join(", ")}`);
  }
  return sections.join("\n\n");
}
