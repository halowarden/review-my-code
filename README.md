# review-my-code

Cloudflare Worker GitHub bot for AI-powered pull request review.

## What it does

- Accepts GitHub `pull_request` webhook events at `POST /webhook`
- Verifies the `x-hub-signature-256` HMAC before reading anything else
- Enqueues a review job and answers GitHub with `202` within milliseconds
- Queue consumer: fetches the PR diff, drops lockfiles/vendored/generated/binary files,
  splits what is left at file and hunk boundaries, and sends it to the AI endpoint
- One chunk → one AI call and done. Several chunks → one call per chunk plus a final
  adjudication call that merges duplicates and derives the verdict
- Posts one PR review whose body is the summary (verdict, scope line, category table,
  collapsible findings linked to the diff, tags) and whose inline comments sit on lines
  that exist in the diff
- Keeps that single review per PR: later pushes update its body in place, delete the
  bot's previous inline comments, and attach refreshed inline comments to a short
  follow-up review (GitHub cannot add inline comments to an already submitted review)
- Reacts on the PR itself: 👀 while the review runs, then 👍/👎, or 😕 if it failed
- Applies `ai-reviewed` plus `ai-review:passed` or `ai-review:needs-fixes` and removes the
  opposite result label

## Cost model

Workers bill CPU time only; the minutes spent waiting for GitHub or the AI endpoint are
free. The expensive part is the AI endpoint, so the flow minimises AI calls:

| Situation | AI calls |
|---|---|
| Diff fits in one chunk (default 80k chars ≈ 20k tokens) | 1 |
| Diff needs N chunks | N + 1 (capped by `AI_MAX_CHUNKS`, default 8) |
| Lockfile-only / binary-only PR | 0 (nothing posted) |
| Webhook for a head SHA that already moved on | 0 |
| Redelivered or replayed webhook for a reviewed head (needs `REVIEW_STATE`) | 0 |
| Draft PR, unsupported action, bad signature | 0 |

Queues cost 3 operations per job (≈ $0.0000012); KV is one read and one write per review.

## Abuse protection

Every request that reaches the AI or GitHub has passed all of these, in order:

1. `POST /webhook` only; anything else is a static 404/405.
2. `x-github-event: pull_request` and a well-formed `sha256=<64 hex>` signature header,
   checked before the body is read.
3. Body limited to 2 MB (streamed, aborted early when exceeded).
4. HMAC-SHA256 over the raw body with `GITHUB_WEBHOOK_SECRET`, compared in constant time.
5. Only `opened`, `synchronize`, `reopened`, `ready_for_review` on non-draft PRs.
6. In the consumer: the PR head must still equal the webhook's head SHA, and the head must
   not already be marked as reviewed in `REVIEW_STATE`.

An unauthenticated caller can therefore only generate cheap `401` responses. To stop even
those from counting as requests, add a Cloudflare WAF rate-limiting rule or restrict the
route to GitHub's webhook IP ranges (`https://api.github.com/meta`, key `hooks`).

## Setup

```bash
npm install
npm test

npx wrangler queues create review-my-code-reviews
npx wrangler kv namespace create REVIEW_STATE      # optional; paste the id into wrangler.jsonc

npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put AI_API_URL
npx wrangler secret put AI_API_KEY

npm run deploy
```

Point the GitHub webhook at `https://<worker>/webhook`, content type `application/json`,
event `Pull requests`, with the same secret as `GITHUB_WEBHOOK_SECRET`.

Create the labels `ai-reviewed`, `ai-review:passed`, `ai-review:needs-fixes` in the
repository; missing labels are tolerated but then nothing is labelled.

## Environment

Secrets (required, `wrangler secret put`):

- `GITHUB_TOKEN` - token with permission to read PRs and write comments, reviews, labels
- `GITHUB_WEBHOOK_SECRET` - webhook signing secret
- `AI_API_URL` - AI endpoint. For the default OpenAI-compatible format this is the base
  URL (e.g. `https://host/compatible-mode/v1`); `/chat/completions` is appended automatically
