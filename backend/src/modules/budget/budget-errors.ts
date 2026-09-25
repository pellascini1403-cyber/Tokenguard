import { AppError } from "../../lib/errors.js";

export function monthlyBudgetExceededError(): AppError {
  return new AppError(
    "MONTHLY_BUDGET_EXCEEDED",
    429,
    "The organization's monthly AI spending budget has been reached.",
  );
}

/**
 * Thrown/returned when the Phase A admission check itself could not be
 * completed (a database error). TokenGuard fails closed on this — it
 * never treats "the budget check failed" as "budget available" — so
 * this always accompanies rejecting the request, not admitting it.
 */
export function budgetCheckUnavailableError(): AppError {
  return new AppError(
    "BUDGET_CHECK_UNAVAILABLE",
    503,
    "Unable to verify the organization's budget right now. Please retry shortly.",
  );
}
