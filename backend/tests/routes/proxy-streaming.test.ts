import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createKeysService } from "../../src/modules/keys/keys.service.js";
import type { ModelPricing } from "../../src/modules/pricing/types.js";
import { createFakeAdminClient, type FakeStore } from "../helpers/fake-admin-client.js";
import { createFakeAuthClient } from "../helpers/fake-auth-client.js";
import { createLogCollector } from "../helpers/log-collector.js";
import {
  startFakeUpstreamServer,
  type FakeUpstreamServer,
  type FakeUpstreamSseResponse,
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
  requestTimeoutMs?: number;
  streamMaxDurationMs?: number;
  logger?: ReturnType<typeof createLogCollector>["logger"];
}

async function buildTestApp(
  options: TestAppOptions = {},
): Promise<{ app: FastifyInstance; tokenGuardKey: string; store: FakeStore }> {
  const authClient = createFakeAuthClient({});
  const { client: adminClient, store } = createFakeAdminClient();
  const keysService = createKeysService(adminClient);
  const created = await keysService.createKey(ORG_ID, "streaming test key");

  const app = buildApp({
    nodeEnv: "test",
    logger: options.logger,
    supabase: { authClient, adminClient },
    pricingTable: TEST_PRICING_TABLE,
    proxy: {
      openaiBaseUrl: options.openaiUrl ?? "http://127.0.0.1:1",
      anthropicBaseUrl: options.anthropicUrl ?? "http://127.0.0.1:1",
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      streamMaxDurationMs: options.streamMaxDurationMs ?? 5_000,
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

const STREAM_CHAT_PAYLOAD = JSON.stringify({
  model: "gpt-priced",
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
});

const STREAM_MESSAGES_PAYLOAD = JSON.stringify({
  model: "claude-priced",
  max_tokens: 100,
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
});

/** Consumes a light-my-request `res.stream()` Readable to completion,
 * recording every chunk with the elapsed time (ms since `start`) at
 * which it arrived — used to prove real incremental delivery. */
async function collectTimedChunks(
  stream: NodeJS.ReadableStream,
  start: number,
): Promise<{ text: string; arrivals: number[] }> {
  const chunks: Buffer[] = [];
  const arrivals: number[] = [];
  await new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      arrivals.push(Date.now() - start);
    });
    stream.on("end", () => resolve());
    stream.on("error", () => resolve());
    stream.on("close", () => resolve());
  });
  return { text: Buffer.concat(chunks).toString("utf8"), arrivals };
}

function sse(
  chunks: string[],
  extra: Partial<FakeUpstreamSseResponse> = {},
): FakeUpstreamSseResponse {
  return { kind: "sse", chunks, ...extra };
}

