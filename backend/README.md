# TokenGuard Backend

## What is TokenGuard?

TokenGuard is a B2B micro-SaaS for auditing and controlling AI API usage. It
is designed to sit between a customer's application and AI providers such as
OpenAI and Anthropic:

```
Client Application → TokenGuard Proxy → OpenAI / Anthropic → Client Application
```

## What this backend service will eventually do

This service (`backend/`) is the TokenGuard AI API proxy. Over time it will:

- authenticate TokenGuard API keys and identify organizations
- forward AI API requests to OpenAI and Anthropic
- support streaming responses
- measure token usage and calculate costs
- detect agent loops
- enforce monthly budgets
- asynchronously persist usage logs
- expose usage data to a Next.js dashboard

## Current scope: Step 9 — async usage logging

Step 1 established the Fastify/TypeScript foundation. Step 2 added
Supabase auth, organizations, and TokenGuard API keys. Step 3 added the
`token_logs` persistence layer. Step 4 made TokenGuard forward real,
non-streaming requests to OpenAI and Anthropic (`POST /v1/chat/completions`,
`POST /v1/messages`) through provider adapters. Step 5 made every
completed proxy request produce a `token_logs` row with normalized usage
and a calculated cost. Step 6 added real, live streaming for both
endpoints. Step 7 added a lightweight anti-loop mechanism that blocks
rapid repetition of effectively identical requests before they become an
expensive API-cost problem. Step 8 added organization-level monthly
budget enforcement on top of `organizations.monthly_budget_usd` (Step 2).
Step 9 moves `token_logs` persistence off the client-facing request path
and onto a small internal queue/worker, without changing Step 8's budget
correctness.

- **Usage normalization** (`src/modules/providers/{openai,anthropic}-usage.ts`)
  maps each provider's own response shape to a common
  `{ inputTokens, outputTokens, totalTokens, source }`. `source` is
  `"provider"` when the AI provider reported the numbers, or `"unknown"`
  when it didn't — token fields are `null` in that case, never a fake `0`.
  (`"estimated"` — TokenGuard estimating tokens itself — is reserved in
  the type but not implemented; no tokenizer is wired up yet.) The same
  functions are reused, unchanged, by the streaming accumulators below.
- **Pricing engine** (`src/modules/pricing/`) is a small, in-memory,
  synchronous lookup — no Supabase query on the request path. See
  **Pricing** below.
- **Orchestration** (`src/modules/proxy/usage-recorder.ts`) ties the
  above together after the upstream response is in hand: normalize usage
  → look up pricing → calculate cost → call the existing
  `usageService.createUsageLog()` (Step 3) — no SQL in the routes, no
  duplicated persistence logic. A pricing or persistence failure is
  logged (never hidden) but never turns a successful AI response into a
  failed one.
- **Streaming** (`src/modules/streaming/`, `src/modules/proxy/streaming-proxy.ts`)
  relays a provider's SSE response to the client live, chunk by chunk, as
  it arrives — never buffering the full response first. See **Streaming**
  below.
- **Agent loop detection** (`src/modules/loop-detection/`,
  `src/modules/proxy/loop-guard.ts`) hashes a privacy-safe signature of
  each request and blocks it with `429` once it repeats too fast, before
  the provider is ever contacted. See **Agent loop detection** below.
- **Budget enforcement** (`src/modules/budget/`, `src/modules/proxy/budget-guard.ts`)
  blocks a request with `429` before contacting the provider once an
  organization's committed spend for the current UTC month has reached
  its `monthly_budget_usd`, and atomically accounts for each request's
  known cost afterward. See **Budget enforcement** below.
- **Async usage logging** (`src/modules/usage-logging/`) persists the
  `token_logs` audit row on a small in-process queue/worker instead of
  the request path — the client response no longer waits on it. Budget
  accounting (above) stays synchronous; only the audit row moved. See
  **Async usage logging** below.

## Pricing

`src/modules/pricing/pricing-table.ts` holds TokenGuard's own maintained
pricing **snapshot** — not a live feed from OpenAI or Anthropic. Every
entry carries a `pricingVersion`; a usage log persists whichever version
priced it, so updating this table later never rewrites a historical row's
cost (`token_logs.pricing_version`). Cost is computed with `decimal.js`,
never plain floating-point arithmetic:

