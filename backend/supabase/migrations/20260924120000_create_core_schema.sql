-- TokenGuard Step 2: organizations, organization membership, and
-- TokenGuard API credentials. This is the multi-tenant identity
-- foundation the proxy will use in a later step to resolve which
-- organization a request belongs to.
--
-- Deliberately NOT created here: usage logs, billing tables, alert
-- tables, provider configuration tables, or dashboard aggregation
-- tables. Those belong to later steps.

create extension if not exists "pgcrypto";

-- =============================================================================
-- organizations
-- =============================================================================

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  monthly_budget_usd numeric(12, 2) not null default 500.00 check (monthly_budget_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- organization_members
-- =============================================================================
-- user_id references the authenticated Supabase user (auth.users). A user
-- may belong to multiple organizations; an organization may have multiple
-- users. The unique constraint prevents duplicate membership rows.

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists organization_members_user_id_idx
  on public.organization_members (user_id);

create index if not exists organization_members_organization_id_idx
  on public.organization_members (organization_id);

-- =============================================================================
-- token_guard_keys
-- =============================================================================
-- Stores only a one-way hash of each TokenGuard API key (see
-- backend/src/modules/keys/key-generator.ts). The plaintext secret is never
-- written here and cannot be recovered from this table. key_prefix is a
-- short, non-secret, indexed identifier used to locate a candidate row
-- before the full secret is cryptographically verified; it does not by
-- itself grant access. Revocation is soft-delete via revoked_at so a
-- revoked key's audit trail is preserved.

create table if not exists public.token_guard_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  key_prefix text not null,
  key_hash text not null,
  name text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Unique + indexed for O(1) lookup on the request path. A collision on
-- generation is retried by the application layer (see keys.service.ts).
create unique index if not exists token_guard_keys_key_prefix_key
  on public.token_guard_keys (key_prefix);

create index if not exists token_guard_keys_organization_id_idx
  on public.token_guard_keys (organization_id);

-- =============================================================================
-- Atomic organization creation
-- =============================================================================
-- Creates an organization and its owner membership row in a single
-- transaction, so a partial failure never leaves an ownerless organization
-- or an orphaned membership row. SECURITY DEFINER: runs with the
-- privileges of the function owner (bypassing RLS, like table-owner DDL
-- roles do), regardless of which role calls it.

create or replace function public.create_organization_with_owner(
  p_name text,
  p_owner_user_id uuid
) returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org public.organizations;
begin
  insert into public.organizations (name)
  values (p_name)
  returning * into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org.id, p_owner_user_id, 'owner');

  return v_org;
end;
$$;

-- Only the backend's service-role credential may call this function.
-- Dashboard/browser clients (anon, authenticated) never get EXECUTE.
revoke all on function public.create_organization_with_owner(text, uuid) from public;
grant execute on function public.create_organization_with_owner(text, uuid) to service_role;

-- =============================================================================
-- Row Level Security
-- =============================================================================
-- The backend service (using the Supabase service role key) bypasses RLS
-- entirely and is responsible for enforcing authorization in application
-- code (see organizations.service.ts#requireRole). RLS here is defense in
-- depth for any future client that connects to Supabase directly (e.g. a
-- dashboard reading with a user's own session), and guarantees that no
-- unrestricted access is reachable from the browser via the anon/
-- authenticated roles even if application-layer checks are ever bypassed.
--
-- No INSERT/UPDATE/DELETE policies are defined on any of these tables:
-- all writes currently go through the backend's service-role credential
-- (organization creation via the RPC above, key issuance/revocation via
-- the keys service). Write policies scoped to role ('owner' vs 'member')
-- can be added later if a client needs to write directly.

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.token_guard_keys enable row level security;

-- A user may read organizations they belong to.
create policy organizations_select_member
  on public.organizations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
    )
  );

-- A user may read their own membership rows.
create policy organization_members_select_self
  on public.organization_members
  for select
  to authenticated
  using (user_id = auth.uid());

-- A user may read TokenGuard key metadata for organizations they belong
-- to. RLS enforces row-level tenant isolation only; column-level
-- minimization (never exposing key_hash to clients) is enforced by the
-- backend API layer, which never selects or serializes that column into a
-- response.
create policy token_guard_keys_select_member
  on public.token_guard_keys
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.organization_id = token_guard_keys.organization_id
        and m.user_id = auth.uid()
    )
  );
