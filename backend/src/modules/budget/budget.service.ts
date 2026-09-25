import { badRequestError } from "../../lib/errors.js";
import { isUuid } from "../../lib/uuid.js";
import type { SupabaseAppClient } from "../auth/supabase-client.js";
import { createBudgetRepository } from "./budget.repository.js";
import type { BudgetAdmissionState, BudgetChargeResult, CommitBudgetChargeInput } from "./types.js";

const DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;
const PERIOD_START_PATTERN = /^\d{4}-\d{2}-01$/;

function validatePeriodStart(periodStart: string): void {
  if (!PERIOD_START_PATTERN.test(periodStart)) {
    throw badRequestError('periodStart must be a "YYYY-MM-01" date string');
  }
}

export interface BudgetService {
  /**
   * Phase A (admission): is this organization currently allowed to make
   * another provider request? Reflects only already-committed spend
   * (Phase B charges from prior requests) — see budget-period.ts and
   * the SQL migration for exactly what this does and does not
   * guarantee under concurrent in-flight requests.
   */
  checkAdmission(organizationId: string, periodStart: string): Promise<BudgetAdmissionState>;
  /**
   * Phase B (final accounting): atomically commits a known cost against
   * the organization's period, exactly once per requestId. Never
   * rejects — the request already happened; this only records it. Safe
   * to call more than once for the same requestId (idempotent no-op
   * after the first).
   */
  commitCharge(input: CommitBudgetChargeInput): Promise<BudgetChargeResult>;
}

export function createBudgetService(adminClient: SupabaseAppClient): BudgetService {
  const repository = createBudgetRepository(adminClient);

  return {
    async checkAdmission(
      organizationId: string,
      periodStart: string,
    ): Promise<BudgetAdmissionState> {
      if (!isUuid(organizationId)) {
        throw badRequestError("organizationId must be a valid UUID");
      }
      validatePeriodStart(periodStart);
      return repository.getAdmissionState(organizationId, periodStart);
    },

    async commitCharge(input: CommitBudgetChargeInput): Promise<BudgetChargeResult> {
      if (!isUuid(input.organizationId)) {
        throw badRequestError("organizationId must be a valid UUID");
      }
      if (!isUuid(input.requestId)) {
        throw badRequestError("requestId must be a valid UUID");
      }
      validatePeriodStart(input.periodStart);
      if (!DECIMAL_STRING_PATTERN.test(input.amountUsd)) {
        throw badRequestError("amountUsd must be a non-negative decimal string");
      }
      return repository.commitCharge(input);
    },
  };
}