```
inputCost  = inputTokens  / 1,000,000 × inputPricePerMillionUsd
outputCost = outputTokens / 1,000,000 × outputPricePerMillionUsd
totalCost  = inputCost + outputCost   (only when both halves are known)
```

A model with no pricing entry does **not** block the request — the proxy
still forwards it and records usage; `input_cost_usd`, `output_cost_usd`,
and `total_cost_usd` are simply `null` (and `pricing_version` is `null`)
for that row, never a fabricated price.

## Streaming

Both proxy endpoints support `"stream": true`. The response is relayed to
the client as it arrives from the provider — TokenGuard never buffers the
full response before forwarding.

- **Generic SSE parsing** (`src/modules/streaming/sse-parser.ts`) is a
  small incremental parser, independent of any provider, that handles
  `data:`/`event:`/`id:` fields split arbitrarily across network chunk
  boundaries (including mid-field). It only inspects a transient copy of
  each chunk to extract usage; the bytes forwarded to the client are the
  provider's own, unmodified.
- **OpenAI usage** is _not_ included by default in a streaming response —
  only if the client's own request body sets
  `stream_options: {"include_usage": true}` (TokenGuard forwards the
  body as-is and never adds this itself). If the stream ends without a
  usage-bearing chunk, the usage log is recorded with `usage_source:
"unknown"` and `null` token fields — never a fabricated `0`, and never
  a second request to the provider to "fetch" it afterward.
- **Anthropic usage** arrives across two event types: `message_start`
  carries the initial counts, and one or more `message_delta` events
  carry the running (cumulative) total — the last one before
  `message_stop` holds the final counts. If none of these ever arrive,
  usage is recorded as `unknown`, same as OpenAI.
- **Timeouts**: `PROVIDER_REQUEST_TIMEOUT_MS` still bounds how long
  TokenGuard waits for the provider to start responding. Once streaming
  begins, a separate `STREAM_MAX_DURATION_MS` bounds the total time the
  stream may stay open — a single chunk trickling in does not reset this
  timer, so a stalled stream can't stay open indefinitely.
- **Disconnects**: if the client goes away mid-stream, TokenGuard aborts
  the upstream request rather than letting the provider keep generating
  for nobody. If the provider disconnects mid-stream instead, TokenGuard
  ends the client's stream cleanly and records whatever usage had already
  arrived (or `unknown` if none had).
- A provider response that never becomes a stream at all (bad
  credentials, rate limit, malformed body — anything not
  `text/event-stream`) is relayed exactly like the non-streaming proxy
  path: status, body, and content-type preserved, one usage log with that
  status code.

## Agent loop detection

Both proxy endpoints are guarded by a lightweight, conservative anti-loop
check: rapid repetition of the _effectively identical_ request, from the
same organization and TokenGuard key, is blocked before it ever reaches
the provider. The goal is catching a runaway agent (a broken retry loop,
a tool call stuck repeating itself) before it turns into an API bill —
not rate-limiting normal traffic. Using the same model or endpoint
repeatedly is never, by itself, treated as a loop.

- **What counts as "repeated"**: a request is identified by a SHA-256
  signature over `{ organizationId, tokenGuardKeyId, provider, endpoint,
model, normalizedBody }`. The body is normalized (JSON keys sorted
  recursively, array order preserved) before hashing, so formatting
  differences like key order don't create a false miss — but any
  meaningfully different content (a different prompt, a different
  parameter) produces a different signature and is never conflated with
  a loop. Two different organizations or TokenGuard keys never share
  loop state, even for byte-identical bodies.
- **Thresholds** (`src/modules/loop-detection/configuration.ts`,
  overridable via env — see below): by default, up to 5 identical
  requests within a 10-second window are allowed; the 6th is treated as
  a loop and that exact signature is blocked for 30 seconds. Once the
  block expires, normal evaluation resumes from a clean count — a loop
  that stops looping is never punished forever.
- **In-memory, bounded, process-local** (`src/modules/loop-detection/loop-detector.ts`):
  a single `Map` keyed by signature, storing only
  `{ count, firstSeenAt, lastSeenAt, blockedUntil }` — never the request
  body, prompt, or anything derived from it beyond the hash itself.
  Bounded by `AGENT_LOOP_MAX_ENTRIES` (oldest entries evicted first once
  full); stale entries (outside the window, not currently blocked) are
  swept out periodically so the detector cannot leak memory over the
  life of the process. No Supabase query and no database table are
  involved — the check is a single synchronous in-memory operation, fast
  enough to sit directly in the request path.
