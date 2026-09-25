/**
 * Result of a Phase A (admission) check: whether the organization may
 * proceed with another provider request, given committed spend already
 * on record for this period. See budget.service.ts for what "allowed"
 * does and does not guarantee under concurrency.
 */
export interface BudgetAdmissionState {
  allowed: boolean;
  /** organizations.monthly_budget_usd, as a decimal string — never
   * computed on in Node, only surfaced for logging/observability. */
  monthlyBudgetUsd: string;
  /** Committed cost for this organization/period at the moment of the
   * read, as a decimal string. 0 when no request has been charged yet
   * this period. */
  committedCostUsd: string;
  periodStart: string;
}

export interface CommitBudgetChargeInput {
  organizationId: string;
  /** Same value as token_logs.request_id for the request being
   * accounted for — the idempotency key that makes a retried commit a
   * safe no-op instead of a double charge. */
  requestId: string;
  periodStart: string;
  /** A non-negative decimal string — the exact known cost to commit.
   * Never called with a fabricated $0 for an unknown-cost request; see
   * usage-recorder.ts. */
  amountUsd: string;
}

/**
 * Result of a Phase B (final accounting) commit. `applied` is false when
 * this exact request_id had already been charged — the call was a safe,
 * idempotent no-op, not an error.
 */
export interface BudgetChargeResult {
  applied: boolean;
  /** The period's total committed cost after this call (whether or not
   * this specific call applied a new charge). */
  committedCostUsd: string;
}
