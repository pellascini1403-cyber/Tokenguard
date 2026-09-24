import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.js";
import { createKeysService } from "../../src/modules/keys/keys.service.js";
import { createFakeAdminClient } from "../helpers/fake-admin-client.js";
import { createFakeAuthClient } from "../helpers/fake-auth-client.js";
import { createLogCollector } from "../helpers/log-collector.js";
import {
  startFakeUpstreamServer,
  type FakeUpstreamServer,
} from "../helpers/fake-upstream-server.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function parseBody(res: LightMyRequestResponse): unknown {
  return res.json();
}

interface TestAppOptions {
  openaiUrl?: string;
  anthropicUrl?: string;
  requestTimeoutMs?: number;
  streamMaxDurationMs?: number;
  maxBodyBytes?: number;
  logger?: ReturnType<typeof createLogCollector>["logger"];
}

async function buildTestApp(
  options: TestAppOptions = {},
): Promise<{ app: FastifyInstance; tokenGuardKey: string }> {
  const authClient = createFakeAuthClient({});
  const { client: adminClient } = createFakeAdminClient();
  const keysService = createKeysService(adminClient);
  const created = await keysService.createKey(ORG_ID, "proxy test key");

  const app = buildApp({
    nodeEnv: "test",
    logger: options.logger,
    supabase: { authClient, adminClient },
    proxy: {
      openaiBaseUrl: options.openaiUrl ?? "http://127.0.0.1:1",
      anthropicBaseUrl: options.anthropicUrl ?? "http://127.0.0.1:1",
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      streamMaxDurationMs: options.streamMaxDurationMs ?? 5_000,
      maxBodyBytes: options.maxBodyBytes ?? 1_000_000,
    },
  });

  return { app, tokenGuardKey: created.apiKey };
}

const CHAT_PAYLOAD = JSON.stringify({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});

const MESSAGES_PAYLOAD = JSON.stringify({
  model: "claude-sonnet-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "Hello" }],
});

describe("TokenGuard authentication for proxy routes", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;

  beforeEach(async () => {
    upstream = await startFakeUpstreamServer();
    ({ app, tokenGuardKey } = await buildTestApp({ openaiUrl: upstream.url }));
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("rejects a request with no X-TokenGuard-Key header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: "Bearer sk-openai-test" },
      payload: CHAT_PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
    expect(parseBody(res)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects an invalid X-TokenGuard-Key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": "tg_usr_live_not-a-real-key",
      },
      payload: CHAT_PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects a revoked X-TokenGuard-Key", async () => {
    const authClient = createFakeAuthClient({});
    const { client: adminClient } = createFakeAdminClient();
    const keysService = createKeysService(adminClient);
    const created = await keysService.createKey(ORG_ID, "to be revoked");
    await keysService.revokeKey(ORG_ID, created.id);

    const revokedApp = buildApp({
      nodeEnv: "test",
      supabase: { authClient, adminClient },
      proxy: {
        openaiBaseUrl: upstream.url,
        anthropicBaseUrl: upstream.url,
        requestTimeoutMs: 5_000,
        streamMaxDurationMs: 5_000,
        maxBodyBytes: 1_000_000,
      },
    });

    const res = await revokedApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": created.apiKey,
      },
      payload: CHAT_PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
    expect(upstream.requests).toHaveLength(0);
    await revokedApp.close();
  });

  it("gives an identical response for missing, invalid, and revoked keys", async () => {
    const authClient = createFakeAuthClient({});
    const { client: adminClient } = createFakeAdminClient();
    const keysService = createKeysService(adminClient);
    const revoked = await keysService.createKey(ORG_ID, "to be revoked");
    await keysService.revokeKey(ORG_ID, revoked.id);

    const revokedApp = buildApp({
      nodeEnv: "test",
      supabase: { authClient, adminClient },
      proxy: {
        openaiBaseUrl: upstream.url,
        anthropicBaseUrl: upstream.url,
        requestTimeoutMs: 5_000,
        streamMaxDurationMs: 5_000,
        maxBodyBytes: 1_000_000,
      },
    });

    const missing = await revokedApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: CHAT_PAYLOAD,
    });
    const invalid = await revokedApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-tokenguard-key": "tg_usr_live_bogus" },
      payload: CHAT_PAYLOAD,
    });
    const revokedRes = await revokedApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-tokenguard-key": revoked.apiKey },
      payload: CHAT_PAYLOAD,
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(revokedRes.statusCode).toBe(401);
    expect(parseBody(missing)).toEqual(parseBody(invalid));
    expect(parseBody(missing)).toEqual(parseBody(revokedRes));
    await revokedApp.close();
  });

  it("proceeds to the upstream provider with a valid X-TokenGuard-Key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });
});

