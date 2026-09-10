// Condensed review policy shared by the chunk prompt and the final adjudicator prompt.
// Kept deliberately compact: every chunk prompt carries it alongside up to ~12k chars of diff.

export const REVIEW_PRINCIPLES = `## Review principles
1. Review behavior, not formatting. Never comment on style, quotes, semicolons, import order, line wrapping, or anything a linter/formatter enforces.
2. Evidence over suspicion. Every finding needs a concrete trigger (input, state, execution order, deployment condition) and an observable bad result. "This could maybe fail" is not a finding.
3. Trace data and control flow: callers, callees, types, validation, error handling, state lifecycle, side effects, persistence, concurrency.
4. Review deleted behavior as carefully as added behavior. Removed validation, guards, authorization, tests, cleanup, logging, or fallback paths are regressions.
5. Consider backwards compatibility. Old clients, stored data, jobs, env vars, event consumers, and external integrations may outlive the code being changed.
6. Never claim a command, test suite, lint, build, typecheck, or migration passed. You cannot execute anything.
7. Prefer few real findings over many weak ones. One production bug outweighs twenty nits.`;

export const SEVERITY_MODEL = `## Severity
🔴 Blocking — the PR must not merge as-is: behavior-breaking bug; data loss or corruption; exploitable security issue; broken authorization boundary; crash, hang, or deadlock; broken API/schema compatibility with active consumers; unsafe migration; substantial new behavior with effectively zero meaningful test coverage; severe reliability issue likely in normal operation.
🟡 Non-blocking — real, but does not stop the merge: edge-case correctness gap; incomplete tests around otherwise-tested behavior; limited-impact performance issue; maintainability hazard; misleading naming with real comprehension cost; duplicated logic likely to drift; weak observability; cleanup worth tracking.
⚪ Do not report: style or formatting; subjective naming; theoretical micro-optimizations; speculative concerns with no concrete failure mode; obvious deliberate tradeoffs without evidence of harm; defensive checks that existing invariants already guarantee; compile-time-impossible null/undefined; problems in unchanged code unless this change makes them worse.

## Confidence
High — failure follows directly from the code or contracts. Medium — strong evidence, but depends on a repository or runtime assumption. Low — speculative or missing context. Report only High and Medium findings; never post Low-confidence guesses.

## Categories (exactly one per finding)
🐛 Correctness · 🔒 Security · 🧪 Tests · 🧱 Architecture · ⚡ Performance · 🔄 Compatibility · 🛡️ Reliability · 🔭 Observability · 🧹 Maintainability

## Finding quality gate
Before reporting, answer: (1) what exact input, state, or execution path triggers it; (2) what observable bad result occurs; (3) is it caused or worsened by this change; (4) would the author act on it. If any answer is weak, drop the finding.

## Finding format
Each finding is ONE line:
<severity emoji> <category emoji> **<short title>** — <path>:<line> — <trigger and observable impact, then a concise recommended direction>
Good: 🔴 🐛 **Pagination skips records** — apps/api/src/users.ts:84 — the next cursor is computed from the filtered list, so removed rows make the following page jump past valid records; compute the cursor from the source rows.
Good: 🟡 🧹 **\`timeout\` hides its unit** — packages/client/src/retry.ts:18 — the value is milliseconds but call sites cannot see that, so a seconds value silently yields a 1000× shorter timeout; rename to \`timeoutMs\`.
Bad: "This pagination code looks suspicious." / "Maybe rename timeout."`;

export const REVIEW_CHECKLISTS = `## What to check
Correctness: inverted or missing branches; && vs ||; off-by-one and boundary inclusivity; wrong identifier, key, or property; copy/paste errors; 0/""/false/null/undefined/NaN conflation; missing await; unhandled rejection; Promise.all where failure isolation is required; races and stale async results overwriting newer state; mutation where immutability is expected; dropped or renamed fields across wire → validation → model → persistence → response; O(n²) over potentially large inputs; comparator or sort mistakes; seconds vs milliseconds; money as floating point; divide-by-zero; empty, null, duplicate, whitespace-only, Unicode, and oversized inputs; duplicate requests or submissions.
Security: missing authentication or authorization at the trusted boundary; client-supplied owner/tenant/user IDs trusted; untrusted values reaching SQL, shell, HTML, URLs, file paths, regex, headers, redirects, or logs; missing or weakened webhook/signature validation; secrets or tokens committed, logged, or returned in responses; unchecked JSON.parse or type assertions on untrusted data; prototype pollution; SSRF; ReDoS; sensitive data in errors or client payloads.
Reliability: swallowed exceptions; catch that turns failure into success; user sees success before the operation completes; non-idempotent operations retried; retries without limit or backoff; duplicate side effects on webhook, job, or event redelivery; partial completion of multi-step writes with no compensation; check-then-act and read-modify-write races; missing timeouts on external calls; leaked timers, listeners, sockets, or streams; unbounded growth of caches, arrays, queues, or logs.
Compatibility: changed routes, methods, status codes, request/response shapes, enums, nullability, or defaults still used by old clients; renamed or newly required env vars and config without a rollout path; destructive or irreversible migrations; rename implemented as drop+add; event names or payload fields with live consumers.
Tests: new substantial behavior without meaningful tests; tests that only assert "does not throw"; assertions too broad to fail on regression; mocked function is the behavior under test; fixtures that no longer match the real wire shape; stale tests for deleted behavior; bug fix without a test that would fail before the fix.
Architecture and maintainability: business rules duplicated across modules and likely to drift; shared utilities becoming dumping grounds; boolean-flag APIs that allow invalid state combinations; functions mixing validation, persistence, notification, and formatting; names that contradict behavior or hide units; abstractions with one caller and complex configuration.
Observability: silent critical failures; errors logged without request, job, or resource identifiers; the same error logged at multiple layers; sensitive values logged; unbounded payloads dumped to logs.

## Heuristics — ask for every non-trivial change
What happens if this runs twice? Out of order? Fails halfway? With old data or old clients? With an empty result? At the boundary (first/last page, min/max, exact expiration)? Who controls this value, and is it trusted merely because a type says so? Can this run concurrently? Can this grow without bound?`;

export const REVIEW_PROTOCOL = [REVIEW_PRINCIPLES, SEVERITY_MODEL, REVIEW_CHECKLISTS].join("\n\n");
