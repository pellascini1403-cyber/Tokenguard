import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createKeysService } from "../../src/modules/keys/keys.service.js";
import type { LoopDetectionConfig } from "../../src/modules/loop-detection/types.js";
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

// A small threshold keeps these tests fast and their expectations easy
// to read: 2 identical requests allowed, the 3rd is a loop.
const TEST_LOOP_CONFIG: LoopDetectionConfig = {
  windowMs: 10_000,
  threshold: 2,
  blockDurationMs: 5_000,
  maxEntries: 1_000,
};

interface TestAppOptions {
  openaiUrl?: string;
  anthropicUrl?: string;
  loopDetection?: LoopDetectionConfig;
  logger?: ReturnType<typeof createLogCollector>["logger"];
}

async function buildTestApp(
  options: TestAppOptions = {},
): Promise<{ app: FastifyInstance; tokenGuardKey: string; store: FakeStore }> {
  const authClient = createFakeAuthClient({});
  const { client: adminClient, store } = createFakeAdminClient();
  const keysService = createKeysService(adminClient);
  const created = await keysService.createKey(ORG_ID, "loop detection test key");

  const app = buildApp({
    nodeEnv: "test",
    logger: options.logger,
    supabase: { authClient, adminClient },
    pricingTable: TEST_PRICING_TABLE,
    proxy: {
      openaiBaseUrl: options.openaiUrl ?? "http://127.0.0.1:1",
      anthropicBaseUrl: options.anthropicUrl ?? "http://127.0.0.1:1",
      requestTimeoutMs: 5_000,
      streamMaxDurationMs: 5_000,
      maxBodyBytes: 1_000_000,
    },
    loopDetection: options.loopDetection ?? TEST_LOOP_CONFIG,
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

const CHAT_PAYLOAD = JSON.stringify({
  model: "gpt-priced",
  messages: [{ role: "user", content: "Hello" }],
});

const OTHER_CHAT_PAYLOAD = JSON.stringify({
  model: "gpt-priced",
  messages: [{ role: "user", content: "what is the weather?" }],
});

const STREAM_CHAT_PAYLOAD = JSON.stringify({
  model: "gpt-priced",
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
});

const MESSAGES_PAYLOAD = JSON.stringify({
  model: "claude-priced",
  max_tokens: 100,
  messages: [{ role: "user", content: "Hello" }],
});

const STREAM_MESSAGES_PAYLOAD = JSON.stringify({
  model: "claude-priced",
  max_tokens: 100,
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
});

describe("agent loop detection — OpenAI, non-streaming", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("allows requests up to the threshold and blocks the next identical one with 429", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    const third = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: "AGENT_LOOP_DETECTED" } });

    // The provider never saw the blocked (3rd) request.
    expect(upstream.requests).toHaveLength(2);
  });

  it("includes a Retry-After header and no sensitive content on the blocked response", async () => {
    upstream = await startFakeUpstreamServer();
    ({ app, tokenGuardKey } = await buildTestApp({ openaiUrl: upstream.url }));

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("5");
    expect(blocked.headers["x-tokenguard-request-id"]).toBeTruthy();

    const bodyText = blocked.payload;
    expect(bodyText).not.toContain("sk-openai-secret-value");
    expect(bodyText).not.toContain(tokenGuardKey);
    expect(bodyText).not.toContain("Hello");
    expect(blocked.json()).toMatchObject({ error: { code: "AGENT_LOOP_DETECTED" } });
    expect(bodyText).not.toContain("signature");
    expect(bodyText).not.toContain("hash");
  });

  it("does not create a usage log for the blocked request", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    expect(store.token_logs).toHaveLength(2);

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });

    // Still 2 — the blocked 3rd request never produced a usage log.
    expect(store.token_logs).toHaveLength(2);
  });

  it("tracks a different request body independently (not the same loop)", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "chatcmpl-1", model: "gpt-priced" }),
    });
    ({ app, tokenGuardKey } = await buildTestApp({ openaiUrl: upstream.url }));

    // Exhaust CHAT_PAYLOAD's own threshold (2 allowed, 3rd blocked).
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    const chatBlocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    expect(chatBlocked.statusCode).toBe(429);

    // A different body, same org/key/provider/endpoint/model, is
    // completely unaffected by CHAT_PAYLOAD's exhausted count.
    const otherFirst = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: OTHER_CHAT_PAYLOAD,
    });
    const otherSecond = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: OTHER_CHAT_PAYLOAD,
    });
    expect(otherFirst.statusCode).toBe(200);
    expect(otherSecond.statusCode).toBe(200);

    // 2 from CHAT_PAYLOAD + 2 from OTHER_CHAT_PAYLOAD reached the provider;
    // CHAT_PAYLOAD's 3rd (blocked) did not.
    expect(upstream.requests).toHaveLength(4);
  });

  it("logs a structured warning without prompt/response/secret content when blocking", async () => {
    upstream = await startFakeUpstreamServer();
    const collector = createLogCollector();
    ({ app, tokenGuardKey } = await buildTestApp({
      openaiUrl: upstream.url,
      logger: collector.logger,
    }));

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: CHAT_PAYLOAD,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const logText = collector.lines().join("\n");
    expect(logText).toContain("AGENT_LOOP_DETECTED");
    expect(logText).not.toContain("sk-openai-secret-value");
    expect(logText).not.toContain(tokenGuardKey);
    expect(logText).not.toContain("Hello");
  });
});