- `AI_API_KEY` - bearer key for that endpoint

Optional AI request settings:

- `AI_API_FORMAT` - `openai` (default) or `prompt`
  - `openai`: `POST <url>/chat/completions` with `{model, messages:[system, user], ...AI_PARAMS}`;
    the review JSON is read from `choices[0].message.content`
  - `prompt`: `POST <url>` with `{model, prompt, ...AI_PARAMS}`; the response body is the review
    JSON, or `{ "output": "<json string>" }`
- `AI_MODEL` - sent as `model` (omitted when unset)
- `AI_PARAMS` - JSON object of extra request parameters merged into the body, for example
  `{"temperature":0.1,"max_tokens":8000,"response_format":{"type":"json_object"}}`.
  Must not contain `prompt`, `model`, or `messages`.

A ```` ```json ```` fence around the review JSON is tolerated in both formats.

Optional review tuning (`vars` in `wrangler.jsonc`):

- `AI_MAX_CHUNK_CHARS` - chunk budget in characters (default 80000)
- `AI_MAX_CHUNKS` - maximum chunks reviewed per PR (default 8); the rest is reported as
  not reviewed in the scope line
- `AI_CONCURRENCY` - parallel chunk requests (default 3)
- `AI_TIMEOUT_MS` - per-request timeout for the AI endpoint (default 240000); a timeout is retried by the queue
- `GITHUB_TIMEOUT_MS` - per-request timeout for the GitHub API (default 30000)
- `REVIEW_IGNORE_PATTERNS` - comma-separated globs added to the built-in ignore list, e.g.
  `generated/, **/*.gen.ts`

Bindings:

- `REVIEW_QUEUE` - queue producer/consumer. Without it the Worker falls back to
  `ctx.waitUntil`, which Cloudflare cuts off 30 s after the response, so long reviews can
  be lost. Use the queue in production.
- `REVIEW_STATE` - optional KV namespace remembering reviewed head SHAs for 30 days.

## Ignored by default

Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `Cargo.lock`,
`Gemfile.lock`, `poetry.lock`, `composer.lock`, `go.sum`, `*.lock`), `node_modules/`,
`vendor/`, `dist/`, `build/`, `out/`, `.next/`, `.nuxt/`, `.turbo/`, `.cache/`,
`coverage/`, `__snapshots__/`, `*.snap`, `*.min.js`, `*.min.css`, `*.map`, `*.pyc`,
fonts, images, and PDFs. Binary diffs, pure renames, and mode-only changes are skipped as
well. Skipped files are listed in the prompt and counted in the scope line.

## Review policy

Both prompts embed the condensed protocol from `src/reviewProtocol.js`: review behavior not
style, evidence over suspicion, a 🔴 blocking / 🟡 non-blocking / ⚪ do-not-report severity
model, High/Medium confidence only, nine categories (🐛 🔒 🧪 🧱 ⚡ 🔄 🛡️ 🔭 🧹), and a
one-line finding format `<severity> <category> **title** — path:line — impact and direction`.

- Chunk prompt: sees the full list of reviewed and skipped files, reviews only the visible
  chunk, marks cross-chunk concerns as Medium confidence, and emits inline comments only for
  added/context lines it can pin from the hunk header. In single-chunk mode it produces the
  final verdict directly.
- Final prompt: merges duplicates across chunks, drops findings refuted by other chunks,
  re-applies the quality gate, sorts by severity/category, reconciles inline comments with
  the surviving findings, and derives `passed` from the surviving blocking findings.
- Both carry a "known false positives" list (single-threaded JS is not a race, deployer
  config is trusted, test files in another chunk exist) learned from real runs.

## Failure handling

- AI or GitHub `5xx`/`429`/network errors are retried by the queue (2 retries, 1–2 min delay).
- `4xx` and unparseable model output are logged and dropped; the next push re-triggers a review.
- A single failed chunk does not fail the review: the scope line says which chunks were not
  reviewed. Only when every chunk fails is the job retried.
