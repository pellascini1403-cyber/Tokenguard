import { describe, expect, it } from "vitest";
import { createPricingService } from "../../src/modules/pricing/pricing.service.js";
import type { ModelPricing } from "../../src/modules/pricing/types.js";
import type { NormalizedUsage } from "../../src/modules/providers/usage-types.js";

const TEST_TABLE: ModelPricing[] = [
  {
    provider: "openai",
    model: "gpt-test",
    inputPricePerMillionUsd: "2.00",
    outputPricePerMillionUsd: "8.00",
    currency: "USD",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveTo: null,
    pricingVersion: "test-v1",
  },
  {
    provider: "anthropic",
    model: "claude-test",
    inputPricePerMillionUsd: "3.00",
    outputPricePerMillionUsd: "15.00",
    currency: "USD",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveTo: null,
    pricingVersion: "test-v1",
  },
];

function usage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    source: "provider",
    ...overrides,
  };
}

describe("pricing service — lookup", () => {
  it("returns pricing for a known provider/model", () => {
    const service = createPricingService(TEST_TABLE);
    expect(service.getModelPricing("openai", "gpt-test")).toMatchObject({
      model: "gpt-test",
      pricingVersion: "test-v1",
    });
  });

  it("returns null for an unknown model", () => {
    const service = createPricingService(TEST_TABLE);
    expect(service.getModelPricing("openai", "gpt-does-not-exist")).toBeNull();
  });

  it("does not match a model against the wrong provider", () => {
    const service = createPricingService(TEST_TABLE);
    expect(service.getModelPricing("anthropic", "gpt-test")).toBeNull();
  });

  it("does not return an entry outside its effective date range", () => {
    const table: ModelPricing[] = [
      {
        provider: "openai",
        model: "gpt-old",
        inputPricePerMillionUsd: "1.00",
        outputPricePerMillionUsd: "1.00",
        currency: "USD",
        effectiveFrom: "2020-01-01T00:00:00.000Z",
        effectiveTo: "2020-06-01T00:00:00.000Z",
        pricingVersion: "test-expired",
      },
    ];
    const service = createPricingService(table);
    expect(service.getModelPricing("openai", "gpt-old")).toBeNull();
  });
});

describe("pricing service — cost calculation", () => {
  it("calculates input, output, and total cost for a known model", () => {
    const service = createPricingService(TEST_TABLE);
    const pricing = service.getModelPricing("openai", "gpt-test");
    const cost = service.calculateCost(
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      pricing,
    );

    expect(cost.inputCostUsd).toBe("2.00000000");
    expect(cost.outputCostUsd).toBe("8.00000000");
    expect(cost.totalCostUsd).toBe("10.00000000");
    expect(cost.pricingVersion).toBe("test-v1");
  });

  it("returns all-null costs when pricing is unavailable, without blocking", () => {
    const service = createPricingService(TEST_TABLE);
    const cost = service.calculateCost(usage(), null);

    expect(cost).toEqual({
      inputCostUsd: null,
      outputCostUsd: null,
      totalCostUsd: null,
      pricingVersion: null,
    });
  });

  it("calculates input cost only when output tokens are unknown", () => {
    const service = createPricingService(TEST_TABLE);
    const pricing = service.getModelPricing("openai", "gpt-test");
    const cost = service.calculateCost(
      usage({ inputTokens: 1_000_000, outputTokens: null, totalTokens: null }),
      pricing,
    );

    expect(cost.inputCostUsd).toBe("2.00000000");
    expect(cost.outputCostUsd).toBeNull();
    expect(cost.totalCostUsd).toBeNull();
  });

  it("calculates output cost only when input tokens are unknown", () => {
    const service = createPricingService(TEST_TABLE);
    const pricing = service.getModelPricing("openai", "gpt-test");
    const cost = service.calculateCost(
      usage({ inputTokens: null, outputTokens: 1_000_000, totalTokens: null }),
      pricing,
    );

    expect(cost.inputCostUsd).toBeNull();
    expect(cost.outputCostUsd).toBe("8.00000000");
    expect(cost.totalCostUsd).toBeNull();
  });

  it("returns null costs (but the resolved pricing version) when both token counts are unknown", () => {
    const service = createPricingService(TEST_TABLE);
    const pricing = service.getModelPricing("openai", "gpt-test");
    const cost = service.calculateCost(
      usage({ inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" }),
      pricing,
    );

    // pricingVersion still reflects that a pricing entry existed for this
    // model — it is null only when getModelPricing itself found nothing.
    expect(cost).toEqual({
      inputCostUsd: null,
      outputCostUsd: null,
      totalCostUsd: null,
      pricingVersion: "test-v1",
    });
  });

  it("computes exact decimal cost for small token counts without rounding error", () => {
    const service = createPricingService(TEST_TABLE);
    const pricing = service.getModelPricing("openai", "gpt-test");
    // 1 token at $2.00/million = 0.000002 USD exactly.
    const cost = service.calculateCost(
      usage({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
      pricing,
    );

    expect(cost.inputCostUsd).toBe("0.00000200");
    expect(cost.outputCostUsd).toBe("0.00000000");
    expect(cost.totalCostUsd).toBe("0.00000200");
  });

  it("uses a currency-safe decimal calculation, not float arithmetic", () => {
    // A classic float trap: 0.1 + 0.2 !== 0.3 in IEEE754. Pick token counts
    // that would expose this if plain `number` arithmetic were used.
    const table: ModelPricing[] = [
      {
        provider: "openai",
        model: "float-trap",
        inputPricePerMillionUsd: "0.1",
        outputPricePerMillionUsd: "0.2",
        currency: "USD",
        effectiveFrom: "2025-01-01T00:00:00.000Z",
        effectiveTo: null,
        pricingVersion: "test-v1",
      },
    ];
    const service = createPricingService(table);
    const pricing = service.getModelPricing("openai", "float-trap");
    const cost = service.calculateCost(
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }),
      pricing,
    );

    expect(cost.totalCostUsd).toBe("0.30000000");
  });
});
