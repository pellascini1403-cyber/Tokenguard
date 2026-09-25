import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import {
  createBudgetService,
  type BudgetService,
} from "../../src/modules/budget/budget.service.js";
import { createUsageService } from "../../src/modules/usage/usage.service.js";
import { createPricingService } from "../../src/modules/pricing/pricing.service.js";
import type { ModelPricing } from "../../src/modules/pricing/types.js";
import {
  BudgetAccountingFailedError,
  createUsageRecorder,
  recordProxyUsageSafely,
  type RecordProxyUsageInput,
} from "../../src/modules/proxy/usage-recorder.js";
import type { ProxyRequestContext } from "../../src/modules/proxy/types.js";
import type { ParsedProviderResponse } from "../../src/modules/providers/usage-types.js";
import { createFakeAdminClient, type FakeStore } from "../helpers/fake-admin-client.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_ID = randomUUID();

const PRICING_TABLE: ModelPricing[] = [
  {
    provider: "openai",
    model: "gpt-priced",
    inputPricePerMillionUsd: "2.00",
    outputPricePerMillionUsd: "8.00",
    currency: "USD",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveTo: null,
    pricingVersion: "test-v1",
  },
];

function buildContext(overrides: Partial<ProxyRequestContext> = {}): ProxyRequestContext {
  return {
    requestId: randomUUID(),
    organizationId: ORG_ID,
    tokenGuardKeyId: KEY_ID,
    provider: "openai",
    requestedModel: "gpt-priced",
    startedAt: performance.now(),
    budgetPeriodStart: "2026-09-01",
    ...overrides,
  };
}

function buildSetup() {
  const { client, store } = createFakeAdminClient({
    organizations: [{ id: ORG_ID, name: "Org A", monthly_budget_usd: "500.00" }],
    token_guard_keys: [
      {
        id: KEY_ID,
        organization_id: ORG_ID,
        key_prefix: "prefix",
        key_hash: "hash",
        name: "key",
        revoked_at: null,
      },
    ],
  });
  const usageService = createUsageService(client);
  const pricingService = createPricingService(PRICING_TABLE);
  const recorder = createUsageRecorder(usageService, pricingService);
  return { store, recorder };
}

function buildInput(
  context: Partial<ProxyRequestContext>,
  parsedResponse: ParsedProviderResponse,
  overrides: Partial<RecordProxyUsageInput> = {},
): RecordProxyUsageInput {
  return {
    context: buildContext(context),
    statusCode: 200,
    durationMs: 42,
    parsedResponse,
    ...overrides,
  };
}

describe("usage recorder", () => {
  it("persists a token_logs row with normalized usage and calculated cost", async () => {
    const { store, recorder } = buildSetup();

    const log = await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            totalTokens: 2_000_000,
            source: "provider",
          },
        },
      ),
    );

    expect(log.inputCostUsd).toBe("2.00000000");
    expect(log.outputCostUsd).toBe("8.00000000");
    expect(log.totalCostUsd).toBe("10.00000000");
    expect(log.usageSource).toBe("provider");
    expect(log.pricingVersion).toBe("test-v1");
    expect(store.token_logs).toHaveLength(1);
  });

  it("persists null costs (never 0) for an unpriced model, and still succeeds", async () => {
    const { store, recorder } = buildSetup();

    const log = await recorder.recordProxyUsage(
      buildInput(
        { requestedModel: "gpt-unknown-model" },
        {
          model: "gpt-unknown-model",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, source: "provider" },
        },
      ),
    );

    expect(log.promptTokens).toBe(100);
    expect(log.inputCostUsd).toBeNull();
    expect(log.outputCostUsd).toBeNull();
    expect(log.totalCostUsd).toBeNull();
    expect(log.pricingVersion).toBeNull();
    expect(store.token_logs).toHaveLength(1);
  });

  it("persists null usage fields (never 0) when the response reported none", async () => {
    const { recorder } = buildSetup();

    const log = await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" },
        },
      ),
    );

    expect(log.promptTokens).toBeNull();
    expect(log.completionTokens).toBeNull();
    expect(log.totalTokens).toBeNull();
    expect(log.usageSource).toBe("unknown");
  });

  it("falls back to the requested model when the response omits one", async () => {
    const { recorder } = buildSetup();

    const log = await recorder.recordProxyUsage(
      buildInput(
        { requestedModel: "gpt-priced" },
        {
          model: null,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" },
        },
      ),
    );

    expect(log.modelUsed).toBe("gpt-priced");
  });

  it("persists the exact request id from the proxy context", async () => {
    const { recorder } = buildSetup();
    const requestId = randomUUID();

    const log = await recorder.recordProxyUsage(
      buildInput(
        { requestId },
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
    );

    expect(log.requestId).toBe(requestId);
  });

  it("persists a non-negative duration and the upstream status code", async () => {
    const { recorder } = buildSetup();

    const log = await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
        { statusCode: 429, durationMs: 17 },
      ),
    );

    expect(log.statusCode).toBe(429);
    expect(log.durationMs).toBe(17);
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps organization A's usage isolated from organization B", async () => {
    const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const keyB = randomUUID();
    const { client, store } = createFakeAdminClient({
      organizations: [
        { id: ORG_ID, name: "Org A", monthly_budget_usd: "500.00" },
        { id: orgB, name: "Org B", monthly_budget_usd: "500.00" },
      ],
      token_guard_keys: [
        {
          id: KEY_ID,
          organization_id: ORG_ID,
          key_prefix: "pA",
          key_hash: "hA",
          name: "A",
          revoked_at: null,
        },
        {
          id: keyB,
          organization_id: orgB,
          key_prefix: "pB",
          key_hash: "hB",
          name: "B",
          revoked_at: null,
        },
      ],
    });
    const recorder = createUsageRecorder(
      createUsageService(client),
      createPricingService(PRICING_TABLE),
    );

    await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
    );
    await recorder.recordProxyUsage(
      buildInput(
        { organizationId: orgB, tokenGuardKeyId: keyB },
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
    );

    expect(store.token_logs).toHaveLength(2);
    const orgIds = store.token_logs.map((row) => row.organization_id);
    expect(orgIds).toContain(ORG_ID);
    expect(orgIds).toContain(orgB);
    expect(new Set(orgIds).size).toBe(2);
  });
});

