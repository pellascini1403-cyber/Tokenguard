import type { ModelPricing } from "./types.js";

/**
 * TokenGuard's maintained pricing snapshot — NOT a live feed from OpenAI
 * or Anthropic. Every entry's `pricingVersion` is this constant; a usage
 * log persists it at insert time, so updating this table later never
 * rewrites a historical row's cost (see the migration comment on
 * token_logs.pricing_version).
 *
 * These figures are illustrative list prices as of this snapshot's
 * creation and are NOT guaranteed current — verify against each
 * provider's own pricing page and refresh this file (with a new
 * PRICING_VERSION) before relying on it for real billing. A model absent
 * from this table is not an error: requests still proceed, only its
 * costs stay null (see pricing.service.ts).
 */
export const PRICING_VERSION = "tokenguard-pricing-snapshot-2025-01";

const EFFECTIVE_FROM = "2025-01-01T00:00:00.000Z";

export const DEFAULT_PRICING_TABLE: ModelPricing[] = [
  {
    provider: "openai",
    model: "gpt-4o",
    inputPricePerMillionUsd: "2.50",
    outputPricePerMillionUsd: "10.00",
    currency: "USD",
    effectiveFrom: EFFECTIVE_FROM,
    effectiveTo: null,
    pricingVersion: PRICING_VERSION,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPricePerMillionUsd: "0.15",
    outputPricePerMillionUsd: "0.60",
    currency: "USD",
    effectiveFrom: EFFECTIVE_FROM,
    effectiveTo: null,
    pricingVersion: PRICING_VERSION,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    inputPricePerMillionUsd: "3.00",
    outputPricePerMillionUsd: "15.00",
    currency: "USD",
    effectiveFrom: EFFECTIVE_FROM,
    effectiveTo: null,
    pricingVersion: PRICING_VERSION,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputPricePerMillionUsd: "0.80",
    outputPricePerMillionUsd: "4.00",
    currency: "USD",
    effectiveFrom: EFFECTIVE_FROM,
    effectiveTo: null,
    pricingVersion: PRICING_VERSION,
  },
];
