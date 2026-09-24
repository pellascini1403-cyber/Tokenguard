import type { Provider } from "../usage/types.js";
import type { NormalizedUsage } from "../providers/usage-types.js";

/**
 * One entry in TokenGuard's own pricing snapshot (src/modules/pricing/
 * pricing-table.ts) — not a live feed from the provider. `pricingVersion`
 * identifies which snapshot an entry belongs to; a usage log persists the
 * version it was priced with, so updating this table later never rewrites
 * a historical row's cost (see the migration comment on
 * token_logs.pricing_version).
 */
export interface ModelPricing {
  provider: Provider;
  /** Matched against the model TokenGuard resolves for a request (see
   * providers usage parsers) — exact string match, no wildcards. */
  model: string;
  /** Decimal string: USD per 1,000,000 input tokens. */
  inputPricePerMillionUsd: string;
  /** Decimal string: USD per 1,000,000 output tokens. */
  outputPricePerMillionUsd: string;
  currency: "USD";
  /** ISO 8601 date this price became effective. */
  effectiveFrom: string;
  /** ISO 8601 date this price stopped applying, or null if still current. */
  effectiveTo: string | null;
  /** Identifies this pricing snapshot/table revision — persisted on every
   * usage log this entry prices. */
  pricingVersion: string;
}

/**
 * The result of pricing one request's usage. Any field is `null` when it
 * cannot be safely calculated — an unknown token count, or no pricing
 * entry for the model — never a fabricated 0.
 */
export interface CalculatedCost {
  inputCostUsd: string | null;
  outputCostUsd: string | null;
  totalCostUsd: string | null;
  /** The pricing entry's version, or null when no pricing was available. */
  pricingVersion: string | null;
}

export interface PricingService {
  /** Fast, synchronous, in-memory lookup — never queries Supabase or an
   * external service on the request path. Returns null for a model
   * TokenGuard has no pricing entry for; callers must not fail the
   * request over this, only leave costs null. */
  getModelPricing(provider: Provider, model: string): ModelPricing | null;
  /** Computes cost from normalized usage and a (possibly null) pricing
   * entry, using decimal arithmetic throughout. */
  calculateCost(usage: NormalizedUsage, pricing: ModelPricing | null): CalculatedCost;
}
