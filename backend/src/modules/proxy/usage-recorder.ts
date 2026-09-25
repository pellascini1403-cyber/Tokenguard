import type { FastifyBaseLogger } from "fastify";
import type { BudgetService } from "../budget/budget.service.js";
import type { ParsedProviderResponse } from "../providers/usage-types.js";
import type { PricingService } from "../pricing/types.js";
import type { UsageLog } from "../usage/types.js";
import type { UsageService } from "../usage/usage.service.js";
import type { ProxyRequestContext } from "./types.js";

/**
 * The route already knows which provider it called and therefore which
 * parser (parseOpenAiResponse / parseAnthropicResponse, both in
 * src/modules/providers) to run — it passes the already-normalized
 * result here rather than this module re-deriving "which parser for this
 * provider" from context.provider a second time.
 */
export interface RecordProxyUsageInput {
  context: ProxyRequestContext;
  statusCode: number;
  durationMs: number;
  parsedResponse: ParsedProviderResponse;
}

const FALLBACK_MODEL = "unknown";

/**
 * Thrown by recordProxyUsage specifically when the usage log itself was
 * persisted successfully but the subsequent Step 8 budget charge (Phase
 * B) failed. Distinguished from an ordinary persistence failure because
 * it is strictly more serious: usage was recorded, but the
 * organization's committed spend is now under-counted, which can let a
 * later admission check wrongly allow a request it should have blocked.
 * recordProxyUsageSafely logs this distinctly (and at higher severity)
 * from a generic "failed to record proxy usage".
 */
export class BudgetAccountingFailedError extends Error {
  constructor(cause: unknown) {
    super("Budget accounting failed after the usage log was already persisted");
    this.name = "BudgetAccountingFailedError";
    this.cause = cause;
  }
}

export interface UsageRecorder {
  /**
   * Prices the normalized usage, persists one token_logs row via
   * usageService.createUsageLog() (Step 3), and — when a budget service
   * was configured and the resulting cost is known — commits that cost
   * against the organization's monthly budget exactly once (Step 8,
   * Phase B). Throws on failure (validation, persistence, or budget
   * accounting); callers on the hot path should use
   * `recordProxyUsageSafely` instead unless they specifically want the
   * failure to propagate.
   *
   * `logger` is optional so existing callers/tests that only care about
   * the usage log itself are unaffected; passing it enables the
   * BUDGET_COST_UNKNOWN observability event (see below).
   */
  recordProxyUsage(input: RecordProxyUsageInput, logger?: FastifyBaseLogger): Promise<UsageLog>;
}

export function createUsageRecorder(
  usageService: UsageService,
  pricingService: PricingService,
  budgetService?: BudgetService,
): UsageRecorder {
  return {
    async recordProxyUsage(
      input: RecordProxyUsageInput,
      logger?: FastifyBaseLogger,
    ): Promise<UsageLog> {
      const { context, parsedResponse } = input;
      const modelUsed = parsedResponse.model ?? context.requestedModel ?? FALLBACK_MODEL;

      const pricing = pricingService.getModelPricing(context.provider, modelUsed);
      const cost = pricingService.calculateCost(parsedResponse.usage, pricing);

      const usageLog = await usageService.createUsageLog({
        organizationId: context.organizationId,
        tokenGuardKeyId: context.tokenGuardKeyId,
        provider: context.provider,
        modelUsed,
        promptTokens: parsedResponse.usage.inputTokens,
        completionTokens: parsedResponse.usage.outputTokens,
        totalTokens: parsedResponse.usage.totalTokens,
        inputCostUsd: cost.inputCostUsd,
        outputCostUsd: cost.outputCostUsd,
        totalCostUsd: cost.totalCostUsd,
        usageSource: parsedResponse.usage.source,
        pricingVersion: cost.pricingVersion,
        durationMs: input.durationMs,
        statusCode: input.statusCode,
        requestId: context.requestId,
      });

      if (!budgetService) {
        return usageLog;
      }

      if (cost.totalCostUsd === null) {
        // Unknown cost is never treated as $0 and never charged — only
        // reported, as safe metadata, so budget accounting's blind spot
        // stays observable rather than silent.
        try {
          logger?.warn(
            {
              requestId: context.requestId,
              organizationId: context.organizationId,
              tokenGuardKeyId: context.tokenGuardKeyId,
              provider: context.provider,
              model: modelUsed,
              errorCode: "BUDGET_COST_UNKNOWN",
            },
            "Known monetary cost unavailable for this request — not counted toward the monthly budget",
          );
        } catch {
          // Never let a logging failure affect the response.
        }
        return usageLog;
      }

      try {
        await budgetService.commitCharge({
          organizationId: context.organizationId,
          requestId: context.requestId,
          periodStart: context.budgetPeriodStart,
          amountUsd: cost.totalCostUsd,
        });
      } catch (error) {
        throw new BudgetAccountingFailedError(error);
      }

      return usageLog;
    },
  };
}

/**
 * Records usage without ever throwing. A pricing, persistence, or
 * budget-accounting failure must never turn a successful AI response
 * into a failed one — but per usageService's own contract, failures are
 * never silently discarded either: this logs the failure so it stays
 * visible to operators. A BudgetAccountingFailedError is logged at
 * higher severity and with a distinct message from any other failure,
 * since it means committed spend is now under-counted (see
 * BudgetAccountingFailedError's doc comment above).
 */
export async function recordProxyUsageSafely(
  recorder: UsageRecorder,
  input: RecordProxyUsageInput,
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await recorder.recordProxyUsage(input, logger);
  } catch (error) {
    if (error instanceof BudgetAccountingFailedError) {
      logger.error(
        {
          err: error,
          requestId: input.context.requestId,
          organizationId: input.context.organizationId,
          provider: input.context.provider,
        },
        "CRITICAL: budget accounting failed after usage was recorded — organization spend may be under-counted",
      );
      return;
    }
    logger.error(
      { err: error, requestId: input.context.requestId, provider: input.context.provider },
      "Failed to record proxy usage",
    );
  }
}
