import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { ErrorResponseBody } from "../../types/api.js";
import {
  budgetCheckUnavailableError,
  monthlyBudgetExceededError,
} from "../budget/budget-errors.js";
import { getBudgetPeriodEnd } from "../budget/budget-period.js";
import type { BudgetService } from "../budget/budget.service.js";
import type { Provider } from "../usage/types.js";

export interface BudgetGuardParams {
  budgetService: BudgetService;
  organizationId: string;
  tokenGuardKeyId: string;
  provider: Provider;
  endpoint: string;
  requestedModel: string | null;
  periodStart: string;
  requestId: string;
}

export interface BudgetGuardDecision {
  blocked: boolean;
}

function logSafely(
  logger: FastifyBaseLogger,
  level: "warn" | "error",
  payload: Record<string, unknown>,
  message: string,
): void {
  try {
    logger[level](payload, message);
  } catch {
    // A logging failure must never change the request's outcome.
  }
}

/**
 * Phase A (admission): checks whether the organization has already
 * exhausted its monthly budget BEFORE the provider is contacted. Shared
 * by both proxy routes and by both streaming and non-streaming requests
 * — the decision and response shape exist in exactly one place, mirroring
 * modules/proxy/loop-guard.ts.
 *
 * Fails closed: if the check itself cannot be completed (a database
 * error), the request is rejected with 503 rather than silently allowed
 * through — TokenGuard never treats "couldn't verify the budget" as
 * "budget available". See modules/budget/ for Phase B (final
 * accounting), which happens later via the usage recorder.
 */
export async function enforceBudgetAdmission(
  params: BudgetGuardParams,
  reply: FastifyReply,
  logger: FastifyBaseLogger,
): Promise<BudgetGuardDecision> {
  const baseLogFields = {
    requestId: params.requestId,
    organizationId: params.organizationId,
    tokenGuardKeyId: params.tokenGuardKeyId,
    provider: params.provider,
    endpoint: params.endpoint,
    model: params.requestedModel,
  };

  let admission;
  try {
    admission = await params.budgetService.checkAdmission(
      params.organizationId,
      params.periodStart,
    );
  } catch (error) {
    logSafely(
      logger,
      "error",
      { ...baseLogFields, err: error },
      "Budget admission check failed — failing closed, provider not contacted",
    );

    const unavailable = budgetCheckUnavailableError();
    reply.status(unavailable.statusCode);
    const body: ErrorResponseBody = {
      error: { code: unavailable.code, message: unavailable.message },
    };
    reply.send(body);
    return { blocked: true };
  }

  if (admission.allowed) {
    return { blocked: false };
  }

  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((getBudgetPeriodEnd(params.periodStart).getTime() - Date.now()) / 1000),
  );

  logSafely(
    logger,
    "warn",
    { ...baseLogFields, errorCode: "MONTHLY_BUDGET_EXCEEDED" },
    "Blocked a request: organization has exhausted its monthly budget",
  );

  const exceeded = monthlyBudgetExceededError();
  reply.header("retry-after", String(retryAfterSeconds));
  reply.status(exceeded.statusCode);
  const body: ErrorResponseBody = {
    error: { code: exceeded.code, message: exceeded.message, retryAfterSeconds },
  };
  reply.send(body);
  return { blocked: true };
}
