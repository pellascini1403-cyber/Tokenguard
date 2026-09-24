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

## Current scope: Step 5 — token tracking + cost calculation

Step 1 established the Fastify/TypeScript foundation. Step 2 added
Supabase auth, organizations, and TokenGuard API keys. Step 3 added the
`token_logs` persistence layer. Step 4 made TokenGuard forward real,
non-streaming requests to OpenAI and Anthropic (`POST /v1/chat/completions`,
`POST /v1/messages`) through provider adapters. Step 5 closes the loop:
every completed proxy request now produces a `token_logs` row with
normalized usage and a calculated cost.

- **Usage normalization** (`src/modules/providers/{openai,anthropic}-usage.ts`)
  maps each provider's own response shape to a common
  `{ inputTokens, outputTokens, totalTokens, source }`. `source` is
  `"provider"` when the AI provider reported the numbers, or `"unknown"`
  when it didn't — token fields are `null` in that case, never a fake `0`.
  (`"estimated"` — TokenGuard estimating tokens itself — is reserved in
  the type but not implemented; no tokenizer is wired up yet.)
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

Streaming (`stream: true`) is still rejected with `501` — it lands in
Step 6; the usage parsers above are written to be reusable by that flow
later, but nothing here reads SSE events yet.

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
code, body, and content-type are returned unmodified.

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
`ANTHROPIC_BASE_URL/v1/messages` byte for byte.

Every completed request (the provider actually responded, whether with
success or its own error status) produces a `token_logs` row keyed by the
`request_id` returned in `X-TokenGuard-Request-Id`. Requests that never
reach the provider — missing/invalid/revoked `X-TokenGuard-Key`, body too
large, `stream: true` — do **not** produce a usage log; there is no
"request" to record usage for.

### Not yet supported

- **Streaming** (`"stream": true`) is rejected with `501` and
  `{"error":{"code":"STREAMING_NOT_IMPLEMENTED", ...}}`, without
  contacting the provider. Lands in Step 6.
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

Configuration is centralized in `src/config/env.ts` and loaded from `.env`
via `dotenv`. See `.env.example` for the currently supported variables:
`PORT`, `HOST`, `NODE_ENV`; the Supabase settings (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`); and the proxy settings
(`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `PROVIDER_REQUEST_TIMEOUT_MS`,
`MAX_PROXY_BODY_BYTES`). Without real Supabase values, the server falls
back to local-development placeholders that cannot authenticate against a
real project; in production, all three Supabase variables are required.
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

Agent-loop detection, budget enforcement, streaming, asynchronous/queued
usage persistence (it's synchronous for now), and the dashboard are **not
implemented**. They will be addressed in later steps.
