-- TokenGuard Step 8: organization-level monthly budget enforcement.
--
-- Reuses organizations.monthly_budget_usd (Step 2) as the ceiling and
-- token_logs.total_cost_usd (Step 5) as the source of known cost. Adds a
-- small ledger — one row per organization per UTC calendar month, plus
-- an idempotency table keyed by token_logs.request_id — so that
-- concurrent requests can be admitted/accounted for without a
-- read-then-write race in application code. All arithmetic that matters
-- for the budget decision happens inside a single atomic SQL statement;
-- Node never computes "old value + delta" and writes it back.
--
-- Deliberately NOT created here: a mutable organizations.spent_usd
-- column (would itself be a read-modify-write hazard), a cron job to
-- "reset" anything (the period is derived from period_start, so a new
-- month is naturally a fresh, empty row), or any UI/dashboard surface.

-- =============================================================================
-- organization_budget_periods
-- =============================================================================
-- One row per organization per UTC calendar month. `period_start` is
-- always the first day of that month (e.g. 2026-09-01 for all of
-- September 2026 UTC) — a `date` column, not `timestamptz`, so the value
-- is an unambiguous calendar date with no timezone interpretation at
-- read time. `committed_cost_usd` is the running total of known cost
-- committed against this period; it is only ever changed via the atomic
-- `commit_budget_charge` function below, never a plain UPDATE from
-- application code.

create table if not exists public.organization_budget_periods (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  period_start date not null,
  committed_cost_usd numeric(14, 8) not null default 0 check (committed_cost_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, period_start)
);

-- The primary key above already gives an O(1) index for the one query
-- this step needs on the hot path: "committed spend for this org this
-- month". No additional index is required.

drop trigger if exists organization_budget_periods_set_updated_at
  on public.organization_budget_periods;
create trigger organization_budget_periods_set_updated_at
  before update on public.organization_budget_periods
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- organization_budget_charges
-- =============================================================================
-- The idempotency ledger: one row per *charged* request. request_id
-- references token_logs.request_id (backed by that table's own unique
-- index), so a budget charge can never exist without a corresponding
-- persisted usage log, and re-attempting the same charge (a retried
-- accounting call after a transient failure, for example) is a no-op —
-- see commit_budget_charge's ON CONFLICT DO NOTHING below. This is what
-- makes "same request charged twice" structurally impossible rather
-- than merely unlikely.

create table if not exists public.organization_budget_charges (
  request_id uuid primary key references public.token_logs (request_id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  period_start date not null,
  amount_usd numeric(14, 8) not null check (amount_usd >= 0),
  created_at timestamptz not null default now(),
  foreign key (organization_id, period_start)
    references public.organization_budget_periods (organization_id, period_start)
);

create index if not exists organization_budget_charges_org_period_idx
  on public.organization_budget_charges (organization_id, period_start);

-- Defense in depth, mirroring token_logs_enforce_key_organization: a
-- charge's organization_id must match the organization that actually
-- owns the token_logs row it accounts for. This can only ever fire if
-- application code passes an inconsistent organization_id — the normal
-- request path always derives both from the same ProxyRequestContext.

create or replace function public.enforce_budget_charge_organization()
returns trigger
language plpgsql
as $$
declare
  v_log_org uuid;
begin
  select organization_id into v_log_org
  from public.token_logs
  where request_id = new.request_id;

  if v_log_org is null then
    raise exception 'request_id % does not have a corresponding token_logs row', new.request_id;
  end if;

  if v_log_org <> new.organization_id then
    raise exception
      'organization_id % does not match the organization owning request_id %',
      new.organization_id, new.request_id;
  end if;

  return new;
end;
$$;

drop trigger if exists organization_budget_charges_enforce_organization
  on public.organization_budget_charges;
create trigger organization_budget_charges_enforce_organization
  before insert on public.organization_budget_charges
  for each row
  execute function public.enforce_budget_charge_organization();

-- =============================================================================
-- Phase A: admission check
-- =============================================================================
-- Read-only. Answers "is this organization already at or over its
-- monthly budget for this period?" in one round trip (a LEFT JOIN, so an
-- organization with no spend yet this month simply reads as
-- committed_cost_usd = 0, no separate row-creation step needed for a
-- read). The `allowed` boolean is computed here, in SQL, rather than by
-- comparing two numeric strings in Node — avoids any floating-point
-- ambiguity around the comparison that actually gates provider access.
--
-- This function does not and cannot prevent every over-admission race:
-- it reads the CURRENT committed total, which only reflects requests
-- whose cost is already known and committed (Phase B, below). Two
-- requests admitted concurrently, both still in flight at the provider,
-- can both later commit costs that together exceed the budget — the
-- provider round trip means the true cost of an in-flight request is
-- fundamentally unknowable at admission time. What this function does
-- guarantee is that every request's admission decision reflects a
-- real, fully-committed snapshot of spend — never a torn or
-- partially-applied one — because Phase B's increment (further below)
-- is always a single atomic statement.

