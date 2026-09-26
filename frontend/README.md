# TokenGuard Frontend

The dashboard for TokenGuard, a B2B AI-API-proxy product. The
**architectural foundation** (routing, auth, data-fetching, API-client
scaffolding) was built in Step 10. A first real visual pass — the bottom
tab bar and the Overview screen's card layout — was added afterward,
built from PNG assets supplied by the product's designer (see "Visual
assets" below); most other screens are still plain structural
placeholders. See "Not built yet" below for what's still missing.

No frontend existed before this step — this is a fresh Next.js
application, created as a sibling directory to `backend/` (no root
workspace tooling exists yet, so the two are independent pnpm projects).

## Stack

- **Next.js 16** (App Router, TypeScript, Turbopack by default)
- **React 19.2**
- **Tailwind CSS 4** (utility classes for structural layout only — no
  design system or theme has been built)
- **Supabase Auth** via `@supabase/ssr` (cookie-based sessions, shared
  mechanism between the browser and the server, never a manually stored
  token)
- **Vitest + React Testing Library** for tests, matching the backend's
  test runner choice

Package manager: **pnpm**, same as `backend/`.

> Next.js 16 renamed `middleware.ts` → `proxy.ts` (same mechanism, new
> name/export). If you're used to Next.js 15 or earlier, note that
> `cookies()`, `headers()`, and dynamic route `params`/`searchParams` are
> now **always async** — there's no more transitional-sync support.

## Getting started

```bash
cd frontend
pnpm install
cp .env.example .env.local   # then fill in real values
pnpm dev
```

Requires the TokenGuard backend (`../backend`) running and reachable at
`NEXT_PUBLIC_TOKENGUARD_API_URL`, and a Supabase project (or the local
Supabase CLI stack) matching `backend/.env`'s Supabase config — this app
and the backend must point at the **same** Supabase project, since a
Supabase session created here is verified by the backend's own
`auth.getUser()` call.

## Directory structure

```
frontend/
  src/
    app/                    App Router routes (see "Routes" below)
      (auth)/                Route group: login/register/forgot/reset — shared minimal layout
      (dashboard)/           Route group: everything behind the authenticated shell
      onboarding/            Not in either group — reachable right after sign-up, before a shell makes sense
    components/
      ui/                    Generic, backend-agnostic UI primitives (empty state, error message, etc.)
      dashboard/             The app shell: bottom tab bar + More panel, AppScreen (black/white zones), asset cards
    lib/
      env.ts                 Typed, fail-fast environment variable access
      supabase/               Browser client, server client, proxy session-refresh logic
      api/                    Typed HTTP client + one module per backend resource (me, organizations, keys)
      auth/                   Session helpers + Server Actions (sign in/up/out, password reset)
      organizations/          Active-organization cookie, React context, Server Actions
      keys/                   TokenGuard API key create/revoke Server Actions
    types/                   Domain types mirroring only what the backend actually returns
  proxy.ts (at src/, next to app/) Session refresh + route protection — see "Auth architecture"
  tests/                     Vitest + React Testing Library tests
  public/assets/
    nav/                     5 PNGs, one per bottom-nav tab state (home/keys/usage/requests/more-active)
    overview/                5 PNGs — the card shapes used on /overview (2x2 grid + 1 large)
```

## Visual assets

The bottom tab bar and the `/overview` card grid are built from PNG
assets supplied by the product's designer, not recreated in CSS/SVG. The
originals (each a full pill image with one tab shown active, or a sheet
of white rounded-rectangle card shapes) were losslessly cropped to their
content bounding box with Pillow — a mechanical trim of transparent
margins, not a redraw — and saved under `public/assets/`. No pixel drawn
by the designer was altered, recolored, or regenerated.

