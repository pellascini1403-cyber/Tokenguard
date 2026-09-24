import { Decimal } from "decimal.js";
import type { NormalizedUsage } from "../providers/usage-types.js";
import type { Provider } from "../usage/types.js";
import { DEFAULT_PRICING_TABLE } from "./pricing-table.js";
import type { CalculatedCost, ModelPricing, PricingService } from "./types.js";

const COST_DECIMAL_PLACES = 8;
const TOKENS_PER_MILLION = 1_000_000;

function isActive(entry: ModelPricing, at: Date): boolean {
  const from = new Date(entry.effectiveFrom);
  const to = entry.effectiveTo ? new Date(entry.effectiveTo) : null;
  return from <= at && (to === null || to > at);
}

/**
 * A plain in-memory lookup — no I/O, no Supabase query, safe to call on
 * every proxied request. `table` defaults to TokenGuard's maintained
 * snapshot but can be overridden (tests inject a small deterministic
 * table instead of depending on real, changeable price figures).
 */
export function createPricingService(
  table: ModelPricing[] = DEFAULT_PRICING_TABLE,
): PricingService {
  return {
    getModelPricing(provider: Provider, model: string): ModelPricing | null {
      const now = new Date();
      const candidates = table.filter(
        (entry) => entry.provider === provider && entry.model === model && isActive(entry, now),
      );
      if (candidates.length === 0) {
        return null;
      }
      // Most recently effective entry wins if more than one somehow matches.
      return candidates.reduce((latest, entry) =>
        new Date(entry.effectiveFrom) > new Date(latest.effectiveFrom) ? entry : latest,
      );
    },

    calculateCost(usage: NormalizedUsage, pricing: ModelPricing | null): CalculatedCost {
      if (!pricing) {
        return {
          inputCostUsd: null,
          outputCostUsd: null,
          totalCostUsd: null,
          pricingVersion: null,
        };
      }

      const inputCost =
        usage.inputTokens !== null
          ? new Decimal(usage.inputTokens)
              .dividedBy(TOKENS_PER_MILLION)
              .times(pricing.inputPricePerMillionUsd)
          : null;
      const outputCost =
        usage.outputTokens !== null
          ? new Decimal(usage.outputTokens)
              .dividedBy(TOKENS_PER_MILLION)
              .times(pricing.outputPricePerMillionUsd)
          : null;
      // Total is only known when both halves are — never sum a known cost
      // with an assumed zero for the unknown half.
      const totalCost =
        inputCost !== null && outputCost !== null ? inputCost.plus(outputCost) : null;

      return {
        inputCostUsd: inputCost !== null ? inputCost.toFixed(COST_DECIMAL_PLACES) : null,
        outputCostUsd: outputCost !== null ? outputCost.toFixed(COST_DECIMAL_PLACES) : null,
        totalCostUsd: totalCost !== null ? totalCost.toFixed(COST_DECIMAL_PLACES) : null,
        pricingVersion: pricing.pricingVersion,
      };
    },
  };
}
