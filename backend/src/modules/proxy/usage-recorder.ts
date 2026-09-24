import type { FastifyBaseLogger } from "fastify";
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

export interface UsageRecorder {
  /**
   * Prices the normalized usage and persists one token_logs row via
   * usageService.createUsageLog() (Step 3) — no SQL here, no direct
   * table access. Throws on failure (validation or persistence);
   * callers on the hot path should use `recordProxyUsageSafely` instead
   * unless they specifically want the failure to propagate.
   */
  recordProxyUsage(input: RecordProxyUsageInput): Promise<UsageLog>;
}

export function createUsageRecorder(
  usageService: UsageService,
  pricingService: PricingService,
): UsageRecorder {
  return {
    async recordProxyUsage(input: RecordProxyUsageInput): Promise<UsageLog> {
      const { context, parsedResponse } = input;
      const modelUsed = parsedResponse.model ?? context.requestedModel ?? FALLBACK_MODEL;

      const pricing = pricingService.getModelPricing(context.provider, modelUsed);
      const cost = pricingService.calculateCost(parsedResponse.usage, pricing);

      return usageService.createUsageLog({
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
    },
  };
}

/**
 * Records usage without ever throwing. A pricing or persistence failure
 * must never turn a successful AI response into a failed one — but per
 * usageService's own contract, failures are never silently discarded
 * either: this logs the failure (request id, provider — no secrets, no
 * response content) so it stays visible to operators.
 */
export async function recordProxyUsageSafely(
  recorder: UsageRecorder,
  input: RecordProxyUsageInput,
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await recorder.recordProxyUsage(input);
  } catch (error) {
    logger.error(
      { err: error, requestId: input.context.requestId, provider: input.context.provider },
      "Failed to record proxy usage",
    );
  }
}