- **`components/dashboard/app-navigation.tsx`** renders the correct
  `public/assets/nav/*.png` for the current route (via
  `app-navigation-config.ts`'s `resolveActiveTab()`) and lays 5 equal
  invisible tap targets over it — real `<Link>`/`<button>` elements, so
  navigation is functional, while the pixels stay exactly as provided.
  The 5th tab ("More", a "+" icon) never navigates; it opens a bottom
  sheet listing Budgets, Alerts, Settings, Documentation, and Members,
  plus Logout.
- **`components/dashboard/asset-card.tsx`** renders one
  `public/assets/overview/*.png` as a card's background (`next/image`
  with `fill` + `object-contain`, so the shape is never stretched) with
  real, live React content centered on top — token counts, costs, org
  names, etc. stay HTML, never baked into an image.
- **The black/white split**: each screen has a black header zone and a
  white body zone (`components/dashboard/app-screen.tsx`). Per the
  design spec, anything placed in the white zone that reads as a
  card/panel — `MissingBackendCapability`, `EmptyState`, the
  organizations list — uses a black background there, never a light
  card floating on white.

If you're asked to touch this area again: use the asset files as given,
crop losslessly if you need to isolate a sub-region, and never
regenerate/redesign the graphics themselves.

## Routes

| Route | Status |
| --- | --- |
| `/` | Redirects to `/overview` or `/login` depending on session. Not a marketing page (out of scope). |
| `/login`, `/register`, `/forgot-password`, `/reset-password` | Real Supabase Auth forms. |
| `/onboarding` | Real create-organization form, shown only when the user has zero organizations. See the "onboarding-completion" limitation below. |
| `/overview` | Real user + organizations data, laid out on the designer's provided card assets. Documents the missing consolidated-overview endpoint (see below) rather than showing fake metrics. |
| `/usage`, `/requests`, `/requests/[requestId]`, `/budgets` (partially), `/alerts` | Structural placeholders — no backend endpoint exists yet for any of these (see "Missing backend capabilities"). |
| `/api-keys` | Real create/revoke flow against the backend's actual endpoints. No list endpoint exists, so only a just-created key can ever be shown. |
| `/settings`, `/settings/members`, `/settings/preferences` | Read-only where data exists (org name/budget), placeholders elsewhere. |
| `/settings/security` | Real password-change form (Supabase `updateUser`, not a TokenGuard backend endpoint). |
| `/docs`, `/docs/api` | Static reference pages listing the backend's real, implemented endpoints. |

## Auth architecture

