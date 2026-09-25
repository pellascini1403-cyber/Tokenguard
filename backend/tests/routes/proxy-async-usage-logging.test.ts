import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createKeysService } from "../../src/modules/keys/keys.service.js";
import type { UsageLoggingConfig } from "../../src/modules/usage-logging/types.js";
import type { ModelPricing } from "../../src/modules/pricing/types.js";
import { createFakeAdminClient, type FakeStore } from "../helpers/fake-admin-client.js";
import { createFakeAuthClient } from "../helpers/fake-auth-client.js";
import { createLogCollector } from "../helpers/log-collector.js";
import { createGate, withDelayedTokenLogsInsert } from "../helpers/delayed-admin-client.js";
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

const FAST_USAGE_LOGGING_CONFIG: UsageLoggingConfig = {
  maxQueueSize: 100,
  workerConcurrency: 2,
  maxRetryAttempts: 3,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 5,
  shutdownTimeoutMs: 2_000,
};

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

interface BuiltDelayedApp {
  app: FastifyInstance;
  tokenGuardKey: string;
  store: FakeStore;
  openGate: () => void;
}

async function buildDelayedApp(options: {
  openaiUrl?: string;
  anthropicUrl?: string;
}): Promise<BuiltDelayedApp> {
  const authClient = createFakeAuthClient({});
  const { client: rawAdminClient, store } = createFakeAdminClient({
    organizations: [{ id: ORG_ID, name: "Async logging test org", monthly_budget_usd: "1000.00" }],
  });
  const { gate, open } = createGate();
  const adminClient = withDelayedTokenLogsInsert(rawAdminClient, gate);
  const keysService = createKeysService(rawAdminClient);
  const created = await keysService.createKey(ORG_ID, "async logging test key");

  const app = buildApp({
    nodeEnv: "test",
    supabase: { authClient, adminClient },
    pricingTable: TEST_PRICING_TABLE,
    usageLogging: FAST_USAGE_LOGGING_CONFIG,
    proxy: {
      openaiBaseUrl: options.openaiUrl ?? "http://127.0.0.1:1",
      anthropicBaseUrl: options.anthropicUrl ?? "http://127.0.0.1:1",
      requestTimeoutMs: 5_000,
      streamMaxDurationMs: 5_000,
      maxBodyBytes: 1_000_000,
    },
  });

  return { app, tokenGuardKey: created.apiKey, store, openGate: open };
}

/** Consumes a light-my-request `res.stream()` Readable to completion. */
function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

describe("async usage logging — OpenAI non-streaming does not wait for persistence", () => {
  let upstream: FakeUpstreamServer;
  let built: BuiltDelayedApp;

  afterEach(async () => {
    await built.app.close();
    await upstream.close();
  });

  it("returns the response and commits the budget charge before the delayed token_logs insert resolves", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    });
    built = await buildDelayedApp({ openaiUrl: upstream.url });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(built.tokenGuardKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [{ role: "user", content: "hi" }] }),
    });

    // The response already came back, and budget accounting (synchronous
    // per Step 8) already ran — but the gate is still closed, so the
    // token_logs insert has not completed.
    expect(res.statusCode).toBe(200);
    expect(built.store.organization_budget_charges).toHaveLength(1);
    expect(built.store.token_logs).toHaveLength(0);

    built.openGate();
    await built.app.usageLoggingService.waitForIdle();
    expect(built.store.token_logs).toHaveLength(1);
    expect(built.store.token_logs[0]?.total_cost_usd).toBe(
      built.store.organization_budget_charges[0]?.amount_usd,
    );
  });
});

describe("async usage logging — Anthropic non-streaming does not wait for persistence", () => {
  let upstream: FakeUpstreamServer;
  let built: BuiltDelayedApp;

  afterEach(async () => {
    await built.app.close();
    await upstream.close();
  });

  it("returns the response and commits the budget charge before the delayed token_logs insert resolves", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "msg_1",
        model: "claude-priced",
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    });
    built = await buildDelayedApp({ anthropicUrl: upstream.url });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(built.tokenGuardKey),
      payload: JSON.stringify({
        model: "claude-priced",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(built.store.organization_budget_charges).toHaveLength(1);
    expect(built.store.token_logs).toHaveLength(0);

    built.openGate();
    await built.app.usageLoggingService.waitForIdle();
    expect(built.store.token_logs).toHaveLength(1);
  });
});

