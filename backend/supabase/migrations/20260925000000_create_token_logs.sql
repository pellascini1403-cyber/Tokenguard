-- TokenGuard Step 3: usage-logging persistence foundation.
--
-- Records auditing metadata for AI requests the proxy will complete in a
-- later step. This table is deliberately metadata-only: it must never
-- contain prompts, responses, Authorization headers, provider API keys,
-- or TokenGuard plaintext keys. TokenGuard audits usage; it does not
-- archive content.
--
-- Deliberately NOT created here: the AI proxy itself, token counting,
-- cost/pricing calculation, budget enforcement, or dashboard aggregation
-- tables beyond the read helpers below. Those belong to later steps.

-- =============================================================================
-- token_logs
-- =============================================================================

create table if not exists public.token_logs (
  id uuid primary key default gen_random_uuid(),

  -- Denormalized alongside token_guard_key_id for query performance: every
  -- dashboard/analytics query filters by organization first, and this
  -- avoids a join through token_guard_keys on the hottest read paths. Kept
  -- consistent with the key's own organization by the trigger below.
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- Nullable + ON DELETE SET NULL (not CASCADE): a usage log is audit
  -- history and must outlive the credential that generated it. Revoking a
  -- key never deletes the key row (see token_guard_keys.revoked_at), so
  -- this only matters if a key is ever hard-deleted in the future — the
  -- log survives with organization_id intact but loses the specific-key
  -- attribution rather than being destroyed.
  token_guard_key_id uuid references public.token_guard_keys (id) on delete set null,

  -- A `text` + CHECK rather than a native enum: extending an enum later
  -- requires an ALTER TYPE migration with its own transactional
  -- caveats, while widening a CHECK constraint is a trivial migration.
  provider text not null check (provider in ('openai', 'anthropic')),

  -- The provider's own model identifier (e.g. "gpt-4o", "claude-sonnet-5").
  -- No model catalog yet — this step only records what was used.
  model_used text not null check (length(model_used) between 1 and 200),

  -- Token counts are NULL, never 0, when a provider response did not
  -- report usage — 0 would falsely claim "known and zero". bigint: some
  -- providers/models already support context windows in the low
  -- millions, and per-row values should never be truncated.
  prompt_tokens bigint check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens bigint check (completion_tokens is null or completion_tokens >= 0),
  total_tokens bigint check (total_tokens is null or total_tokens >= 0),
  constraint token_logs_total_tokens_consistent check (
    total_tokens is null
    or prompt_tokens is null
    or completion_tokens is null
    or total_tokens = prompt_tokens + completion_tokens
  ),

  -- NUMERIC, never float/real/double, for money. 8 fractional digits
  -- comfortably represents sub-cent per-request pricing (e.g. a model
  -- priced at $0.0000015/token). NULL, not 0, when cost is not yet known
  -- (pricing calculation is a later application-layer step) — mirrors the
  -- token-count NULL-means-unknown convention above.
  input_cost_usd numeric(14, 8) check (input_cost_usd is null or input_cost_usd >= 0),
  output_cost_usd numeric(14, 8) check (output_cost_usd is null or output_cost_usd >= 0),
  total_cost_usd numeric(14, 8) check (total_cost_usd is null or total_cost_usd >= 0),

  -- Wall-clock duration of the proxied request. Always measurable
  -- regardless of success/failure or token-usage availability.
  duration_ms integer not null check (duration_ms >= 0),

  -- The HTTP status TokenGuard returned to the caller. Doubles as the
  -- success/failure signal (2xx = success) without a separate,
  -- potentially-inconsistent boolean column.
  status_code smallint not null check (status_code between 100 and 599),

  -- Correlates one proxy request to exactly one log row. UNIQUE (not just
  -- indexed) so that a future at-least-once persistence retry can be made
  -- idempotent by upserting/ignoring on conflict, and so "look up what
  -- happened for this request" is a guaranteed single-row query.
  request_id uuid not null,

  -- Server-generated only; the proxy never supplies this itself, so a
  -- caller cannot backdate or spoof usage history.
  created_at timestamptz not null default now()
);

create unique index if not exists token_logs_request_id_key
  on public.token_logs (request_id);

-- organization + time range: the base case for "usage in the last N days"
-- and recent-logs queries, which always filter by organization first.
create index if not exists token_logs_org_created_at_idx
  on public.token_logs (organization_id, created_at desc);

