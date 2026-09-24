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

## Current scope: Step 1 — Architecture + initial setup

This is the initial foundation only. It establishes:

- a Fastify HTTP server written in strict TypeScript
- a clean separation between app configuration (`app.ts`) and process
  startup (`server.ts`)
- centralized environment configuration
- a single functional endpoint: `GET /health`
- centralized, privacy-conscious error handling and logging
- linting, formatting, type checking, and a test suite

There is **no authentication, no AI provider integration, no database, and
no `/v1` proxy behavior** yet. The `/v1` route registration point exists but
intentionally registers nothing.

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
via `dotenv`. See `.env.example` for the currently supported variables
(`PORT`, `HOST`, `NODE_ENV`) and for placeholders documenting configuration
that later steps will introduce (Supabase, provider credentials, rate
limits, etc.) — none of those are read by the code yet.

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

## Current endpoint

### `GET /health`

Returns a small JSON payload indicating the service is running:

```json
{
  "status": "ok",
  "service": "tokenguard-proxy",
  "version": "0.1.0"
}
```

## Not implemented yet

The AI provider proxy (`/v1/chat/completions` and similar), authentication,
Supabase integration, token/cost accounting, agent-loop detection, budget
enforcement, and the dashboard are **not implemented** in this step. They
will be addressed in later steps.