1. **`src/proxy.ts`** (Next.js 16's renamed `middleware.ts`) runs on every
   request except static assets. It calls
   `supabase.auth.getUser()` (not the cheaper, unverified `getSession()`)
   to revalidate the session against Supabase itself, then:
   - Redirects an unauthenticated request away from a protected route to
     `/login?redirectTo=<path>`.
   - Redirects an authenticated request away from `/login`, `/register`,
     etc. to `/overview`.
   - Refreshes the session cookie via `@supabase/ssr`'s cookie adapter —
     the same mechanism a Supabase Auth app always uses, never a manual
     token store.
2. **Every protected Server Component re-verifies the session itself**
   (`requireServerSession()` in `lib/auth/session.ts`), per Next.js's own
   guidance that Proxy/Middleware is not a substitute for
   per-request authentication checks (a Proxy matcher change or refactor
   could otherwise silently remove coverage).
3. **Server Actions** (`lib/auth/actions.ts`) call Supabase Auth directly
   for sign in/up/out and password reset — this app never re-implements
   auth logic; it only calls Supabase's SDK, whose session cookies the
   proxy and server client both read.
4. The **service role key is never present in this app** — see
   `.env.example` and `lib/env.ts`. Only the anon key is used, same as
   any browser Supabase client.

### Onboarding-completion limitation (documented, not worked around)

The backend has **no explicit "onboarding complete" flag**. `/onboarding`
infers completion from "the user belongs to at least one organization" —
a heuristic, not authoritative backend state. If the backend later adds a
real onboarding-state field, replace this inference with it (see the
comment in `src/app/onboarding/page.tsx`).

## API client architecture

`lib/api/client.ts` exports `tokenGuardFetch<T>(path, { accessToken,
method?, body? })`: attaches `Authorization: Bearer <token>`, parses
JSON, and normalizes every failure into `TokenGuardApiError` (HTTP error
responses — code, message, and `retryAfterSeconds` when present) or
`TokenGuardNetworkError` (no response at all). It never logs the access
token or request/response bodies.

**Why every backend call happens server-side (Server Components/Server
Actions), never as a client-side `fetch`:** the backend has **no CORS
configuration** (confirmed — no `@fastify/cors` or equivalent dependency,
no CORS headers set anywhere in `backend/src/app.ts`). A browser `fetch`
directly to the backend from a Client Component would be blocked by the
browser's CORS policy. Routing every call through the Next.js server
sidesteps this entirely, since CORS only applies to browser-to-server
requests — and it happens to match this step's own guidance to prefer
Server Components. If a future feature genuinely needs a client-side
fetch straight to the backend, the backend will need CORS configured
first; that is listed below as a missing capability.

Per-resource modules (`lib/api/me.ts`, `organizations.ts`, `keys.ts`)
wrap `tokenGuardFetch` with the exact request/response shapes the
backend returns — see "Domain types" below.

## Domain types

`src/types/` mirrors **only** fields the backend's routes actually
return, verified by reading the route handlers directly (not assumed
from the service layer, which sometimes has more fields than any route
serializes):

- `AuthenticatedUser` — `{ id, email }`, from `GET /v1/me`.
- `Organization` — `{ id, name, monthlyBudgetUsd, createdAt, updatedAt }`,
  from `GET`/`POST /v1/organizations`. **No `role` field** — the backend
  never serializes the caller's role into any organization response
  (`OrganizationsService.requireRole()` is enforced server-side only).
  Do not add one without re-verifying the backend actually returns it.
- `CreatedTokenGuardKey` — `{ id, organizationId, name, prefix, apiKey,
  createdAt }`, from `POST .../keys`. `apiKey` (the plaintext secret) is
  only ever present in this one response.
- `TokenGuardApiError` / `ErrorResponseBody` — mirrors
  `backend/src/types/api.ts` and every `AppError` code actually thrown
  (`backend/src/lib/errors.ts`, `budget-errors.ts`,
  `modules/proxy/loop-guard.ts`).

## Organization context

`lib/organizations/context.tsx` provides `OrganizationProvider` /
`useActiveOrganization()` — a Client Component context seeded from a
server-fetched organization list (never independently fetched or cached
in the browser). Switching organizations writes a cookie via a Server
Action (`lib/organizations/active-organization.ts`) and refreshes the
router.

**This is a UI convenience only — never an authorization decision.**
Every API call that reads or mutates organization-scoped data sends an
explicit `organizationId`, and the backend independently re-verifies the
caller's membership/role on every request
(`OrganizationsService.requireRole()`). If the active-organization cookie
were tampered with to name an organization the signed-in user doesn't
belong to, the backend would simply reject the request with `403
FORBIDDEN` — this app never trusts the cookie as proof of access.

## Data-fetching strategy

Server Components fetch directly (no React Query/SWR — not justified at
this scope: there is no client-side cache invalidation problem yet, since
nothing here polls or subscribes to live data). `"use client"` is used
only where interactivity requires it: forms using `useActionState`, the
organization switcher, the bottom tab bar/More panel. Every dashboard route has a
`loading.tsx` (the `(dashboard)` route group's, plus one for
`/requests` and `/requests/[requestId]` specifically) and the
`(dashboard)` group has one shared `error.tsx`.

## Security review

- No `dangerouslySetInnerHTML` anywhere in this codebase.
- No secrets in `localStorage`/`sessionStorage` — sessions live entirely
  in Supabase's own httpOnly cookies via `@supabase/ssr`.
- The access token is never logged (see `lib/api/client.ts`'s doc
  comment) and never appears in a URL or query parameter.
- Logout (`signOutAction`) calls Supabase's own `signOut()` and redirects
  — no manual cookie clearing that could miss a cookie Supabase sets.
- The active-organization cookie is `httpOnly`, `sameSite: "lax"` — and,
  as above, carries no authorization weight even if read or modified.
- Every environment variable is `NEXT_PUBLIC_*` (see `.env.example`) —
  there is currently no server-only secret in this app, and specifically
  never a Supabase service role key or an AI provider key.

## Responsive & accessibility foundations

- Forms use real `<label htmlFor>`/`<input id>` pairs, not placeholder
  text as a label substitute.
- Interactive elements are real `<button>`/`<a>`/`<Link>` elements, never
  a `<div onClick>`.
- Active nav state is marked with `aria-current="page"`, not conveyed by
  color alone.
- Error and status messages use `role="alert"` / `role="status"`.
- Every provided PNG used decoratively is marked `alt=""
  aria-hidden="true"` — the real label lives on the tap target
  (`aria-label` on the nav `<Link>`/`<button>`) or in the overlaid text,
  never only inside the image.
- The More panel is a `role="dialog"` `aria-modal="true"` sheet, closable
  via its backdrop.

## Missing backend capabilities

Confirmed by reading `backend/src/routes/v1/index.ts` (only `me`,
`organizations`, `organization-keys`, and the AI proxy are registered)
and the relevant service modules directly:

| Capability | Backend state | Affects |
| --- | --- | --- |
| Consolidated overview/summary endpoint | Does not exist at any layer | `/overview` |
| Usage-log read endpoint | `UsageService.getOrganizationLogs()` / `getOrganizationUsageSummary()` exist; no HTTP route | `/usage`, `/overview` |
| Request-log read endpoint (metadata only — prompts/responses are never persisted, by design) | Same as above (`token_logs` table) | `/requests`, `/requests/[requestId]` |
| Current budget spend / remaining-budget read endpoint | `BudgetService` computes this internally for enforcement; no HTTP route | `/budgets` |
| Organization budget/settings edit endpoint (PATCH/PUT) | Only `POST` (create) and `GET` (list) exist | `/settings`, `/budgets` |
| TokenGuard API key list endpoint | `KeysService` has no `listKeys` method; only create/revoke | `/api-keys` |
| Caller's role-in-organization, surfaced in a response | `OrganizationMembership.role` exists in the DB/service layer; never serialized into any route response | Organization context, any future role-gated UI |
| Organization member list / invite / role-change endpoints | No membership-read route at all | `/settings/members` |
| Alerts (any kind) | No table, service, or route | `/alerts` |
| User preferences | No concept in the backend | `/settings/preferences` |
| CORS configuration | No `@fastify/cors` or equivalent; no CORS headers set | Any future client-side (browser) fetch directly to the backend |

## Not built yet (explicitly out of scope so far)

Final visual design for every screen except the bottom nav and
`/overview`'s card grid (the other dashboard pages are still plain
structural placeholders — see the Routes table), a real chart library,
animations/transitions, a marketing/landing page, billing/Stripe
integration, Slack/webhook integrations, advanced alerting or analytics
UI, and dark-mode. Everything not yet restyled is deliberately left as
plain, minimal structure so a future visual pass can restyle it without
rewriting routing, auth, data-fetching, or domain logic — see the file
structure's separation of `components/ui`/`components/dashboard` (visual)
from `lib/`/`types/` (logic/state/data).

## Tests

```bash
pnpm test        # vitest run
pnpm test:watch  # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint .
pnpm build       # next build
```

Covers: route-protection logic (`tests/lib/routing.test.ts`), the API
client's success/error/network-failure normalization
(`tests/lib/api-client.test.ts`), auth and key Server Actions' input
validation (`tests/lib/auth-actions.test.ts`,
`tests/lib/keys-actions.test.ts`), the organization context's active-org
resolution and switching (`tests/lib/organization-context.test.tsx`), and
loading/error boundary rendering (`tests/app/boundaries.test.tsx`).
