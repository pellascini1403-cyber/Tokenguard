import type { SupabaseAppClient } from "../auth/supabase-client.js";
import type { BudgetAdmissionState, BudgetChargeResult, CommitBudgetChargeInput } from "./types.js";

interface AdmissionRow {
  allowed: boolean;
  monthly_budget_usd: string;
  committed_cost_usd: string;
}

interface ChargeRow {
  applied: boolean;
  committed_cost_usd: string;
}

export interface BudgetRepository {
  /** Phase A: a single read-only round trip — see the
   * get_budget_admission_state SQL function for why `allowed` is
   * computed in Postgres, not compared from two strings in Node. */
  getAdmissionState(organizationId: string, periodStart: string): Promise<BudgetAdmissionState>;
  /** Phase B: a single atomic commit — see the commit_budget_charge SQL
   * function for the concurrency/idempotency guarantees. */
  commitCharge(input: CommitBudgetChargeInput): Promise<BudgetChargeResult>;
}

export function createBudgetRepository(adminClient: SupabaseAppClient): BudgetRepository {
  return {
    async getAdmissionState(
      organizationId: string,
      periodStart: string,
    ): Promise<BudgetAdmissionState> {
      // rpc() on the untyped Supabase client resolves to `any`; the
      // returned row is cast to AdmissionRow below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await adminClient.rpc("get_budget_admission_state", {
        p_organization_id: organizationId,
        p_period_start: periodStart,
      });

      if (error) {
        throw new Error(`Failed to read budget admission state: ${error.message}`);
      }

      const rows = data as AdmissionRow[];
      const row = rows[0];
      if (!row) {
        throw new Error(`No organization found for budget admission check: ${organizationId}`);
      }

      return {
        allowed: row.allowed,
        monthlyBudgetUsd: row.monthly_budget_usd,
        committedCostUsd: row.committed_cost_usd,
        periodStart,
      };
    },

    async commitCharge(input: CommitBudgetChargeInput): Promise<BudgetChargeResult> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await adminClient.rpc("commit_budget_charge", {
        p_organization_id: input.organizationId,
        p_request_id: input.requestId,
        p_period_start: input.periodStart,
        p_amount_usd: input.amountUsd,
      });

      if (error) {
        throw new Error(`Failed to commit budget charge: ${error.message}`);
      }

      const rows = data as ChargeRow[];
      const row = rows[0];
      if (!row) {
        throw new Error("Budget charge commit returned no row");
      }

      return { applied: row.applied, committedCostUsd: row.committed_cost_usd };
    },
  };
}