describe("OpenAI streaming (POST /v1/chat/completions, stream: true)", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("forwards SSE bytes to the client unmodified, including a chunk split at an arbitrary byte boundary", async () => {
    const full =
      'data: {"id":"1","model":"gpt-priced","choices":[{"delta":{"content":"hi"}}]}\n\n' +
      "data: [DONE]\n\n";
    // Split at a byte offset that lands mid-field, not on an event boundary.
    const splitAt = 40;
    upstream = await startFakeUpstreamServer({
      handler: () => sse([full.slice(0, splitAt), full.slice(splitAt)]),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: STREAM_CHAT_PAYLOAD,
      payloadAsStream: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toContain("no-cache");

    const { text } = await collectTimedChunks(res.stream(), Date.now());
    expect(text).toBe(full);
  });

  it("delivers chunks to the client before the upstream has fully finished sending", async () => {
    const chunkCount = 5;
    const chunkDelayMs = 60;
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse(
          Array.from({ length: chunkCount }, (_, i) => `data: {"chunk":${i}}\n\n`),
          { chunkDelayMs },
        ),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const start = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: STREAM_CHAT_PAYLOAD,
      payloadAsStream: true,
    });

    const { arrivals } = await collectTimedChunks(res.stream(), start);
    expect(arrivals.length).toBeGreaterThan(0);

    // Total upstream time is roughly (chunkCount - 1) * chunkDelayMs. If
    // this were "buffer everything, then send", the FIRST client byte
    // would arrive only once the whole thing is done — i.e. near the
    // total duration. Real streaming means it arrives much earlier.
    const totalUpstreamDurationMs = (chunkCount - 1) * chunkDelayMs;
    expect(arrivals[0]).toBeLessThan(totalUpstreamDurationMs / 2);
  });

  it("captures and normalizes final usage when the client requested stream_options.include_usage", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse([
          'data: {"id":"1","model":"gpt-priced","choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"id":"1","model":"gpt-priced","choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":1000000,"total_tokens":2000000}}\n\n',
          "data: [DONE]\n\n",
        ]),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({
        model: "gpt-priced",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "Hello" }],
      }),
      payloadAsStream: true,
    });
    await collectTimedChunks(res.stream(), Date.now());
    await sleep(0);

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
    expect(row?.request_id).toBe(res.headers["x-tokenguard-request-id"]);
  });

  it("records unknown usage (never fabricated) when the stream ends without a usage field", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse([
          'data: {"id":"1","model":"gpt-priced","choices":[{"delta":{"content":"hi"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: STREAM_CHAT_PAYLOAD,
      payloadAsStream: true,
    });
    await collectTimedChunks(res.stream(), Date.now());
    await sleep(0);

    const row = store.token_logs[0];
    expect(row?.prompt_tokens).toBeNull();
    expect(row?.completion_tokens).toBeNull();
    expect(row?.total_tokens).toBeNull();
    expect(row?.total_cost_usd).toBeNull();
    expect(row?.usage_source).toBe("unknown");
    expect(row?.model_used).toBe("gpt-priced");
  });

  it("never forwards the TokenGuard key upstream and never leaks the OpenAI key or prompt/response content into logs or token_logs", async () => {
    const secretOpenAiKey = "sk-openai-super-secret-marker-12345";
    const promptMarker = "MARKER-PROMPT-CONTENT";
    const completionMarker = "MARKER-COMPLETION-CONTENT";
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse([
          `data: {"id":"1","model":"gpt-priced","choices":[{"delta":{"content":"${completionMarker}"}}]}\n\n`,
          'data: {"id":"1","model":"gpt-priced","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ]),
    });
    const collector = createLogCollector();
    ({ app, tokenGuardKey, store } = await buildTestApp({
      openaiUrl: upstream.url,
      logger: collector.logger,
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secretOpenAiKey}`,
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: JSON.stringify({
        model: "gpt-priced",
        stream: true,
        messages: [{ role: "user", content: promptMarker }],
      }),
      payloadAsStream: true,
    });
    await collectTimedChunks(res.stream(), Date.now());
    await sleep(0);

    expect(upstream.requests[0]?.headers["x-tokenguard-key"]).toBeUndefined();
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${secretOpenAiKey}`);

    const logText = collector.lines().join("\n");
    expect(logText).not.toContain(secretOpenAiKey);
    expect(logText).not.toContain(tokenGuardKey);
    expect(logText).not.toContain(promptMarker);
    expect(logText).not.toContain(completionMarker);

    const row = store.token_logs[0];
    const serializedRow = JSON.stringify(row);
    expect(serializedRow).not.toContain(secretOpenAiKey);
    expect(serializedRow).not.toContain(tokenGuardKey);
    expect(serializedRow).not.toContain(promptMarker);
    expect(serializedRow).not.toContain(completionMarker);
  });

  it("behaves like the ordinary (non-streaming) proxy when the provider rejects the request before streaming starts", async () => {
    upstream = await startFakeUpstreamServer({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "invalid api key" } }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: STREAM_CHAT_PAYLOAD,
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toMatchObject({ error: { message: "invalid api key" } });

    const row = store.token_logs[0];
    expect(row?.status_code).toBe(401);
    expect(row?.usage_source).toBe("unknown");
  });

  it("ends the client stream cleanly and records available (or unknown) usage when the provider disconnects mid-stream", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse(
          [
            'data: {"id":"1","model":"gpt-priced","choices":[{"delta":{"content":"hi"}}]}\n\n',
            'data: {"id":"1","model":"gpt-priced","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
          ],
          { destroyAfterChunks: 2 },
        ),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: STREAM_CHAT_PAYLOAD,
      payloadAsStream: true,
    });

    // Must not hang or throw — the pump swallows the mid-stream error and
    // ends the client-facing stream gracefully.
    await collectTimedChunks(res.stream(), Date.now());
    // The disconnect path has more async hops (fetch/undici error
    // propagation) than the clean-end path, so give usage recording a
    // little longer to land than a bare microtask flush would.
    await sleep(20);

    expect(store.token_logs).toHaveLength(1);
    const row = store.token_logs[0];
    // Usage had already arrived before the disconnect, so it's captured
    // (never fabricated, but not thrown away either).
    expect(row?.prompt_tokens).toBe(3);
    expect(row?.completion_tokens).toBe(4);
    expect(row?.usage_source).toBe("provider");
  });

  it("aborts the upstream request when the client disconnects mid-stream", async () => {
    // A real network round trip (listen + fetch), not light-my-request's
    // `signal` option: light-my-request's inject-mode abort only tears
    // down the local response-reading stream, not `reply.raw` itself, so
    // it can't exercise the real "client went away" signal TokenGuard
    // actually listens for on a live connection.
    const chunkCount = 20;
    const chunkDelayMs = 50;
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse(
          Array.from({ length: chunkCount }, (_, i) => `data: {"chunk":${i}}\n\n`),
          { chunkDelayMs },
        ),
    });
    ({ app, tokenGuardKey } = await buildTestApp({ openaiUrl: upstream.url }));
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const controller = new AbortController();
    const fetchPromise = fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: CHAT_HEADERS(tokenGuardKey),
      body: STREAM_CHAT_PAYLOAD,
      signal: controller.signal,
    })
      .then(async (fetchRes) => {
        const reader = fetchRes.body!.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      })
      .catch(() => null);

    // Let the stream actually start (headers + at least one chunk) before
    // simulating the client going away.
    await sleep(chunkDelayMs * 2);
    controller.abort();
    await fetchPromise;

    // Give the server-side 'close' propagation a tick to fire.
    await sleep(100);

    expect(upstream.sseAbortedConnections).toBe(1);

    app.server.closeAllConnections();
  });

  it("aborts a stream that exceeds STREAM_MAX_DURATION_MS", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse(
          Array.from({ length: 50 }, (_, i) => `data: {"chunk":${i}}\n\n`),
          {
            chunkDelayMs: 40,
          },
        ),
    });
    ({ app, tokenGuardKey } = await buildTestApp({
      openaiUrl: upstream.url,
      streamMaxDurationMs: 80,
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: STREAM_CHAT_PAYLOAD,
      payloadAsStream: true,
    });

    const { text } = await collectTimedChunks(res.stream(), Date.now());
    // The stream was cut short by the guard — it never received all 50
    // chunks (50 * 40ms = 2000ms, far beyond the 80ms ceiling).
    expect(text.split("\n\n").length).toBeLessThan(50);
  });
});

