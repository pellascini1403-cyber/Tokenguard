import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createKeysService } from "../../src/modules/keys/keys.service.js";
import { createPricingService } from "../../src/modules/pricing/pricing.service.js";
import type { ModelPricing } from "../../src/modules/pricing/types.js";
import { createFakeAdminClient, type FakeStore } from "../helpers/fake-admin-client.js";
import { createFakeAuthClient } from "../helpers/fake-auth-client.js";
import { createLogCollector } from "../helpers/log-collector.js";
import {
  startFakeUpstreamServer,
  type FakeUpstreamServer,
} from "../helpers/fake-upstream-server.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TEST_PRICING_TABLE: ModelPricing[] = [
  {
    provider: "openai",
    model: "gpt-priced",
    inputPricePerMillionUsd: "2.00",
    outputPricePerMillionUsd: "8.00",
    currency: "USD",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveTo: null,
    pricingVersion: "test-pricing-v1",
  },
  {
    provider: "anthropic",
    model: "claude-priced",
    inputPricePerMillionUsd: "3.00",
    outputPricePerMillionUsd: "15.00",
    currency: "USD",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveTo: null,
    pricingVersion: "test-pricing-v1",
  },
];

interface TestAppOptions {
  openaiUrl?: string;
  anthropicUrl?: string;
  pricingTable?: ModelPricing[];
  logger?: ReturnType<typeof createLogCollector>["logger"];
}

async function buildTestApp(
  options: TestAppOptions = {},
): Promise<{ app: FastifyInstance; tokenGuardKey: string; store: FakeStore }> {
  const authClient = createFakeAuthClient({});
  const { client: adminClient, store } = createFakeAdminClient();
  const keysService = createKeysService(adminClient);
  const created = await keysService.createKey(ORG_ID, "usage test key");

  const app = buildApp({
    nodeEnv: "test",
    logger: options.logger,
    supabase: { authClient, adminClient },
    pricingTable: options.pricingTable ?? TEST_PRICING_TABLE,
    proxy: {
      openaiBaseUrl: options.openaiUrl ?? "http://127.0.0.1:1",
      anthropicBaseUrl: options.anthropicUrl ?? "http://127.0.0.1:1",
      requestTimeoutMs: 5_000,
      maxBodyBytes: 1_000_000,
    },
  });

  return { app, tokenGuardKey: created.apiKey, store };
}

const CHAT_HEADERS = (tokenGuardKey: string) => ({
  "content-type": "application/json",
  authorization: "Bearer sk-openai-secret-value",
  "x-tokenguard-key": tokenGuardKey,
});

const MESSAGES_HEADERS = (tokenGuardKey: string) => ({
  "content-type": "application/json",
  "x-api-key": "sk-ant-secret-value",
  "x-tokenguard-key": tokenGuardKey,
});

describe("usage tracking — OpenAI", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("persists normalized usage and calculated cost for a priced model", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.statusCode).toBe(200);
    expect(store.token_logs).toHaveLength(1);
    const row = store.token_logs[0];
    expect(row).toMatchObject({
      provider: "openai",
      model_used: "gpt-priced",
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
      input_cost_usd: "2.00000000",
      output_cost_usd: "8.00000000",
      total_cost_usd: "10.00000000",
      usage_source: "provider",
      pricing_version: "test-pricing-v1",
      status_code: 200,
      organization_id: ORG_ID,
    });
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("persists null usage (never 0) when the response has no usage object", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "chatcmpl-1", model: "gpt-priced" }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [] }),
    });

    const row = store.token_logs[0];
    expect(row?.prompt_tokens).toBeNull();
    expect(row?.completion_tokens).toBeNull();
    expect(row?.total_tokens).toBeNull();
    expect(row?.input_cost_usd).toBeNull();
    expect(row?.output_cost_usd).toBeNull();
    expect(row?.total_cost_usd).toBeNull();
    expect(row?.usage_source).toBe("unknown");
  });

  it("does not block the request or fabricate a cost for a model with no pricing entry", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-brand-new-unpriced-model",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "gpt-brand-new-unpriced-model", messages: [] }),
    });

    expect(res.statusCode).toBe(200);
    const row = store.token_logs[0];
    expect(row?.prompt_tokens).toBe(10);
    expect(row?.total_tokens).toBe(15);
    expect(row?.input_cost_usd).toBeNull();
    expect(row?.output_cost_usd).toBeNull();
    expect(row?.total_cost_usd).toBeNull();
    expect(row?.pricing_version).toBeNull();
  });

  it("persists the request id matching X-TokenGuard-Request-Id", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [] }),
    });

    const requestId = res.headers["x-tokenguard-request-id"];
    expect(store.token_logs[0]?.request_id).toBe(requestId);
  });

  it("does not create a usage log for a request that never reached the provider (missing TokenGuard key)", async () => {
    upstream = await startFakeUpstreamServer();
    ({ app, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: "Bearer sk-openai-test" },
      payload: JSON.stringify({ model: "gpt-priced", messages: [] }),
    });

    expect(res.statusCode).toBe(401);
    expect(store.token_logs).toHaveLength(0);
  });

  it("does not create a usage log when streaming is rejected", async () => {
    upstream = await startFakeUpstreamServer();
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "gpt-priced", stream: true, messages: [] }),
    });

    expect(res.statusCode).toBe(501);
    expect(store.token_logs).toHaveLength(0);
  });

  it("does not persist secrets, prompt, or response content in the usage log", async () => {
    const promptMarker = "MARKER-PROMPT-CONTENT";
    const responseMarker = "MARKER-RESPONSE-CONTENT";
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        choices: [{ message: { content: responseMarker } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({
        model: "gpt-priced",
        messages: [{ role: "user", content: promptMarker }],
      }),
    });

    const row = store.token_logs[0];
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(promptMarker);
    expect(serialized).not.toContain(responseMarker);
    expect(serialized).not.toContain("sk-openai-secret-value");
    expect(serialized).not.toContain(tokenGuardKey);
    expect(row).not.toHaveProperty("authorization");
    expect(row).not.toHaveProperty("x-api-key");
  });
});