describe("recordProxyUsageSafely", () => {
  function fakeLogger(): FastifyBaseLogger {
    return { error: vi.fn() } as unknown as FastifyBaseLogger;
  }

  it("does not throw when the recorder fails", async () => {
    const failingRecorder = {
      recordProxyUsage: vi.fn().mockRejectedValue(new Error("db is down")),
    };
    const logger = fakeLogger();

    await expect(
      recordProxyUsageSafely(
        failingRecorder,
        buildInput(
          {},
          {
            model: "gpt-priced",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
          },
        ),
        logger,
      ),
    ).resolves.toBeUndefined();
  });

  it("logs the failure rather than hiding it silently", async () => {
    const failingRecorder = {
      recordProxyUsage: vi.fn().mockRejectedValue(new Error("db is down")),
    };
    const logger = fakeLogger();
    const requestId = randomUUID();

    await recordProxyUsageSafely(
      failingRecorder,
      buildInput(
        { requestId },
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
      logger,
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [logPayload] = vi.mocked(logger.error).mock.calls[0] as [Record<string, unknown>, string];
    expect(logPayload.requestId).toBe(requestId);
    expect(logPayload.provider).toBe("openai");
  });

  it("succeeds silently (no error logged) when the recorder succeeds", async () => {
    const { recorder } = buildSetup();
    const logger = fakeLogger();

    await recordProxyUsageSafely(
      recorder,
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
      logger,
    );

    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("usage recorder — Step 8 budget accounting (Phase B)", () => {
  function buildSetupWithBudget(): {
    store: FakeStore;
    recorder: ReturnType<typeof createUsageRecorder>;
    budgetService: BudgetService;
  } {
    const { client, store } = createFakeAdminClient({
      organizations: [{ id: ORG_ID, name: "Org A", monthly_budget_usd: "500.00" }],
      token_guard_keys: [
        {
          id: KEY_ID,
          organization_id: ORG_ID,
          key_prefix: "prefix",
          key_hash: "hash",
          name: "key",
          revoked_at: null,
        },
      ],
    });
    const usageService = createUsageService(client);
    const pricingService = createPricingService(PRICING_TABLE);
    const budgetService = createBudgetService(client);
    const recorder = createUsageRecorder(usageService, pricingService, budgetService);
    return { store, recorder, budgetService };
  }

  function fakeLogger(): FastifyBaseLogger {
    return { error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
  }

  it("commits the known cost against the organization's budget period", async () => {
    const { store, recorder } = buildSetupWithBudget();
    const requestId = randomUUID();

    await recorder.recordProxyUsage(
      buildInput(
        { requestId, budgetPeriodStart: "2026-09-01" },
        {
          model: "gpt-priced",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            totalTokens: 2_000_000,
            source: "provider",
          },
        },
      ),
    );

    expect(store.organization_budget_charges).toHaveLength(1);
    const charge = store.organization_budget_charges[0];
    expect(charge?.request_id).toBe(requestId);
    expect(charge?.amount_usd).toBe("10.00000000");
    const period = store.organization_budget_periods[0];
    expect(period?.committed_cost_usd).toBe("10.00000000");
  });

  it("never charges $0 and never commits anything when the cost is unknown (unpriced model)", async () => {
    const { store, recorder } = buildSetupWithBudget();
    const logger = fakeLogger();

    await recorder.recordProxyUsage(
      buildInput(
        { requestedModel: "gpt-unpriced" },
        {
          model: "gpt-unpriced",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" },
        },
      ),
      logger,
    );

    expect(store.organization_budget_charges).toHaveLength(0);
    expect(store.organization_budget_periods).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = vi.mocked(logger.warn).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(payload.errorCode).toBe("BUDGET_COST_UNKNOWN");
    expect(message).toContain("not counted toward the monthly budget");
  });

  it("does not call commitCharge or log BUDGET_COST_UNKNOWN when no budget service is configured", async () => {
    // The plain (no-budget) setup from the rest of this file — proves
    // Step 8 is purely additive and optional.
    const { recorder } = buildSetup();
    const logger = fakeLogger();

    await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
      logger,
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("is idempotent: calling recordProxyUsage's underlying charge twice for the same request_id never double-charges", async () => {
    const { store, budgetService } = buildSetupWithBudget();
    const requestId = randomUUID();
    store.token_logs.push({
      id: randomUUID(),
      organization_id: ORG_ID,
      token_guard_key_id: KEY_ID,
      provider: "openai",
      model_used: "gpt-priced",
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      input_cost_usd: "5.00000000",
      output_cost_usd: "5.00000000",
      total_cost_usd: "10.00000000",
      usage_source: "provider",
      pricing_version: "test-v1",
      duration_ms: 1,
      status_code: 200,
      request_id: requestId,
      created_at: new Date().toISOString(),
    });

    await budgetService.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: "2026-09-01",
      amountUsd: "10.00000000",
    });
    // Simulates a retried accounting call for the exact same request.
    await budgetService.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: "2026-09-01",
      amountUsd: "10.00000000",
    });

    expect(store.organization_budget_charges).toHaveLength(1);
    const period = store.organization_budget_periods[0];
    expect(period?.committed_cost_usd).toBe("10.00000000");
  });

  it("throws BudgetAccountingFailedError when the budget commit fails, without discarding the already-persisted usage log", async () => {
    const { client, store } = createFakeAdminClient({
      organizations: [{ id: ORG_ID, name: "Org A", monthly_budget_usd: "500.00" }],
      token_guard_keys: [
        {
          id: KEY_ID,
          organization_id: ORG_ID,
          key_prefix: "prefix2",
          key_hash: "hash2",
          name: "key",
          revoked_at: null,
        },
      ],
    });
    const usageService = createUsageService(client);
    const pricingService = createPricingService(PRICING_TABLE);
    const failingBudgetService: BudgetService = {
      checkAdmission: vi.fn(),
      commitCharge: vi.fn().mockRejectedValue(new Error("connection reset")),
    };
    const recorder = createUsageRecorder(usageService, pricingService, failingBudgetService);
    const requestId = randomUUID();

    await expect(
      recorder.recordProxyUsage(
        buildInput(
          { requestId },
          {
            model: "gpt-priced",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(BudgetAccountingFailedError);

    // The usage log itself was already persisted before the budget
    // commit was attempted — a budget-accounting failure never rolls
    // that back or hides it.
    expect(store.token_logs).toHaveLength(1);
    expect(store.token_logs[0]?.request_id).toBe(requestId);
  });

  it("recordProxyUsageSafely logs a distinct, high-severity message for a budget-accounting failure", async () => {
    const failingRecorder = {
      recordProxyUsage: vi
        .fn()
        .mockRejectedValue(new BudgetAccountingFailedError(new Error("db down"))),
    };
    const logger = fakeLogger();
    const requestId = randomUUID();

    await recordProxyUsageSafely(
      failingRecorder,
      buildInput(
        { requestId },
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
      logger,
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = vi.mocked(logger.error).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(payload.requestId).toBe(requestId);
    expect(message).toContain("CRITICAL");
    expect(message).toContain("budget accounting failed");
  });
});