- **Process-local — not distributed**: this state lives in one running
  Node.js process. Running multiple TokenGuard instances behind a load
  balancer means each instance counts independently; a loop whose
  requests happen to be spread across instances could exceed the
  configured threshold before any single instance blocks it. This step
  deliberately does not implement cross-instance/distributed loop
  detection.
- **Concurrency**: the check-and-record step is one synchronous function
  call with no `await` inside it, so Node.js can never interleave two
  concurrent requests for the same signature mid-check — there's no
  window for a burst of simultaneous identical requests to all read the
  same pre-increment count and all pass. No external locking is used or
  needed for this.
- **Blocked response**: `429` with
  `{"error":{"code":"AGENT_LOOP_DETECTED","message":"...","retryAfterSeconds":<n>}}`
  and a `Retry-After` header — never the request body, the signature, or
  any credential. The provider is never contacted for a blocked request,
  so it never produces a `token_logs` row (same as any other request
  that never reached the provider). A blocked event is logged as
  structured metadata only (request id, organization id, key id,
  provider, endpoint, model, error code) — never the request/response
  content or the signature itself.
- Applies identically to OpenAI and Anthropic, and to both streaming and
  non-streaming requests — one shared detector and one shared code path,
  not duplicated per provider.

Configuration (`.env.example`): `AGENT_LOOP_WINDOW_MS` (default `10000`),
`AGENT_LOOP_THRESHOLD` (default `5`), `AGENT_LOOP_BLOCK_DURATION_MS`
(default `30000`), `AGENT_LOOP_MAX_ENTRIES` (default `10000`).

## Budget enforcement

Both proxy endpoints enforce `organizations.monthly_budget_usd` (Step 2)
as a hard ceiling on known spend for the current **UTC calendar month**
— 2026-09-01T00:00:00.000Z through 2026-09-30T23:59:59.999Z is one
period, regardless of server-local timezone. No new configuration, no
new billing system, and no cron job: a month's spend is simply a fresh,
empty row the first time it's needed (`src/modules/budget/budget-period.ts`).

### Two phases, because provider cost is only known after the fact

- **Phase A — admission** (`src/modules/proxy/budget-guard.ts`, before
  any upstream contact): rejects with `429`/`MONTHLY_BUDGET_EXCEEDED` if
  the organization's already-committed spend for this period is `>=`
  its budget; otherwise the request proceeds. Works identically for
  OpenAI and Anthropic and for streaming and non-streaming requests — a
  streaming request is admitted or rejected _before_ the SSE connection
  to the provider is opened, never after.
- **Phase B — final accounting** (inside `src/modules/proxy/usage-recorder.ts`,
  reusing the exact Step 5 pipeline): once a request completes and its
  cost is known, that cost is atomically committed against the period.
  This step **always** commits the real cost, even if doing so pushes
  committed spend over budget — the request already reached the
  provider and really did cost that much; the _next_ request is what
  gets rejected by Phase A.

**This means TokenGuard cannot guarantee provider spend never exceeds
the configured budget.** Cost is only known after the provider responds,
so any requests already in flight when a budget is exhausted can still
complete and push spend past the limit. What Phase B does guarantee is
that every one of those completions is committed exactly once, and that
the next request sees the true, up-to-date total — never a stale or
partially-applied one.

### Known vs. unknown cost

Only usage with a known `token_logs.total_cost_usd` counts toward the
budget. A response with no pricing entry for its model still
completes normally (matching Step 5) — its cost stays `null`, is never
charged as `$0`, and a safe, metadata-only `BUDGET_COST_UNKNOWN` event
is logged (request id, organization id, key id, provider, model,
timestamp — never request/response content) so the blind spot is
observable rather than silent. A provider error response before usage
is known is never charged either — same rule, same reason.

### Concurrency and idempotency

- **Admission (Phase A)** is a read: two concurrent requests can both
  read "under budget" and both proceed, if neither's cost has been
  committed yet — see the guarantee above. This is a deliberate,
  documented limitation, not a bug.
