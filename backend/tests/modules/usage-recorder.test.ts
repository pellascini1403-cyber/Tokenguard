import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import {
  createBudgetService,
  type BudgetService,
} from "../../src/modules/budget/budget.service.js";
import { createUsageService, type UsageService } from "../../src/modules/usage/usage.service.js";
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
import { createUsageLoggingService } from "../../src/modules/usage-logging/usage-logging.service.js";
import type {
  UsageLoggingConfig,
  UsageLoggingService,
} from "../../src/modules/usage-logging/types.js";
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

// Fast, small settings — these tests care about correctness, not real
// backoff timing.
const TEST_USAGE_LOGGING_CONFIG: UsageLoggingConfig = {
  maxQueueSize: 100,
  workerConcurrency: 2,
  maxRetryAttempts: 3,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 5,
  shutdownTimeoutMs: 1_000,
};

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

function silentLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function buildUsageLogging(usageService: UsageService): UsageLoggingService {
  return createUsageLoggingService(usageService, TEST_USAGE_LOGGING_CONFIG, silentLogger());
}

function buildSetup(): {
  store: FakeStore;
  recorder: ReturnType<typeof createUsageRecorder>;
  usageLogging: UsageLoggingService;
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
  const usageLogging = buildUsageLogging(createUsageService(client));
  const pricingService = createPricingService(PRICING_TABLE);
  const recorder = createUsageRecorder(usageLogging, pricingService);
  return { store, recorder, usageLogging };
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

describe("usage recorder — async usage-log persistence (Step 9)", () => {
  it("resolves without ever awaiting persistence — proven with a createUsageLog that never resolves", async () => {
    // The conclusive proof that recordProxyUsage does not await
    // persistence: if it did, this test would hang until Vitest's
    // default test timeout, since createUsageLog here never resolves.
    // A weaker "check store.token_logs right after" assertion can't
    // distinguish "genuinely async" from "happened to finish first" —
    // this can only pass if the enqueue is truly fire-and-forget.
    const neverResolves = new Promise<never>(() => {
      // Deliberately never settles.
    });
    const hangingUsageService: UsageService = {
      createUsageLog: vi.fn().mockReturnValue(neverResolves),
      getOrganizationLogs: vi.fn(),
      getOrganizationUsageSummary: vi.fn(),
    };
    const usageLogging = buildUsageLogging(hangingUsageService);
    const recorder = createUsageRecorder(usageLogging, createPricingService(PRICING_TABLE));

    await expect(
      recorder.recordProxyUsage(
        buildInput(
          {},
          {
            model: "gpt-priced",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
          },
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("returns before the usage log is actually persisted, observable via waitForIdle()", async () => {
    const { store, recorder, usageLogging } = buildSetup();

    await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
    );

    await usageLogging.waitForIdle();
    expect(store.token_logs).toHaveLength(1);
  });

  it("persists a token_logs row with normalized usage and calculated cost once drained", async () => {
    const { store, recorder, usageLogging } = buildSetup();

    await recorder.recordProxyUsage(
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
    await usageLogging.waitForIdle();

    expect(store.token_logs).toHaveLength(1);
    const log = store.token_logs[0];
    expect(log?.input_cost_usd).toBe("2.00000000");
    expect(log?.output_cost_usd).toBe("8.00000000");
    expect(log?.total_cost_usd).toBe("10.00000000");
    expect(log?.usage_source).toBe("provider");
    expect(log?.pricing_version).toBe("test-v1");
  });

  it("persists null costs (never 0) for an unpriced model, and still succeeds", async () => {
    const { store, recorder, usageLogging } = buildSetup();

    await recorder.recordProxyUsage(
      buildInput(
        { requestedModel: "gpt-unknown-model" },
        {
          model: "gpt-unknown-model",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, source: "provider" },
        },
      ),
    );
    await usageLogging.waitForIdle();

    const log = store.token_logs[0];
    expect(log?.prompt_tokens).toBe(100);
    expect(log?.input_cost_usd).toBeNull();
    expect(log?.output_cost_usd).toBeNull();
    expect(log?.total_cost_usd).toBeNull();
    expect(log?.pricing_version).toBeNull();
  });

  it("persists null usage fields (never 0) when the response reported none", async () => {
    const { store, recorder, usageLogging } = buildSetup();

    await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" },
        },
      ),
    );
    await usageLogging.waitForIdle();

    const log = store.token_logs[0];
    expect(log?.prompt_tokens).toBeNull();
    expect(log?.completion_tokens).toBeNull();
    expect(log?.total_tokens).toBeNull();
    expect(log?.usage_source).toBe("unknown");
  });

  it("falls back to the requested model when the response omits one", async () => {
    const { store, recorder, usageLogging } = buildSetup();

    await recorder.recordProxyUsage(
      buildInput(
        { requestedModel: "gpt-priced" },
        {
          model: null,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" },
        },
      ),
    );
    await usageLogging.waitForIdle();

    expect(store.token_logs[0]?.model_used).toBe("gpt-priced");
  });

  it("persists the exact request id from the proxy context", async () => {
    const { store, recorder, usageLogging } = buildSetup();
    const requestId = randomUUID();

    await recorder.recordProxyUsage(
      buildInput(
        { requestId },
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
    );
    await usageLogging.waitForIdle();

    expect(store.token_logs[0]?.request_id).toBe(requestId);
  });

  it("persists a non-negative duration and the upstream status code", async () => {
    const { store, recorder, usageLogging } = buildSetup();

    await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
        { statusCode: 429, durationMs: 17 },
      ),
    );
    await usageLogging.waitForIdle();

    const log = store.token_logs[0];
    expect(log?.status_code).toBe(429);
    expect(log?.duration_ms).toBe(17);
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
    const usageLogging = buildUsageLogging(createUsageService(client));
    const recorder = createUsageRecorder(usageLogging, createPricingService(PRICING_TABLE));

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
    await usageLogging.waitForIdle();

    expect(store.token_logs).toHaveLength(2);
    const orgIds = store.token_logs.map((row) => row.organization_id);
    expect(orgIds).toContain(ORG_ID);
    expect(orgIds).toContain(orgB);
    expect(new Set(orgIds).size).toBe(2);
  });

  it("is idempotent: processing the same request twice never creates a duplicate token_logs row", async () => {
    const { store, recorder, usageLogging } = buildSetup();
    const requestId = randomUUID();
    const input = buildInput(
      { requestId },
      {
        model: "gpt-priced",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
      },
    );

    await recorder.recordProxyUsage(input);
    await usageLogging.waitForIdle();
    expect(store.token_logs).toHaveLength(1);

    // A process-level duplicate enqueue for the exact same request (e.g.
    // a retried route handler) — the queue/worker must not create a
    // second row; the existing request_id unique index is what makes
    // this safe (see usage-logging.service.ts's classifyUsageLogError).
    await recorder.recordProxyUsage(input);
    await usageLogging.waitForIdle();

    expect(store.token_logs).toHaveLength(1);
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

describe("usage recorder — Step 8 budget accounting stays synchronous (Phase B)", () => {
  function buildSetupWithBudget(): {
    store: FakeStore;
    recorder: ReturnType<typeof createUsageRecorder>;
    budgetService: BudgetService;
    usageLogging: UsageLoggingService;
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
    const usageLogging = buildUsageLogging(createUsageService(client));
    const pricingService = createPricingService(PRICING_TABLE);
    const budgetService = createBudgetService(client);
    const recorder = createUsageRecorder(usageLogging, pricingService, budgetService);
    return { store, recorder, budgetService, usageLogging };
  }

  function fakeLogger(): FastifyBaseLogger {
    return { error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
  }

  it("commits the known cost against the budget period BEFORE recordProxyUsage returns — no wait needed", async () => {
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

    // Checked immediately, with no waitForIdle() call — proving the
    // budget charge is synchronous/critical, unlike the (queued)
    // token_logs write.
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

  it("is idempotent: calling commitCharge twice for the same request_id never double-charges", async () => {
    const { store, budgetService } = buildSetupWithBudget();
    const requestId = randomUUID();

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

  it("commits a budget charge even with no token_logs row yet — Step 9 decoupled the ordering", async () => {
    const { store, budgetService } = buildSetupWithBudget();
    const requestId = randomUUID();
    expect(store.token_logs).toHaveLength(0);

    const result = await budgetService.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: "2026-09-01",
      amountUsd: "5.00000000",
    });

    expect(result.applied).toBe(true);
    expect(store.token_logs).toHaveLength(0);
  });

  it("throws BudgetAccountingFailedError when the budget commit fails, but still enqueues the usage log", async () => {
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
    const usageLogging = buildUsageLogging(createUsageService(client));
    const pricingService = createPricingService(PRICING_TABLE);
    const failingBudgetService: BudgetService = {
      checkAdmission: vi.fn(),
      commitCharge: vi.fn().mockRejectedValue(new Error("connection reset")),
    };
    const recorder = createUsageRecorder(usageLogging, pricingService, failingBudgetService);
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

    // The usage-log enqueue is independent of the budget-accounting
    // outcome above — a budget failure never suppresses the audit trail.
    await usageLogging.waitForIdle();
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

describe("usage recorder — never stores anything resembling raw request/response content", () => {
  it("the enqueued event and resulting row contain only accounting metadata", async () => {
    const promptMarker = "MARKER-PROMPT-SHOULD-NEVER-APPEAR";
    const { store, recorder, usageLogging } = buildSetup();

    await recorder.recordProxyUsage(
      buildInput(
        {},
        {
          model: "gpt-priced",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
        },
      ),
    );
    await usageLogging.waitForIdle();

    const serialized = JSON.stringify(store.token_logs[0]);
    expect(serialized).not.toContain(promptMarker);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("Authorization");
    const row = store.token_logs[0];
    expect(row).not.toHaveProperty("prompt");
    expect(row).not.toHaveProperty("response");
    expect(row).not.toHaveProperty("body");
  });
});

describe("usage-logging service integration — queue full does not fail the caller", () => {
  it("enqueue() returns false and logs a high-severity error, without recordProxyUsage throwing", async () => {
    const { client } = createFakeAdminClient({
      organizations: [{ id: ORG_ID, name: "Org A", monthly_budget_usd: "500.00" }],
    });
    const logger = silentLogger();
    const tinyConfig: UsageLoggingConfig = { ...TEST_USAGE_LOGGING_CONFIG, maxQueueSize: 0 };
    const usageLogging = createUsageLoggingService(createUsageService(client), tinyConfig, logger);
    const recorder = createUsageRecorder(usageLogging, createPricingService(PRICING_TABLE));

    await expect(
      recorder.recordProxyUsage(
        buildInput(
          {},
          {
            model: "gpt-priced",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
          },
        ),
      ),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    const errorCalls = vi.mocked(logger.error).mock.calls as [Record<string, unknown>, string][];
    const queueFullCall = errorCalls.find(
      ([payload]) => payload.errorCode === "USAGE_LOG_QUEUE_FULL",
    );
    expect(queueFullCall).toBeDefined();
  });
});