describe("async usage logging — OpenAI streaming does not wait for persistence", () => {
  let upstream: FakeUpstreamServer;
  let built: BuiltDelayedApp;

  afterEach(async () => {
    await built.app.close();
    await upstream.close();
  });

  it("streams the full SSE body to the client and commits the budget charge before the delayed insert resolves", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () => ({
        kind: "sse" as const,
        chunks: [
          'data: {"id":"1","model":"gpt-priced","choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"id":"1","model":"gpt-priced","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    });
    built = await buildDelayedApp({ openaiUrl: upstream.url });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(built.tokenGuardKey),
      payload: JSON.stringify({
        model: "gpt-priced",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      payloadAsStream: true,
    });

    expect(res.statusCode).toBe(200);
    const body = await collectStream(res.stream());
    expect(body).toContain('"content":"hi"');

    // The stream fully delivered its content to the client, and the
    // budget was already committed — all before the gated token_logs
    // insert has been allowed to resolve.
    expect(built.store.organization_budget_charges).toHaveLength(1);
    expect(built.store.token_logs).toHaveLength(0);

    built.openGate();
    await built.app.usageLoggingService.waitForIdle();
    expect(built.store.token_logs).toHaveLength(1);
    expect(built.store.token_logs[0]?.total_cost_usd).toBe(
      built.store.organization_budget_charges[0]?.amount_usd,
    );
  });
});

describe("async usage logging — Anthropic streaming does not wait for persistence", () => {
  let upstream: FakeUpstreamServer;
  let built: BuiltDelayedApp;

  afterEach(async () => {
    await built.app.close();
    await upstream.close();
  });

  it("streams the full SSE body to the client and commits the budget charge before the delayed insert resolves", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () => ({
        kind: "sse" as const,
        chunks: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-priced","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ],
      }),
    });
    built = await buildDelayedApp({ anthropicUrl: upstream.url });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(built.tokenGuardKey),
      payload: JSON.stringify({
        model: "claude-priced",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      payloadAsStream: true,
    });

    expect(res.statusCode).toBe(200);
    const body = await collectStream(res.stream());
    expect(body).toContain('"text":"hi"');

    expect(built.store.organization_budget_charges).toHaveLength(1);
    expect(built.store.token_logs).toHaveLength(0);

    built.openGate();
    await built.app.usageLoggingService.waitForIdle();
    expect(built.store.token_logs).toHaveLength(1);
    expect(built.store.token_logs[0]?.total_cost_usd).toBe(
      built.store.organization_budget_charges[0]?.amount_usd,
    );
  });
});

describe("async usage logging — queue saturation never fails the request", () => {
  it("still returns 200 even when the usage-logging queue is full", async () => {
    const upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "chatcmpl-1", model: "gpt-priced" }),
    });
    const authClient = createFakeAuthClient({});
    const { client: adminClient } = createFakeAdminClient({
      organizations: [{ id: ORG_ID, name: "Queue-full test org", monthly_budget_usd: "1000.00" }],
    });
    const keysService = createKeysService(adminClient);
    const created = await keysService.createKey(ORG_ID, "queue full test key");
    const collector = createLogCollector();

    const app = buildApp({
      nodeEnv: "test",
      logger: collector.logger,
      supabase: { authClient, adminClient },
      pricingTable: TEST_PRICING_TABLE,
      usageLogging: { ...FAST_USAGE_LOGGING_CONFIG, maxQueueSize: 0 },
      proxy: {
        openaiBaseUrl: upstream.url,
        anthropicBaseUrl: "http://127.0.0.1:1",
        requestTimeoutMs: 5_000,
        streamMaxDurationMs: 5_000,
        maxBodyBytes: 1_000_000,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(created.apiKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.statusCode).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));
    const logText = collector.lines().join("\n");
    expect(logText).toContain("USAGE_LOG_QUEUE_FULL");
    expect(logText).not.toContain("sk-openai-secret-value");
    expect(logText).not.toContain(created.apiKey);

    await app.close();
    await upstream.close();
  });
});

describe("async usage logging — graceful shutdown drains the queue", () => {
  it("app.close() waits for a queued usage log to be persisted before resolving", async () => {
    const upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const authClient = createFakeAuthClient({});
    const { client: adminClient, store } = createFakeAdminClient({
      organizations: [{ id: ORG_ID, name: "Shutdown test org", monthly_budget_usd: "1000.00" }],
    });
    const keysService = createKeysService(adminClient);
    const created = await keysService.createKey(ORG_ID, "shutdown test key");

    const app = buildApp({
      nodeEnv: "test",
      supabase: { authClient, adminClient },
      pricingTable: TEST_PRICING_TABLE,
      usageLogging: FAST_USAGE_LOGGING_CONFIG,
      proxy: {
        openaiBaseUrl: upstream.url,
        anthropicBaseUrl: "http://127.0.0.1:1",
        requestTimeoutMs: 5_000,
        streamMaxDurationMs: 5_000,
        maxBodyBytes: 1_000_000,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(created.apiKey),
      payload: JSON.stringify({ model: "gpt-priced", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.statusCode).toBe(200);

    // No explicit waitForIdle() — app.close() itself (via the onClose
    // hook, see app.ts) must drain the queue before resolving.
    await app.close();

    expect(store.token_logs).toHaveLength(1);
    expect(store.token_logs[0]?.request_id).toBe(res.headers["x-tokenguard-request-id"]);

    await upstream.close();
  });
});