- **Accounting (Phase B)** is where TokenGuard _can_ make a hard
  guarantee: the commit is one atomic SQL statement
  (`update ... set committed_cost_usd = committed_cost_usd + $amount`,
  see `commit_budget_charge` in the migration), so Postgres's own
  row-level locking serializes concurrent commits for the same
  organization/period — no update is ever lost to a lost-update race,
  regardless of how many requests commit at once. Application code never
  reads a value, adds to it in Node, and writes it back.
- **Idempotency**: a charge is keyed by `request_id` (the same value as
  `token_logs.request_id`) in a dedicated `organization_budget_charges`
  table with `request_id` as its primary key. Committing the same
  request's cost more than once (e.g. a retried accounting call) is a
  safe no-op after the first — the organization is never double-charged.

### Storage model

`organization_budget_periods` (one row per organization per UTC month,
primary key `(organization_id, period_start)`) holds the running
`committed_cost_usd` total — an O(1) lookup on the hot path, no
historical-row scanning. `organization_budget_charges` is the
idempotency ledger described above; its `request_id` column references
`token_logs.request_id`, so a charge can never exist without a
corresponding usage log. Neither table stores prompts, responses, raw
request bodies, or any credential — financial/accounting metadata only.
See `supabase/migrations/20260927000000_create_budget_ledger.sql`.

### Failure behavior

If the Phase A admission check itself fails (a database error), the
request is rejected with `503`/`BUDGET_CHECK_UNAVAILABLE` — TokenGuard
never treats "couldn't verify the budget" as "budget available" (fails
closed, never open). If Phase B accounting itself fails, the
client-facing response is unaffected (the AI response already
succeeded), but a distinct, high-severity structured log is emitted —
never silently swallowed — because committed spend is now
under-counted, which could let a later admission check wrongly allow a
request it should have blocked. See `BudgetAccountingFailedError` in
`usage-recorder.ts`. (As of Step 9, Phase B no longer depends on the
`token_logs` row existing first — see **Async usage logging** below for
why, and for how the two are now deliberately independent.)

## Async usage logging

Every proxy request still produces a `token_logs` audit row (Step 3/5) —
but as of Step 9, writing it is no longer something the client waits
for. `src/modules/usage-logging/` is a small, bounded, in-process
queue/worker that `src/modules/proxy/usage-recorder.ts` enqueues onto
instead of inserting directly.

### Why only this, and not budget accounting too

Step 8 introduced two post-request responsibilities with different
correctness requirements: the `token_logs` audit row (informational,
best-effort is acceptable) and the budget charge (enforcement-critical —
see **Budget enforcement** above). Only the first moved. The budget
charge still runs synchronously, still atomically, and is still awaited
before `recordProxyUsage()` returns — deferring it onto the same
best-effort queue as the audit log would let an organization's committed
spend silently drift out of sync with what a concurrent request's
admission check sees, which is exactly the race Step 8 was built to
prevent. Making this possible required removing the foreign key that
used to force the budget charge to wait for the `token_logs` row to
exist first (see `20260928000000_decouple_budget_charge_from_token_logs.sql`)
— the two writes are now fully independent operations with different
consistency guarantees, not two steps of one write.

|             | Synchronous / critical                                               | Asynchronous / non-critical                                                                                              |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| What        | Budget charge (Phase B, Step 8)                                      | `token_logs` audit row (Step 3/5)                                                                                        |
| When        | Awaited before `recordProxyUsage()` returns                          | Enqueued and forgotten                                                                                                   |
| On failure  | Thrown as `BudgetAccountingFailedError`, logged at CRITICAL severity | Retried, then logged and dropped — never thrown                                                                          |
| Consistency | Exact, atomic, immediately visible to the next admission check       | Best-effort; can lag, and in the worst case (queue full, or the process exiting before the worker drains) may never land |

### Queue and worker

- **Bounded, FIFO, in-process** (`usage-queue.ts`): a plain array capped
  at `USAGE_LOG_QUEUE_MAX_SIZE` (default 5,000) — `enqueue()` returns
  `false` once full rather than growing without limit; it never throws.
- **Worker** (`usage-worker.ts`): `USAGE_LOG_WORKER_CONCURRENCY` (default 4) concurrent lanes, each blocking on an async signal between items
  (no busy-polling, no timers when idle). A lane that fails one event
  classifies the error, retries transient failures with exponential
  backoff and jitter (up to 5 attempts, capped at a few seconds between
  tries — not environment-configurable, a stable internal policy), and
  gives up (logging the failure, never crashing) on a permanent error or
  once retries are exhausted. One bad event never stops the lane or
  affects any other queued event.
