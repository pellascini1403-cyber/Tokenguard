import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { createUsageService } from "../../src/modules/usage/usage.service.js";
import { createPricingService } from "../../src/modules/pricing/pricing.service.js";
import type { ModelPricing } from "../../src/modules/pricing/types.js";
import {
  createUsageRecorder,
  recordProxyUsageSafely,
  type RecordProxyUsageInput,
} from "../../src/modules/proxy/usage-recorder.js";
import type { ProxyRequestContext } from "../../src/modules/proxy/types.js";
import type { ParsedProviderResponse } from "../../src/modules/providers/usage-types.js";
import { createFakeAdminClient } from "../helpers/fake-admin-client.js";

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