describe("OpenAI proxy (POST /v1/chat/completions)", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;

  beforeEach(async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "chatcmpl-123", choices: [{ message: { content: "hi" } }] }),
    });
    ({ app, tokenGuardKey } = await buildTestApp({ openaiUrl: upstream.url }));
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("reaches the configured upstream endpoint", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.url).toBe("/v1/chat/completions");
    expect(upstream.requests[0]?.method).toBe("POST");
  });

  it("forwards the body unmodified", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    expect(upstream.requests[0]?.body.toString("utf8")).toBe(CHAT_PAYLOAD);
  });

  it("forwards the client's Authorization header to OpenAI", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-secret-value",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer sk-openai-secret-value");
  });

  it("never forwards X-TokenGuard-Key to the upstream provider", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    expect(upstream.requests[0]?.headers["x-tokenguard-key"]).toBeUndefined();
  });

  it("returns the upstream response body and content-type to the client", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(parseBody(res)).toMatchObject({ id: "chatcmpl-123" });
  });

  it("preserves a non-200 upstream status code", async () => {
    await upstream.close();
    upstream = await startFakeUpstreamServer({
      status: 429,
      body: JSON.stringify({ error: { message: "rate limited" } }),
    });
    ({ app, tokenGuardKey } = await buildTestApp({ openaiUrl: upstream.url }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    expect(res.statusCode).toBe(429);
    expect(parseBody(res)).toMatchObject({ error: { message: "rate limited" } });
  });

  it("requires an Authorization header for OpenAI", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json", "x-tokenguard-key": tokenGuardKey },
      payload: CHAT_PAYLOAD,
    });
    expect(res.statusCode).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("Anthropic proxy (POST /v1/messages)", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;

  beforeEach(async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "msg_123", content: [{ type: "text", text: "hi" }] }),
    });
    ({ app, tokenGuardKey } = await buildTestApp({ anthropicUrl: upstream.url }));
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("reaches the configured upstream endpoint", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: MESSAGES_PAYLOAD,
    });

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.url).toBe("/v1/messages");
  });

  it("forwards the body unmodified", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: MESSAGES_PAYLOAD,
    });

    expect(upstream.requests[0]?.body.toString("utf8")).toBe(MESSAGES_PAYLOAD);
  });

  it("forwards the client's x-api-key to Anthropic", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-secret-value",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: MESSAGES_PAYLOAD,
    });

    expect(upstream.requests[0]?.headers["x-api-key"]).toBe("sk-ant-secret-value");
  });

  it("never forwards X-TokenGuard-Key to the upstream provider", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: MESSAGES_PAYLOAD,
    });

    expect(upstream.requests[0]?.headers["x-tokenguard-key"]).toBeUndefined();
  });

  it("preserves a client-provided anthropic-version header", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test",
        "anthropic-version": "2023-06-01",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: MESSAGES_PAYLOAD,
    });

    expect(upstream.requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("does not invent an anthropic-version header when the client omits it", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: MESSAGES_PAYLOAD,
    });

    expect(upstream.requests[0]?.headers["anthropic-version"]).toBeUndefined();
  });

  it("returns the upstream response body to the client", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: MESSAGES_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toMatchObject({ id: "msg_123" });
  });

  it("requires an x-api-key header for Anthropic", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-tokenguard-key": tokenGuardKey },
      payload: MESSAGES_PAYLOAD,
    });
    expect(res.statusCode).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });
});

// Streaming (`stream: true`) is now fully implemented — see
// tests/routes/proxy-streaming.test.ts. This file continues to cover only
// the non-streaming proxy path, which Step 6 leaves unchanged.