- **Idempotency**: reuses `token_logs.request_id`'s existing unique index
  (Step 3) rather than inventing a second mechanism — a worker retry, or
  a process-level duplicate enqueue of the exact same request, hits the
  same `DuplicateRequestIdError` either way and is treated as success,
  never a duplicate row.

### Queue full

Usage tracking is financially relevant, so a full queue is never a
silent drop: `enqueue()` returning `false` is logged internally as a
high-severity `USAGE_LOG_QUEUE_FULL` structured event (request id,
organization id, provider, model, queue size — never request/response
content) and the caller is told nothing failed, because nothing
client-visible did. There is no synchronous fallback write: falling back
to a blocking insert exactly when the queue is already saturated would
make an overloaded system worse, not better. If this happens, that one
request's audit row is lost; budget accounting for it is not affected
(already committed synchronously, before the enqueue is even attempted).

### Persistence failure and shutdown

A `token_logs` insert that fails is retried (as above) and, if still
failing, logged and dropped — the client already has its AI response,
and a lost audit row is never worth turning that into a failure now.
On `app.close()` (a real `SIGTERM`/`SIGINT`, or a test's own cleanup),
an `onClose` hook stops accepting new events, lets in-flight ones
finish, and waits for the queue to drain up to
`USAGE_LOG_SHUTDOWN_TIMEOUT_MS` (default 5s) before letting shutdown
continue — if the timeout elapses first, the remaining queued count is
logged (never the events' contents) and shutdown proceeds anyway, since
hanging forever is worse than losing a bounded, logged amount of
best-effort audit data.

### Limitations — read this before assuming more than it provides

This is an **in-process, in-memory queue**, not a durable or distributed
one. If the process crashes, is killed (`SIGKILL`), or loses power before
a queued event is persisted, that event is lost — there is no
write-ahead log or external broker backing it. Running multiple
TokenGuard instances means each has its own independent queue; there is
no cross-instance coordination. None of this affects budget enforcement
correctness (see the table above), only the completeness of the
`token_logs` audit trail. A future step could replace
`src/modules/usage-logging/usage-queue.ts` and `usage-worker.ts` with a
durable external queue (e.g. a Postgres-backed outbox table, or a
managed queue service) behind the same `UsageLoggingService` interface
— `usage-recorder.ts` and every proxy route would be unaffected, since
they only depend on that interface, never on the queue's own internal
implementation.

Configuration (`.env.example`): `USAGE_LOG_QUEUE_MAX_SIZE` (default
`5000`), `USAGE_LOG_WORKER_CONCURRENCY` (default `4`),
`USAGE_LOG_SHUTDOWN_TIMEOUT_MS` (default `5000`).

## Database

Core tables, created by `supabase/migrations/20260924120000_create_core_schema.sql`:

- **`organizations`** — `id`, `name`, `monthly_budget_usd` (numeric,
  defaults to 500.00), `created_at`, `updated_at`.
- **`organization_members`** — links a Supabase `auth.users` row to an
  organization with a `role` of `owner` or `member`. Unique on
  `(organization_id, user_id)`. `ON DELETE CASCADE` from both foreign
  keys, so removing an organization or a Supabase user cleans up
  membership rows automatically.
- **`token_guard_keys`** — `organization_id`, `key_prefix` (indexed,
  non-secret lookup value), `key_hash` (SHA-256 of the full key, never
  the plaintext), `name`, `created_at`, `revoked_at`. `ON DELETE CASCADE`
  from `organization_id`, so deleting an organization also deletes its
  keys. Revocation is a soft delete (`revoked_at` is set, the row is
  kept for audit history).
- **`token_logs`** (`supabase/migrations/20260925000000_create_token_logs.sql`,
  extended in `20260926000000_add_usage_source_and_pricing_version.sql`) —
  one row per completed proxy request: `provider`, `model_used`, nullable
  `prompt_tokens`/`completion_tokens`/`total_tokens` (`null`, never `0`,
  when unknown), nullable `input_cost_usd`/`output_cost_usd`/`total_cost_usd`
  (`numeric(14,8)`), `usage_source` (`provider` | `estimated` | `unknown`),
  `pricing_version`, `duration_ms`, `status_code`, and a unique `request_id`.
  Metadata only — no prompts, responses, or credentials.
- **`organization_budget_periods`** and **`organization_budget_charges`**
  (`supabase/migrations/20260927000000_create_budget_ledger.sql`, with
  `organization_budget_charges.request_id`'s foreign key to `token_logs`
  removed in `20260928000000_decouple_budget_charge_from_token_logs.sql`
  — see **Async usage logging** above for why) — the Step 8 budget
  ledger. See **Budget enforcement** above for the accounting model;
  both are financial/accounting metadata only.

Organization creation and owner-membership creation happen atomically
inside a single Postgres function (`create_organization_with_owner`,
`SECURITY DEFINER`), callable only by the service-role credential, so a
partial failure can never leave an ownerless organization.

**Row Level Security** is enabled on all three tables. Authenticated
Supabase users can only `SELECT` organizations/keys/memberships they
belong to. There are no `INSERT`/`UPDATE`/`DELETE` policies: all writes
currently go through the backend's service-role credential, which
bypasses RLS and enforces authorization in application code
(`organizationsService.requireRole`) instead. RLS here is defense in
depth for any future client that connects to Supabase directly.

## Two kinds of credentials — do not confuse them

- **Supabase access tokens** (`Authorization: Bearer <token>`) authenticate
  a human dashboard/API user. Verified via `authClient.auth.getUser()`.
- **TokenGuard API keys** (`tg_usr_live_...`, header `X-TokenGuard-Key`)
  authenticate a customer's proxy traffic. They identify which
  organization a proxy request belongs to — they never authenticate
  against OpenAI or Anthropic.

The AI proxy adds a **third**, distinct credential: the customer's own
**provider API key** (their OpenAI or Anthropic key), sent on the same
request as the `X-TokenGuard-Key`. TokenGuard uses it only in memory, for
the single upstream call, and:

- never persists it (not in Supabase, not in `token_logs`, nowhere)
- never logs it (not in request logs, not in error messages, not in stack
  traces)
- never returns it in any response

## AI proxy

Both endpoints require **two** headers: `X-TokenGuard-Key` (identifies the
organization within TokenGuard) and the provider's own credential header
(authenticates against that provider). A missing/invalid/revoked
`X-TokenGuard-Key` always returns the same generic `401` — the response
never reveals whether a key existed, was revoked, or was simply wrong.

### `POST /v1/chat/completions` (OpenAI-compatible)

```
X-TokenGuard-Key: tg_usr_live_...
Authorization: Bearer <your-openai-api-key>
Content-Type: application/json

{ "model": "gpt-4o", "messages": [{ "role": "user", "content": "Hello" }] }
```

The body is forwarded to `OPENAI_BASE_URL/v1/chat/completions` byte for
byte — TokenGuard does not parse and reconstruct it. The upstream status
code, body, and content-type are returned unmodified. Set `"stream": true`
in the body for a live SSE response — see **Streaming** above.

### `POST /v1/messages` (Anthropic)

```
X-TokenGuard-Key: tg_usr_live_...
x-api-key: <your-anthropic-api-key>
anthropic-version: 2023-06-01
Content-Type: application/json

{ "model": "claude-sonnet-5", "max_tokens": 100, "messages": [{ "role": "user", "content": "Hello" }] }
```

`anthropic-version` is forwarded when you send it; TokenGuard never
invents or defaults one on your behalf. The body is forwarded to
`ANTHROPIC_BASE_URL/v1/messages` byte for byte. Set `"stream": true` in
the body for a live SSE response — see **Streaming** above.

Every completed request (the provider actually responded, whether with
success or its own error status, streaming or not) eventually produces a
`token_logs` row keyed by the `request_id` returned in
`X-TokenGuard-Request-Id` — as of Step 9, that row is written
asynchronously (see **Async usage logging** above) and may not exist
yet at the instant the client receives its response, though it usually
lands within milliseconds. Requests that never reach the provider —
missing/invalid/revoked `X-TokenGuard-Key`, body too large, blocked by
loop detection (see **Agent loop detection** above), blocked by budget
enforcement, or rejected because the budget check itself failed (see
**Budget enforcement** above) — do **not** produce a usage log; there is
no "request" to record usage for.

### Not yet supported

- A request to the provider that times out (`PROVIDER_REQUEST_TIMEOUT_MS`)
  returns `504` / `UPSTREAM_TIMEOUT`; an unreachable provider returns
  `502` / `UPSTREAM_UNAVAILABLE`. Neither ever includes a credential, and
  neither produces a usage log (TokenGuard never learned what happened
  upstream, so there is nothing safe to record).

## Local setup

```bash
cd backend
pnpm install
cp .env.example .env
pnpm dev
```

The server starts on `http://localhost:3000` by default.

## Environment setup

Configuration is centralized in `src/config/env.ts` (loop-detection
variables specifically in `src/modules/loop-detection/configuration.ts`,
usage-logging variables in `src/modules/usage-logging/configuration.ts`)
and loaded from `.env` via `dotenv`. See `.env.example` for the currently
supported variables: `PORT`, `HOST`, `NODE_ENV`; the Supabase settings
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`); the
proxy/streaming settings (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
`PROVIDER_REQUEST_TIMEOUT_MS`, `STREAM_MAX_DURATION_MS`,
`MAX_PROXY_BODY_BYTES`); the loop-detection settings
(`AGENT_LOOP_WINDOW_MS`, `AGENT_LOOP_THRESHOLD`,
`AGENT_LOOP_BLOCK_DURATION_MS`, `AGENT_LOOP_MAX_ENTRIES`); and the
async-usage-logging settings (`USAGE_LOG_QUEUE_MAX_SIZE`,
`USAGE_LOG_WORKER_CONCURRENCY`, `USAGE_LOG_SHUTDOWN_TIMEOUT_MS`).
Without real Supabase values, the server falls back to
local-development placeholders that cannot authenticate against a real
project; in production, all three Supabase variables are required.
`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security and must never
reach a browser or be logged — see **Database** above. There is
deliberately no `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` variable: provider
credentials always come from the request, never from server config.

## Available commands

Run from the `backend/` directory:

| Command             | Description                                    |
| ------------------- | ---------------------------------------------- |
| `pnpm dev`          | Run the server in watch mode                   |
| `pnpm build`        | Compile TypeScript to `dist/`                  |
| `pnpm start`        | Run the compiled server from `dist/`           |
| `pnpm test`         | Run the test suite once                        |
| `pnpm test:watch`   | Run the test suite in watch mode               |
| `pnpm lint`         | Run ESLint                                     |
| `pnpm format`       | Format the codebase with Prettier              |
| `pnpm format:check` | Check formatting without writing changes       |
| `pnpm typecheck`    | Run the TypeScript compiler in check-only mode |

## Endpoints

### `GET /health`

Returns a small JSON payload indicating the service is running:

```json
{
  "status": "ok",
  "service": "tokenguard-proxy",
  "version": "0.1.0"
}
```

### `GET /v1/me`

Requires `Authorization: Bearer <supabase-access-token>`. Returns
`{ "id": "...", "email": "..." }` for the authenticated user.

### `POST /v1/organizations`

Requires Supabase authentication. Body: `{ "name": "..." }`. Creates an
organization and makes the caller its owner.

### `GET /v1/organizations`

Requires Supabase authentication. Returns only organizations the caller
belongs to.

### `POST /v1/organizations/:organizationId/keys`

Requires Supabase authentication and an `owner` role in that organization.
Body: `{ "name": "..." }`. Returns the new TokenGuard key's plaintext value
— this is the only time it is ever returned.

### `POST /v1/organizations/:organizationId/keys/:keyId/revoke`

Requires Supabase authentication and an `owner` role in that organization.
Revokes the key; a revoked key fails verification from then on.

### `POST /v1/chat/completions` and `POST /v1/messages`

The AI proxy — see **AI proxy** above.

## Not implemented yet

Advanced (distributed/cross-instance) rate limiting, alerts,
budget-edit endpoints/dashboard controls, and the dashboard itself are
**not implemented**. They will be addressed in later steps.
(Single-instance, in-memory agent loop detection, monthly budget
_enforcement_ — reading and accounting against the existing
`monthly_budget_usd` — and async, in-process usage-log persistence _are_
implemented; see **Agent loop detection**, **Budget enforcement**, and
**Async usage logging** above. None of them extend across multiple
TokenGuard instances — the loop detector and usage-logging queue are
both process-local, and there is no endpoint yet to change a budget. A
durable/distributed usage-logging queue is a documented future
direction, not implemented now.)
