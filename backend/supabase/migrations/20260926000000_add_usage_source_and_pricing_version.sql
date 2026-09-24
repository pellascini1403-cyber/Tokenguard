-- TokenGuard Step 5: token/cost tracking additions to token_logs.
--
-- Two explicit, typed columns rather than folding this into JSON (per
-- the architecture rule established in Step 3's token_logs migration):
-- usage_source records WHERE the token counts on this row came from, and
-- pricing_version records WHICH pricing snapshot priced it. Both are
-- necessary to answer "can I trust this row's numbers?" without parsing
-- a blob.
--
-- No other schema changes: prompts, responses, and provider/TokenGuard
-- credentials are still never stored anywhere in this table.

alter table public.token_logs
  add column if not exists usage_source text not null default 'unknown',
  add column if not exists pricing_version text;

alter table public.token_logs
  drop constraint if exists token_logs_usage_source_check;
alter table public.token_logs
  add constraint token_logs_usage_source_check
  check (usage_source in ('provider', 'estimated', 'unknown'));

alter table public.token_logs
  drop constraint if exists token_logs_pricing_version_check;
alter table public.token_logs
  add constraint token_logs_pricing_version_check
  check (pricing_version is null or length(pricing_version) between 1 and 100);

comment on column public.token_logs.usage_source is
  'Where prompt_tokens/completion_tokens/total_tokens came from: '
  '"provider" (the AI provider reported them), "estimated" (TokenGuard '
  'estimated them — not yet implemented), or "unknown" (neither — token '
  'fields are null, never a fake 0).';

comment on column public.token_logs.pricing_version is
  'Identifies which entry in the application-level pricing snapshot '
  '(src/modules/pricing) priced this row at insert time, or null when no '
  'pricing was available for the model (input/output/total cost are then '
  'also null). Costs are calculated once and persisted — this column '
  'exists so a later pricing-table update never rewrites historical cost.';
