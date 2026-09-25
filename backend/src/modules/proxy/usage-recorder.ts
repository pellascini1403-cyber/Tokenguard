import type { FastifyBaseLogger } from "fastify";
import type { BudgetService } from "../budget/budget.service.js";
import type { UsageLoggingService } from "../usage-logging/types.js";
import type { ParsedProviderResponse } from "../providers/usage-types.js";
import type { PricingService } from "../pricing/types.js";
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
 * Thrown by recordProxyUsage specifically when the Step 8 budget charge
 * (Phase B) failed. This is strictly more serious than an ordinary
 * failure: the organization's committed spend is now under-counted,
 * which can let a later admission check wrongly allow a request it
 * should have blocked. recordProxyUsageSafely logs this distinctly (and
 * at higher severity) from any other failure.
 *
 * Note what this is NOT: a failure to *queue* the usage-log write is
 * never thrown as an error at all (see usage-logging.service.ts) — it is
 * logged internally by that service and this function returns
 * normally. Only budget accounting is critical enough to propagate as a
 * distinguishable failure.
 */
export class BudgetAccountingFailedError extends Error {
  constructor(cause: unknown) {
    super("Budget accounting failed while recording proxy usage");
    this.name = "BudgetAccountingFailedError";
    this.cause = cause;
  }
}

export interface UsageRecorder {
  /**
   * Step 9 split this into two parts with different correctness
   * requirements, per the module's own architecture note below:
   *
   *  1. SYNCHRONOUS / CRITICAL — when a budget service is configured and
   *     the resulting cost is known, commits that cost against the
   *     organization's monthly budget (Step 8, Phase B) and awaits it.
   *     This must complete — and be visible to the next admission check
   *     — before this function returns, or the budget ledger could fall
   *     behind reality. Throws `BudgetAccountingFailedError` on failure.
   *  2. ASYNCHRONOUS / NON-CRITICAL — enqueues the token_logs row itself
   *     onto the usage-logging queue (Step 9) and returns without
   *     waiting for it to be persisted. A full queue is logged
   *     internally (see usage-logging.service.ts) and never turns into
   *     an error here — the provider response this usage describes has
   *     already succeeded by the time this runs, and a lost audit row is
   *     never worth failing that response over.
   *
   * Throws only for (1); callers on the hot path should use
   * `recordProxyUsageSafely` instead unless they specifically want a
   * budget-accounting failure to propagate.
   *
   * `logger` is optional so tests that only care about the accounting
   * outcome are unaffected; passing it enables the BUDGET_COST_UNKNOWN
   * observability event (below).
   */
  recordProxyUsage(input: RecordProxyUsageInput, logger?: FastifyBaseLogger): Promise<void>;
}

/**
 * Architecture note (Step 9): usage-log persistence (token_logs) and
 * budget accounting (organization_budget_periods/_charges) used to be
 * two steps of one synchronous write, in that order — the budget charge
 * literally could not happen until the token_logs row existed, because
 * organization_budget_charges.request_id had a foreign key to it (see
 * Step 8's migration). That made both writes block the client response.
 *
 * Step 9 needed to move token_logs persistence off the client-facing
 * path, but budget accounting has to stay synchronous: Step 8's
 * correctness relies on a committed charge being immediately visible to
 * the very next admission check, and deferring it onto the same
 * best-effort queue as the audit log would let an organization's budget
 * silently drift out of sync with reality. So the FK was removed (see
 * `20260928000000_decouple_budget_charge_from_token_logs.sql`) — the
 * budget charge no longer depends on token_logs existing at all, and the
 * two writes are now fully independent:
 *
 *   - The budget charge still runs synchronously, still atomically, and
 *     is still idempotent by request_id (Step 8's guarantees, unchanged).
 *   - The token_logs write is queued (Step 9) and may complete seconds
 *     later, out of order relative to the budget charge, or — in the
 *     worst case (queue saturation, or the process exiting before the
 *     worker drains) — not at all. That risk is scoped to the audit
 *     trail only; it can never cause a double charge, a missed charge,
 *     or cross-tenant leakage, because it never touches the budget
 *     ledger.
 */
export function createUsageRecorder(
  usageLoggingService: UsageLoggingService,
  pricingService: PricingService,
  budgetService?: BudgetService,
): UsageRecorder {
  return {
    async recordProxyUsage(
      input: RecordProxyUsageInput,
      logger?: FastifyBaseLogger,
    ): Promise<void> {
      const { context, parsedResponse } = input;
      const modelUsed = parsedResponse.model ?? context.requestedModel ?? FALLBACK_MODEL;

      const pricing = pricingService.getModelPricing(context.provider, modelUsed);
      const cost = pricingService.calculateCost(parsedResponse.usage, pricing);

      // Budget accounting (critical) is attempted first, but a failure
      // here must not suppress the (independent, non-critical) usage-log
      // enqueue below — the audit trail is exactly what operators would
      // want to reconcile a budget-accounting incident against, so it's
      // stashed and re-thrown only after the enqueue has happened.
      let budgetError: BudgetAccountingFailedError | null = null;

      if (budgetService) {
        if (cost.totalCostUsd === null) {
          // Unknown cost is never treated as $0 and never charged — only
          // reported, as safe metadata, so budget accounting's blind
          // spot stays observable rather than silent.
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
        } else {
          // Critical path: awaited, and a failure here is not
          // swallowed — see BudgetAccountingFailedError.
          try {
            await budgetService.commitCharge({
              organizationId: context.organizationId,
              requestId: context.requestId,
              periodStart: context.budgetPeriodStart,
              amountUsd: cost.totalCostUsd,
            });
          } catch (error) {
            budgetError = new BudgetAccountingFailedError(error);
          }
        }
      }

      // Non-critical path: enqueued, never awaited for persistence.
      // enqueue() itself never throws (see usage-logging.service.ts for
      // the queue-full case) — the provider response this describes has
      // already been decided by the time this line runs, and this is
      // attempted even if budget accounting above failed.
      usageLoggingService.enqueue({
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

      if (budgetError) {
        throw budgetError;
      }
    },
  };
}

/**
 * Records usage without ever throwing. Budget accounting is the only
 * failure mode that can still propagate out of `recordProxyUsage`
 * (usage-log persistence failures happen later, inside the async worker,
 * and are handled there) — but per that function's own contract,
 * failures are never silently discarded either: this logs them so they
 * stay visible to operators, at distinctly higher severity for a
 * BudgetAccountingFailedError than for anything else.
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
        "CRITICAL: budget accounting failed — organization spend may be under-counted",
      );
      return;
    }
    logger.error(
      { err: error, requestId: input.context.requestId, provider: input.context.provider },
      "Failed to record proxy usage",
    );
  }
}
