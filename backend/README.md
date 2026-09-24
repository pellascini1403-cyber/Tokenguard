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

## Current scope: Step 4 — AI proxy + provider integration

Step 1 established the Fastify/TypeScript foundation. Step 2 added
Supabase auth, organizations, and TokenGuard API keys. Step 3 added the
`token_logs` persistence layer (not yet written to by anything). Step 4
makes TokenGuard forward real, non-streaming requests to OpenAI and
Anthropic:

- `POST /v1/chat/completions` (OpenAI-compatible) and `POST /v1/messages`
  (Anthropic) — see **AI proxy** below
- provider adapters (`src/modules/providers/`) behind a common
  `ProviderAdapter` interface, so adding a provider later means writing a
  new adapter, not touching the routes
- a request-timeout and body-size-limit policy, both configurable
- a TokenGuard request ID on every request/response, usable later to
  correlate a proxy call with its usage log

Streaming (`stream: true`) is explicitly rejected with `501` — it lands in
Step 6. This step does not count tokens, calculate cost, enforce budgets,
persist usage logs, or add a dashboard; `usageService.createUsageLog()`
(Step 3) is not called from the proxy yet.

## Database

Three tables, created by `supabase/migrations/20260924120000_create_core_schema.sql`:

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

### Not yet supported

- **Streaming** (`"stream": true`) is rejected with `501` and
  `{"error":{"code":"STREAMING_NOT_IMPLEMENTED", ...}}`, without
  contacting the provider. Lands in Step 6.
- Every response carries `X-TokenGuard-Request-Id`. It is not yet linked
  to a persisted usage log (Step 3's `token_logs` table exists, but the
  proxy doesn't write to it yet).
- A request to the provider that times out (`PROVIDER_REQUEST_TIMEOUT_MS`)
  returns `504` / `UPSTREAM_TIMEOUT`; an unreachable provider returns
  `502` / `UPSTREAM_UNAVAILABLE`. Neither ever includes a credential.

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

Token/cost accounting, agent-loop detection, budget enforcement, usage
logging (the proxy doesn't call `usageService.createUsageLog()` yet),
streaming, and the dashboard are **not implemented**. They will be
addressed in later steps.
