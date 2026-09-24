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

**None of the above is implemented yet.**

## Current scope: Step 2 — Authentication + multi-tenant foundation

Step 1 established the Fastify/TypeScript foundation (`GET /health`,
centralized config/error handling/logging, tooling). Step 2 adds:

- Supabase as the Postgres database and user-auth provider, via
  `supabase/migrations/` and `@supabase/supabase-js`
- `organizations`, `organization_members`, and `token_guard_keys` tables
  with Row Level Security (see **Database** below)
- a reusable Supabase-access-token verification hook
  (`src/modules/auth/`) that authenticates dashboard/API users
- TokenGuard API key generation, hashing, verification, and revocation
  (`src/modules/keys/`) — keys are stored only as a SHA-256 hash, never
  in plaintext
- organization membership and role-based authorization
  (`src/modules/organizations/`)
- endpoints to exercise the above: `GET /v1/me`, `POST /v1/organizations`,
  `GET /v1/organizations`, `POST /v1/organizations/:id/keys`,
  `POST /v1/organizations/:id/keys/:keyId/revoke`

There is still **no AI provider proxy** (`/v1/chat/completions` and
similar are not implemented), no token/cost accounting, no budget
enforcement, and no dashboard. `keysService.verifyKey()` is the reusable
credential-resolution function a later proxy step will call — it is not
wired to any route yet.

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
- **TokenGuard API keys** (`tg_usr_live_...`) will authenticate a
  customer's proxy traffic in a later step. They are generated, hashed,
  and verified independently of Supabase Auth.

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
`PORT`, `HOST`, `NODE_ENV`, and the Supabase settings (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Without real Supabase
values, the server falls back to local-development placeholders that
cannot authenticate against a real project; in production, all three
Supabase variables are required. `SUPABASE_SERVICE_ROLE_KEY` bypasses Row
Level Security and must never reach a browser or be logged — see
**Database** above.

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

## Not implemented yet

The AI provider proxy (`/v1/chat/completions` and similar), token/cost
accounting, agent-loop detection, budget enforcement, usage logging, and
the dashboard are **not implemented**. They will be addressed in later
steps.