describe("agent loop detection — OpenAI, streaming", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("blocks a repeated streaming request with 429 before contacting the provider", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () => ({
        kind: "sse" as const,
        chunks: ['data: {"id":"1","model":"gpt-priced","choices":[]}\n\n', "data: [DONE]\n\n"],
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    for (let i = 0; i < TEST_LOOP_CONFIG.threshold; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: CHAT_HEADERS(tokenGuardKey),
        payload: STREAM_CHAT_PAYLOAD,
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: STREAM_CHAT_PAYLOAD,
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "AGENT_LOOP_DETECTED" } });
    expect(blocked.headers["content-type"]).not.toContain("text/event-stream");
    expect(upstream.requests).toHaveLength(TEST_LOOP_CONFIG.threshold);
    expect(store.token_logs).toHaveLength(TEST_LOOP_CONFIG.threshold);
  });
});

describe("agent loop detection — Anthropic, non-streaming", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("allows requests up to the threshold and blocks the next identical one with 429", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "msg_1",
        model: "claude-priced",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    const first = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: MESSAGES_PAYLOAD,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: MESSAGES_PAYLOAD,
    });
    const third = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: MESSAGES_PAYLOAD,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: "AGENT_LOOP_DETECTED" } });
    expect(upstream.requests).toHaveLength(2);
    expect(store.token_logs).toHaveLength(2);
  });

  it("never forwards the blocked request's headers or key material upstream", async () => {
    upstream = await startFakeUpstreamServer();
    ({ app, tokenGuardKey } = await buildTestApp({ anthropicUrl: upstream.url }));

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: MESSAGES_PAYLOAD,
    });
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: MESSAGES_PAYLOAD,
    });
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: MESSAGES_PAYLOAD,
    });

    expect(upstream.requests).toHaveLength(2);
    for (const req of upstream.requests) {
      expect(req.headers["x-tokenguard-key"]).toBeUndefined();
    }
  });
});

describe("agent loop detection — Anthropic, streaming", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("blocks a repeated streaming request with 429 before contacting the provider", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () => ({
        kind: "sse" as const,
        chunks: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-priced","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ],
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    for (let i = 0; i < TEST_LOOP_CONFIG.threshold; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: MESSAGES_HEADERS(tokenGuardKey),
        payload: STREAM_MESSAGES_PAYLOAD,
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: STREAM_MESSAGES_PAYLOAD,
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "AGENT_LOOP_DETECTED" } });
    expect(upstream.requests).toHaveLength(TEST_LOOP_CONFIG.threshold);
    expect(store.token_logs).toHaveLength(TEST_LOOP_CONFIG.threshold);
  });
});

describe("agent loop detection — multi-tenant isolation", () => {
  it("never shares loop state between different organizations/keys, even with identical bodies", async () => {
    const upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "chatcmpl-1", model: "gpt-priced" }),
    });

    const authClient = createFakeAuthClient({});
    const { client: adminClient } = createFakeAdminClient();
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
        streamMaxDurationMs: 5_000,
        maxBodyBytes: 1_000_000,
      },
      loopDetection: TEST_LOOP_CONFIG,
    });

    // Exhaust org A's threshold.
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyA.apiKey),
      payload: CHAT_PAYLOAD,
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyA.apiKey),
      payload: CHAT_PAYLOAD,
    });
    const orgABlocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyA.apiKey),
      payload: CHAT_PAYLOAD,
    });
    expect(orgABlocked.statusCode).toBe(429);

    // Org B, same exact body, is unaffected — independent state.
    const orgBFirst = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyB.apiKey),
      payload: CHAT_PAYLOAD,
    });
    expect(orgBFirst.statusCode).toBe(200);

    await app.close();
    await upstream.close();
  });
});

describe("agent loop detection — does not interfere with normal traffic", () => {
  it("still forwards a single request to the provider under default configuration", async () => {
    const upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "chatcmpl-1", model: "gpt-4o" }),
    });
    const authClient = createFakeAuthClient({});
    const { client: adminClient } = createFakeAdminClient();
    const keysService = createKeysService(adminClient);
    const created = await keysService.createKey(ORG_ID, "default config key");

    const app = buildApp({
      nodeEnv: "test",
      supabase: { authClient, adminClient },
      proxy: {
        openaiBaseUrl: upstream.url,
        anthropicBaseUrl: upstream.url,
        requestTimeoutMs: 5_000,
        streamMaxDurationMs: 5_000,
        maxBodyBytes: 1_000_000,
      },
      // No loopDetection override — exercises real env-derived defaults.
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(created.apiKey),
      payload: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);

    await app.close();
    await upstream.close();
  });
});