describe("usage tracking — Anthropic", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("persists normalized usage and calculated cost for a priced model", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "msg_1",
        model: "claude-priced",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "claude-priced", max_tokens: 100, messages: [] }),
    });

    expect(res.statusCode).toBe(200);
    const row = store.token_logs[0];
    expect(row).toMatchObject({
      provider: "anthropic",
      model_used: "claude-priced",
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
      input_cost_usd: "3.00000000",
      output_cost_usd: "15.00000000",
      total_cost_usd: "18.00000000",
      usage_source: "provider",
      pricing_version: "test-pricing-v1",
    });
  });

  it("computes totalTokens only when both input and output are known", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "msg_1", model: "claude-priced", usage: { input_tokens: 42 } }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "claude-priced", max_tokens: 100, messages: [] }),
    });

    const row = store.token_logs[0];
    expect(row?.prompt_tokens).toBe(42);
    expect(row?.completion_tokens).toBeNull();
    expect(row?.total_tokens).toBeNull();
    // Input cost is still calculable from the known half.
    expect(row?.input_cost_usd).toBe("0.00012600");
    expect(row?.output_cost_usd).toBeNull();
    expect(row?.total_cost_usd).toBeNull();
  });

  it("persists null usage (never 0) when the response has no usage object", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "msg_1", model: "claude-priced" }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "claude-priced", max_tokens: 100, messages: [] }),
    });

    const row = store.token_logs[0];
    expect(row?.prompt_tokens).toBeNull();
    expect(row?.usage_source).toBe("unknown");
  });

  it("preserves the upstream status code for a provider-side error response", async () => {
    upstream = await startFakeUpstreamServer({
      status: 400,
      body: JSON.stringify({ type: "error", error: { message: "invalid request" } }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "claude-priced", max_tokens: 100, messages: [] }),
    });

    expect(res.statusCode).toBe(400);
    const row = store.token_logs[0];
    expect(row?.status_code).toBe(400);
    expect(row?.usage_source).toBe("unknown");
  });
});

describe("usage tracking — multi-tenant isolation", () => {
  it("never associates one organization's proxy usage with another organization", async () => {
    const upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    });

    const authClient = createFakeAuthClient({});
    const { client: adminClient, store } = createFakeAdminClient();
    const keysService = createKeysService(adminClient);
    const orgA = ORG_ID;
    const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const keyA = await keysService.createKey(orgA, "org A key");
    const keyB = await keysService.createKey(orgB, "org B key");

    const app = buildApp({
      nodeEnv: "test",
      supabase: { authClient, adminClient },
      pricingTable: TEST_PRICING_TABLE,
      proxy: {
        openaiBaseUrl: upstream.url,
        anthropicBaseUrl: upstream.url,
        requestTimeoutMs: 5_000,
        maxBodyBytes: 1_000_000,
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyA.apiKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [] }),
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyB.apiKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [] }),
    });

    expect(store.token_logs).toHaveLength(2);
    const logForA = store.token_logs.find((row) => row.token_guard_key_id === keyA.id);
    const logForB = store.token_logs.find((row) => row.token_guard_key_id === keyB.id);
    expect(logForA?.organization_id).toBe(orgA);
    expect(logForB?.organization_id).toBe(orgB);
    expect(logForA?.organization_id).not.toBe(logForB?.organization_id);

    await app.close();
    await upstream.close();
  });
});

describe("usage tracking — historical pricing", () => {
  it("keeps a persisted log's cost unchanged after the pricing table is updated", async () => {
    const upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      }),
    });
    const { app, tokenGuardKey, store } = await buildTestApp({
      openaiUrl: upstream.url,
      pricingTable: TEST_PRICING_TABLE,
    });

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [] }),
    });

    const originalCost = store.token_logs[0]?.total_cost_usd;
    expect(originalCost).toBe("10.00000000");

    // Simulate a future price change: a new pricing table/version for the
    // same model would compute a very different cost...
    const updatedPricingTable: ModelPricing[] = [
      {
        ...TEST_PRICING_TABLE[0]!,
        inputPricePerMillionUsd: "999.00",
        pricingVersion: "test-pricing-v2",
      },
    ];
    const updatedPricingService = createPricingService(updatedPricingTable);
    const newPricing = updatedPricingService.getModelPricing("openai", "gpt-priced");
    const wouldBeCostNow = updatedPricingService.calculateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        source: "provider",
      },
      newPricing,
    );
    expect(wouldBeCostNow.totalCostUsd).not.toBe(originalCost);

    // ...but the row already persisted is untouched: nothing re-reads or
    // recalculates it. The dashboard (a later step) must show what this
    // request actually cost at the time, not today's price.
    expect(store.token_logs[0]?.total_cost_usd).toBe(originalCost);
    expect(store.token_logs[0]?.pricing_version).toBe("test-pricing-v1");

    await app.close();
    await upstream.close();
  });
});
