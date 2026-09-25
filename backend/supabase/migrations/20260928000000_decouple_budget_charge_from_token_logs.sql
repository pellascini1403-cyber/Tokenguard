-- TokenGuard Step 9: async usage logging.
--
-- Step 8's organization_budget_charges.request_id had a hard foreign key
-- to token_logs.request_id, meaning a budget charge could only ever be
-- committed AFTER the token_logs row already existed. That was correct
-- for Step 8 (both writes happened synchronously, in order, on the
-- request path) but is now the wrong constraint: Step 9 moves token_logs
-- persistence onto an internal async queue/worker so it no longer
-- blocks the client response, while budget accounting (Phase B) must
-- stay synchronous and correct regardless of when — or whether — the
-- corresponding token_logs row has been written yet. Keeping the FK
-- would force every cost-bearing request back onto the slow synchronous
-- path, defeating the point of this step.
--
-- This migration removes that ordering dependency. It does NOT weaken
-- budget correctness: idempotency is still enforced by
-- organization_budget_charges.request_id being a PRIMARY KEY (see
-- commit_budget_charge's ON CONFLICT DO NOTHING, unchanged from Step 8),
-- and atomicity is still enforced by the single `UPDATE ... SET
-- committed_cost_usd = committed_cost_usd + amount` statement, also
-- unchanged. Only the *ordering* requirement ("token_logs first") is
-- relaxed.

alter table public.organization_budget_charges
  drop constraint if exists organization_budget_charges_request_id_fkey;

-- The tenant-isolation trigger previously required a token_logs row to
-- exist (raising if it didn't) — now that a charge can legitimately be
-- committed before its token_logs row is written (or, if the async
-- worker fails permanently, before one is ever written), that
-- requirement is relaxed to "verify the match IF a token_logs row is
-- already present, otherwise skip" rather than "require one to already
-- exist". This keeps the defense-in-depth check for the common case
-- (synchronous writes, or a token_logs row already queued and
-- processed) without blocking the normal, now-usual case where the
-- charge lands first.

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

  if v_log_org is not null and v_log_org <> new.organization_id then
    raise exception
      'organization_id % does not match the organization owning request_id %',
      new.organization_id, new.request_id;
  end if;

  return new;
end;
$$;

-- Trigger itself (name, table, timing) is unchanged — only the function
-- body above changed — but re-stated here for clarity/idempotency of
-- this migration file.
drop trigger if exists organization_budget_charges_enforce_organization
  on public.organization_budget_charges;
create trigger organization_budget_charges_enforce_organization
  before insert on public.organization_budget_charges
  for each row
  execute function public.enforce_budget_charge_organization();