-- organization + provider + time range: per-provider breakdowns
-- ("how much did we spend on Anthropic this month?").
create index if not exists token_logs_org_provider_created_at_idx
  on public.token_logs (organization_id, provider, created_at desc);

-- organization + model + time range: per-model breakdowns, and the
-- getOrganizationLogs model filter.
create index if not exists token_logs_org_model_created_at_idx
  on public.token_logs (organization_id, model_used, created_at desc);

-- credential + time range: "which key generated the most usage / should
-- be revoked" queries.
create index if not exists token_logs_key_created_at_idx
  on public.token_logs (token_guard_key_id, created_at desc);

-- No further indexes: this table can reach millions of rows, and each
-- additional index adds write overhead to what will become the proxy's
-- hottest insert path. The four above (plus the request_id unique index)
-- cover every query this step's repository issues; add more only against
-- a query that actually needs one.

-- =============================================================================
-- Enforce organization_id matches the referenced key's organization
-- =============================================================================
-- organization_id is denormalized for query performance (see column
-- comment above), so nothing stops it from being written inconsistently
-- with token_guard_key_id by a caller bug. A CHECK constraint cannot
-- reference another table, so this is enforced with a trigger instead —
-- the only mechanism Postgres offers for a cross-table invariant, and one
-- that runs inside the same statement as the insert (no extra network
-- round trip on the hot path, unlike an application-layer lookup would
-- require).

create or replace function public.enforce_token_log_key_organization()
returns trigger
language plpgsql
as $$
declare
  v_key_org uuid;
begin
  if new.token_guard_key_id is not null then
    select organization_id into v_key_org
    from public.token_guard_keys
    where id = new.token_guard_key_id;

    if v_key_org is null then
      raise exception 'token_guard_key_id % does not exist', new.token_guard_key_id;
    end if;

    if v_key_org <> new.organization_id then
      raise exception
        'organization_id % does not match the organization owning token_guard_key_id %',
        new.organization_id, new.token_guard_key_id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists token_logs_enforce_key_organization on public.token_logs;
create trigger token_logs_enforce_key_organization
  before insert or update on public.token_logs
  for each row
  execute function public.enforce_token_log_key_organization();

-- =============================================================================
-- Organization usage summary (read helper for the future dashboard)
-- =============================================================================
-- Aggregates in Postgres rather than fetching rows into Node — this table
-- can hold millions of rows per organization. Always returns exactly one
-- row (zeros/nulls when there is no matching usage), so callers never
-- need to special-case an empty result set.

create or replace function public.get_organization_usage_summary(
  p_organization_id uuid,
  p_start timestamptz default null,
  p_end timestamptz default null
) returns table (
  request_count bigint,
  total_prompt_tokens bigint,
  total_completion_tokens bigint,
  total_tokens bigint,
  total_cost_usd numeric,
  requests_with_unknown_usage bigint
)
language sql
stable
as $$
  select
    count(*) as request_count,
    coalesce(sum(prompt_tokens), 0) as total_prompt_tokens,
    coalesce(sum(completion_tokens), 0) as total_completion_tokens,
    coalesce(sum(total_tokens), 0) as total_tokens,
    coalesce(sum(total_cost_usd), 0) as total_cost_usd,
    count(*) filter (where total_tokens is null) as requests_with_unknown_usage
  from public.token_logs
  where organization_id = p_organization_id
    and (p_start is null or created_at >= p_start)
    and (p_end is null or created_at <= p_end);
$$;

-- Only the backend's service-role credential calls this, matching
-- create_organization_with_owner's grant pattern; authorization (which
-- organization a caller may query) is enforced at the application layer,
-- not by this function.
revoke all on function public.get_organization_usage_summary(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_organization_usage_summary(uuid, timestamptz, timestamptz) to service_role;

-- =============================================================================
-- Row Level Security
-- =============================================================================
-- Same split as organizations/organization_members/token_guard_keys: the
-- backend's service-role credential bypasses RLS and is the only writer
-- (usage logging will be called from the proxy in a later step, not from
-- any client). RLS here protects a future dashboard reading directly
-- with a user's own Supabase session — authenticated users may only read
-- usage logs for organizations they belong to, never another tenant's.

alter table public.token_logs enable row level security;

create policy token_logs_select_member
  on public.token_logs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.organization_id = token_logs.organization_id
        and m.user_id = auth.uid()
    )
  );