create or replace function public.get_budget_admission_state(
  p_organization_id uuid,
  p_period_start date
) returns table (
  allowed boolean,
  monthly_budget_usd numeric,
  committed_cost_usd numeric
)
language sql
stable
as $$
  select
    coalesce(p.committed_cost_usd, 0) < o.monthly_budget_usd as allowed,
    o.monthly_budget_usd,
    coalesce(p.committed_cost_usd, 0) as committed_cost_usd
  from public.organizations o
  left join public.organization_budget_periods p
    on p.organization_id = o.id
    and p.period_start = p_period_start
  where o.id = p_organization_id;
$$;

revoke all on function public.get_budget_admission_state(uuid, date) from public;
grant execute on function public.get_budget_admission_state(uuid, date) to service_role;

-- =============================================================================
-- Phase B: final accounting (atomic commit)
-- =============================================================================
-- Commits a known cost against the organization's period exactly once
-- per request_id. Always succeeds in recording the charge (Phase B never
-- rejects — the request already happened; see the migration header and
-- README's "Budget enforcement" section for why a later-known cost can
-- legitimately push committed spend past the configured budget). Two
-- statements make this safe under concurrency:
--
--   1. `insert ... on conflict (request_id) do nothing` — the
--      idempotency gate. Postgres resolves a unique-key conflict between
--      concurrent inserts by letting exactly one succeed; FOUND is only
--      true for the call that actually inserted a new row, so a retried
--      or duplicate commit for the same request never proceeds to
--      step 2.
--   2. `update ... set committed_cost_usd = committed_cost_usd + p_amount_usd`
--      — a single atomic read-modify-write performed BY Postgres, not by
--      this function reading a value into a variable and writing it
--      back. Concurrent UPDATEs to the same row serialize via Postgres's
--      normal row-level locking: the second waits for the first to
--      commit, then applies its own delta on top of the now-current
--      value. No update is ever lost, regardless of how many concurrent
--      requests commit a charge for the same organization/period.

create or replace function public.commit_budget_charge(
  p_organization_id uuid,
  p_request_id uuid,
  p_period_start date,
  p_amount_usd numeric
) returns table (
  applied boolean,
  committed_cost_usd numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applied boolean := false;
begin
  if p_amount_usd is null or p_amount_usd < 0 then
    raise exception 'amount_usd must be a non-negative number';
  end if;

  -- Idempotent create-if-missing for the period row. ON CONFLICT DO
  -- NOTHING means concurrent "first request of the month" calls can
  -- never create duplicate period rows — exactly one insert wins, the
  -- rest no-op against the primary key.
  insert into public.organization_budget_periods (organization_id, period_start, committed_cost_usd)
  values (p_organization_id, p_period_start, 0)
  on conflict (organization_id, period_start) do nothing;

  -- Idempotency gate keyed by request_id.
  insert into public.organization_budget_charges (request_id, organization_id, period_start, amount_usd)
  values (p_request_id, p_organization_id, p_period_start, p_amount_usd)
  on conflict (request_id) do nothing;

  if found then
    v_applied := true;

    update public.organization_budget_periods
    set committed_cost_usd = committed_cost_usd + p_amount_usd
    where organization_id = p_organization_id
      and period_start = p_period_start;
  end if;

  return query
    select
      v_applied,
      p.committed_cost_usd
    from public.organization_budget_periods p
    where p.organization_id = p_organization_id
      and p.period_start = p_period_start;
end;
$$;

revoke all on function public.commit_budget_charge(uuid, uuid, date, numeric) from public;
grant execute on function public.commit_budget_charge(uuid, uuid, date, numeric) to service_role;

-- =============================================================================
-- Row Level Security
-- =============================================================================
-- Same split as every other table in this schema: the backend's
-- service-role credential bypasses RLS and is the only writer (via the
-- two functions above). RLS here protects a future dashboard reading
-- directly with a user's own Supabase session.

alter table public.organization_budget_periods enable row level security;
alter table public.organization_budget_charges enable row level security;

create policy organization_budget_periods_select_member
  on public.organization_budget_periods
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.organization_id = organization_budget_periods.organization_id
        and m.user_id = auth.uid()
    )
  );

create policy organization_budget_charges_select_member
  on public.organization_budget_charges
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.organization_id = organization_budget_charges.organization_id
        and m.user_id = auth.uid()
    )
  );