describe("upstream timeout", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;

  beforeEach(async () => {
    upstream = await startFakeUpstreamServer({ delayMs: 200 });
    ({ app, tokenGuardKey } = await buildTestApp({
      openaiUrl: upstream.url,
      requestTimeoutMs: 30,
    }));
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("aborts a slow upstream and returns a controlled error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    expect(res.statusCode).toBe(504);
    expect(parseBody(res)).toMatchObject({ error: { code: "UPSTREAM_TIMEOUT" } });
    expect(res.headers["x-tokenguard-request-id"]).toBeTruthy();
    const body = JSON.stringify(parseBody(res));
    expect(body).not.toContain("sk-openai-test");
  });
});

describe("upstream unreachable", () => {
  it("returns a controlled error when the upstream cannot be reached", async () => {
    const { app, tokenGuardKey } = await buildTestApp({ openaiUrl: "http://127.0.0.1:1" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    expect(res.statusCode).toBe(502);
    expect(parseBody(res)).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" } });
    await app.close();
  });
});

describe("request body size limit", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;

  beforeEach(async () => {
    upstream = await startFakeUpstreamServer();
    ({ app, tokenGuardKey } = await buildTestApp({
      openaiUrl: upstream.url,
      maxBodyBytes: 200,
    }));
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("rejects an oversized body before contacting the upstream", async () => {
    const oversized = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "A".repeat(5_000) }],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: oversized,
    });

    expect(res.statusCode).toBe(413);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("request ID", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;

  beforeEach(async () => {
    upstream = await startFakeUpstreamServer();
    ({ app, tokenGuardKey } = await buildTestApp({ openaiUrl: upstream.url }));
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("returns an X-TokenGuard-Request-Id header shaped like a UUID", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    const requestId = res.headers["x-tokenguard-request-id"];
    expect(typeof requestId).toBe("string");
    expect(requestId as string).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("returns a request ID on every response, including errors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: CHAT_PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-tokenguard-request-id"]).toBeTruthy();
  });
});

describe("security: no secret ever appears in logs", () => {
  it("never logs the OpenAI key, TokenGuard key, or request body", async () => {
    const upstream = await startFakeUpstreamServer();
    const collector = createLogCollector();
    const { app, tokenGuardKey } = await buildTestApp({
      openaiUrl: upstream.url,
      logger: collector.logger,
    });

    const secretOpenAiKey = "sk-openai-super-secret-marker-12345";
    const secretPromptMarker = "MARKER-PROMPT-CONTENT-SHOULD-NEVER-BE-LOGGED";

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secretOpenAiKey}`,
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: secretPromptMarker }],
      }),
    });

    // Let any pending async log writes flush before inspecting the buffer.
    await new Promise((resolve) => setImmediate(resolve));

    const logText = collector.lines().join("\n");
    expect(logText).not.toContain(secretOpenAiKey);
    expect(logText).not.toContain(tokenGuardKey);
    expect(logText).not.toContain(secretPromptMarker);

    await app.close();
    await upstream.close();
  });

  it("never logs the Anthropic key or a revoked/invalid TokenGuard key attempt", async () => {
    const upstream = await startFakeUpstreamServer();
    const collector = createLogCollector();
    const { app } = await buildTestApp({ anthropicUrl: upstream.url, logger: collector.logger });

    const secretAnthropicKey = "sk-ant-super-secret-marker-98765";
    const bogusTokenGuardKey = "tg_usr_live_bogus-attempt-value";

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": secretAnthropicKey,
        "x-tokenguard-key": bogusTokenGuardKey,
      },
      payload: MESSAGES_PAYLOAD,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const logText = collector.lines().join("\n");
    expect(logText).not.toContain(secretAnthropicKey);
    expect(logText).not.toContain(bogusTokenGuardKey);

    await app.close();
    await upstream.close();
  });

  it("includes the same TokenGuard request ID in the structured logs as in the response header", async () => {
    const upstream = await startFakeUpstreamServer();
    const collector = createLogCollector();
    const { app, tokenGuardKey } = await buildTestApp({
      openaiUrl: upstream.url,
      logger: collector.logger,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-test",
        "x-tokenguard-key": tokenGuardKey,
      },
      payload: CHAT_PAYLOAD,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const requestId = res.headers["x-tokenguard-request-id"] as string;
    const logText = collector.lines().join("\n");
    expect(logText).toContain(requestId);

    await app.close();
    await upstream.close();
  });
});