describe("Anthropic streaming (POST /v1/messages, stream: true)", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("forwards SSE bytes unmodified and delivers them before the upstream fully finishes", async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-priced","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    upstream = await startFakeUpstreamServer({
      handler: () => sse(events, { chunkDelayMs: 50 }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    const start = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: STREAM_MESSAGES_PAYLOAD,
      payloadAsStream: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const { text, arrivals } = await collectTimedChunks(res.stream(), start);
    expect(text).toBe(events.join(""));
    expect(arrivals[0]).toBeLessThan(((events.length - 1) * 50) / 2);
  });

  it("accumulates usage across message_start and message_delta, normalizing and pricing it", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-priced","usage":{"input_tokens":1000000,"output_tokens":1}}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1000000}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: STREAM_MESSAGES_PAYLOAD,
      payloadAsStream: true,
    });
    await collectTimedChunks(res.stream(), Date.now());
    await sleep(0);

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
    });
    expect(row?.request_id).toBe(res.headers["x-tokenguard-request-id"]);
  });

  it("records unknown usage when the stream ends without any usage-bearing event", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse([
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: STREAM_MESSAGES_PAYLOAD,
      payloadAsStream: true,
    });
    await collectTimedChunks(res.stream(), Date.now());
    await sleep(0);

    const row = store.token_logs[0];
    expect(row?.prompt_tokens).toBeNull();
    expect(row?.completion_tokens).toBeNull();
    expect(row?.usage_source).toBe("unknown");
  });

  it("never forwards the TokenGuard key upstream and never leaks the Anthropic key into logs", async () => {
    const secretAnthropicKey = "sk-ant-super-secret-marker-98765";
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-priced","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
    });
    const collector = createLogCollector();
    ({ app, tokenGuardKey, store } = await buildTestApp({
      anthropicUrl: upstream.url,
      logger: collector.logger,
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": secretAnthropicKey,
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: STREAM_MESSAGES_PAYLOAD,
      payloadAsStream: true,
    });
    await collectTimedChunks(res.stream(), Date.now());
    await sleep(0);

    expect(upstream.requests[0]?.headers["x-tokenguard-key"]).toBeUndefined();
    expect(upstream.requests[0]?.headers["x-api-key"]).toBe(secretAnthropicKey);

    const logText = collector.lines().join("\n");
    expect(logText).not.toContain(secretAnthropicKey);
    expect(logText).not.toContain(tokenGuardKey);
  });

  it("behaves like the ordinary proxy when Anthropic rejects the request before streaming starts", async () => {
    upstream = await startFakeUpstreamServer({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ type: "error", error: { message: "invalid request" } }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: STREAM_MESSAGES_PAYLOAD,
    });

    expect(res.statusCode).toBe(400);
    const row = store.token_logs[0];
    expect(row?.status_code).toBe(400);
    expect(row?.usage_source).toBe("unknown");
  });

  it("ends the client stream cleanly when the provider disconnects mid-stream", async () => {
    upstream = await startFakeUpstreamServer({
      handler: () =>
        sse(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-priced","usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
          ],
          { destroyAfterChunks: 1 },
        ),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({ anthropicUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: STREAM_MESSAGES_PAYLOAD,
      payloadAsStream: true,
    });
    await collectTimedChunks(res.stream(), Date.now());
    await sleep(20);

    expect(store.token_logs).toHaveLength(1);
    const row = store.token_logs[0];
    expect(row?.prompt_tokens).toBe(2);
    expect(row?.usage_source).toBe("provider");
  });
});
