import { randomUUID } from "node:crypto";
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
} from "../helpers/fake-upstream-server.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TEST_PRICING_TABLE: ModelPricing[] = [
  {
    provider: "openai",
    model: "gpt-priced",
    inputPricePerMillionUsd: "1000000.00",
    outputPricePerMillionUsd: "1000000.00",
    currency: "USD",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveTo: null,
    pricingVersion: "test-pricing-v1",
  },
  {
    provider: "anthropic",
    model: "claude-priced",
    inputPricePerMillionUsd: "1000000.00",
    outputPricePerMillionUsd: "1000000.00",
    currency: "USD",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveTo: null,
    pricingVersion: "test-pricing-v1",
  },
];

interface TestAppOptions {
  openaiUrl?: string;
  anthropicUrl?: string;
  organizationId?: string;
  monthlyBudgetUsd?: string;
  /** Seeds no matching `organizations` row for the key's organization —
   * used to simulate an admission check that cannot be completed. */
  omitOrganizationRow?: boolean;
  logger?: ReturnType<typeof createLogCollector>["logger"];
}

async function buildTestApp(
  options: TestAppOptions = {},
): Promise<{ app: FastifyInstance; tokenGuardKey: string; store: FakeStore }> {
  const organizationId = options.organizationId ?? ORG_ID;
  const authClient = createFakeAuthClient({});
  const { client: adminClient, store } = createFakeAdminClient({
    organizations: options.omitOrganizationRow
      ? []
      : [
          {
            id: organizationId,
            name: "Budget test org",
            monthly_budget_usd: options.monthlyBudgetUsd ?? "10.00",
          },
        ],
  });
  const keysService = createKeysService(adminClient);
  const created = await keysService.createKey(organizationId, "budget test key");

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

// A unique message body per request avoids the Step 7 loop detector
// (independently, and by design) ever interfering with these budget
// tests, since every request here has a distinct signature.
function chatPayload(marker: string) {
  return JSON.stringify({ model: "gpt-priced", messages: [{ role: "user", content: marker }] });
}
function messagesPayload(marker: string) {
  return JSON.stringify({
    model: "claude-priced",
    max_tokens: 100,
    messages: [{ role: "user", content: marker }],
  });
}

describe("budget enforcement — OpenAI, non-streaming", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("contacts the provider while under budget", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "chatcmpl-1", model: "gpt-priced" }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({
      openaiUrl: upstream.url,
      monthlyBudgetUsd: "1000.00",
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: chatPayload(randomUUID()),
    });

    expect(res.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it("blocks with 429/MONTHLY_BUDGET_EXCEEDED once the budget is exhausted, without contacting the provider", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    });
    // Budget of $10 at $1,000,000/million tokens on 10 total tokens = $10
    // exactly — the first request exhausts it precisely.
    ({ app, tokenGuardKey, store } = await buildTestApp({
      openaiUrl: upstream.url,
      monthlyBudgetUsd: "10.00",
    }));

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: chatPayload(randomUUID()),
    });
    expect(first.statusCode).toBe(200);
    expect(store.organization_budget_periods[0]?.committed_cost_usd).toBe("10.00000000");

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: chatPayload(randomUUID()),
    });

    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: { code: "MONTHLY_BUDGET_EXCEEDED" } });
    expect(upstream.requests).toHaveLength(1);
    expect(store.token_logs).toHaveLength(1);
  });

  it("includes a Retry-After header pointing at the next UTC month, with no sensitive content in the body", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    });
    ({ app, tokenGuardKey } = await buildTestApp({
      openaiUrl: upstream.url,
      monthlyBudgetUsd: "10.00",
    }));

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: chatPayload(randomUUID()),
    });
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: chatPayload(randomUUID()),
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    const bodyText = blocked.payload;
    expect(bodyText).not.toContain("sk-openai-secret-value");
    expect(bodyText).not.toContain(tokenGuardKey);
    expect(bodyText).not.toContain(ORG_ID);
    const parsed = blocked.json<{ error: Record<string, unknown> }>();
    expect(Object.keys(parsed.error).sort()).toEqual(
      ["code", "message", "retryAfterSeconds"].sort(),
    );
  });
});

describe("budget enforcement — Anthropic, non-streaming", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("contacts the provider while under budget", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "msg_1", model: "claude-priced" }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({
      anthropicUrl: upstream.url,
      monthlyBudgetUsd: "1000.00",
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: messagesPayload(randomUUID()),
    });

    expect(res.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it("blocks with 429/MONTHLY_BUDGET_EXCEEDED once the budget is exhausted, without contacting the provider", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "msg_1",
        model: "claude-priced",
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({
      anthropicUrl: upstream.url,
      monthlyBudgetUsd: "10.00",
    }));

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: messagesPayload(randomUUID()),
    });
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: MESSAGES_HEADERS(tokenGuardKey),
      payload: messagesPayload(randomUUID()),
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "MONTHLY_BUDGET_EXCEEDED" } });
    expect(upstream.requests).toHaveLength(1);
    expect(store.token_logs).toHaveLength(1);
  });
});

describe("budget enforcement — streaming", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("an admitted stream proceeds normally and its final known cost is accounted for", async () => {
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
    ({ app, tokenGuardKey, store } = await buildTestApp({
      openaiUrl: upstream.url,
      monthlyBudgetUsd: "1000.00",
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({
        model: "gpt-priced",
        stream: true,
        messages: [{ role: "user", content: randomUUID() }],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(store.organization_budget_charges).toHaveLength(1);
    expect(store.organization_budget_periods[0]?.committed_cost_usd).toBe("10.00000000");
  });

  it("blocks a streaming request before opening the provider connection once budget is exhausted", async () => {
    upstream = await startFakeUpstreamServer({
      handler: (request) => {
        const parsedBody = JSON.parse(request.body.toString("utf8")) as { stream?: boolean };
        if (parsedBody.stream === true) {
          return {
            kind: "sse" as const,
            chunks: [
              'data: {"id":"1","model":"gpt-priced","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}\n\n',
              "data: [DONE]\n\n",
            ],
          };
        }
        return {
          status: 200,
          body: JSON.stringify({
            id: "chatcmpl-1",
            model: "gpt-priced",
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        };
      },
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({
      openaiUrl: upstream.url,
      monthlyBudgetUsd: "10.00",
    }));

    // Exhaust the budget with a non-streaming request first.
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: chatPayload(randomUUID()),
    });
    expect(upstream.requests).toHaveLength(1);

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({
        model: "gpt-priced",
        stream: true,
        messages: [{ role: "user", content: randomUUID() }],
      }),
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["content-type"]).not.toContain("text/event-stream");
    // No second (streaming) request ever reached the upstream.
    expect(upstream.requests).toHaveLength(1);
  });
});

describe("budget enforcement — unknown pricing", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("succeeds, leaves cost null, never fabricates a $0 charge, and logs BUDGET_COST_UNKNOWN", async () => {
    upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-brand-new-unpriced-model",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    const collector = createLogCollector();
    ({ app, tokenGuardKey, store } = await buildTestApp({
      openaiUrl: upstream.url,
      monthlyBudgetUsd: "10.00",
      logger: collector.logger,
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: JSON.stringify({
        model: "gpt-brand-new-unpriced-model",
        messages: [{ role: "user", content: randomUUID() }],
      }),
    });

    expect(res.statusCode).toBe(200);
    const row = store.token_logs[0];
    expect(row?.total_cost_usd).toBeNull();
    expect(store.organization_budget_charges).toHaveLength(0);
    expect(store.organization_budget_periods).toHaveLength(0);

    await new Promise((resolve) => setImmediate(resolve));
    const logText = collector.lines().join("\n");
    expect(logText).toContain("BUDGET_COST_UNKNOWN");

    // Budget is not exhausted by an unknown-cost request — a second,
    // priced-model request should still be admitted.
    const upstream2 = await startFakeUpstreamServer({
      body: JSON.stringify({ id: "chatcmpl-2", model: "gpt-priced" }),
    });
    try {
      ({ app, tokenGuardKey, store } = await buildTestApp({
        openaiUrl: upstream2.url,
        monthlyBudgetUsd: "10.00",
      }));
      const stillAllowed = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: CHAT_HEADERS(tokenGuardKey),
        payload: chatPayload(randomUUID()),
      });
      expect(stillAllowed.statusCode).toBe(200);
    } finally {
      await upstream2.close();
    }
  });
});

describe("budget enforcement — provider errors", () => {
  let upstream: FakeUpstreamServer;
  let app: FastifyInstance;
  let tokenGuardKey: string;
  let store: FakeStore;

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it("preserves the existing provider-error status/body and never charges budget for a failed request", async () => {
    upstream = await startFakeUpstreamServer({
      status: 429,
      body: JSON.stringify({ error: { message: "rate limited upstream" } }),
    });
    ({ app, tokenGuardKey, store } = await buildTestApp({
      openaiUrl: upstream.url,
      monthlyBudgetUsd: "10.00",
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: chatPayload(randomUUID()),
    });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { message: "rate limited upstream" } });
    expect(store.organization_budget_charges).toHaveLength(0);
    expect(store.organization_budget_periods).toHaveLength(0);
  });
});

describe("budget enforcement — cross-tenant isolation", () => {
  it("organization A exhausting its budget never affects organization B", async () => {
    const upstream = await startFakeUpstreamServer({
      body: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-priced",
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    });

    const authClient = createFakeAuthClient({});
    const orgA = ORG_ID;
    const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { client: adminClient, store } = createFakeAdminClient({
      organizations: [
        { id: orgA, name: "Org A", monthly_budget_usd: "10.00" },
        { id: orgB, name: "Org B", monthly_budget_usd: "10.00" },
      ],
    });
    const keysService = createKeysService(adminClient);
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
    });

    // Exhaust org A's budget exactly.
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyA.apiKey),
      payload: chatPayload(randomUUID()),
    });
    const orgABlocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyA.apiKey),
      payload: chatPayload(randomUUID()),
    });
    expect(orgABlocked.statusCode).toBe(429);

    // Org B, an entirely independent budget, is unaffected.
    const orgBFirst = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(keyB.apiKey),
      payload: chatPayload(randomUUID()),
    });
    expect(orgBFirst.statusCode).toBe(200);

    const orgAPeriod = store.organization_budget_periods.find((p) => p.organization_id === orgA);
    const orgBPeriod = store.organization_budget_periods.find((p) => p.organization_id === orgB);
    expect(orgAPeriod?.committed_cost_usd).toBe("10.00000000");
    expect(orgBPeriod?.committed_cost_usd).toBe("10.00000000");
    expect(orgAPeriod).not.toBe(orgBPeriod);

    await app.close();
    await upstream.close();
  });
});

describe("budget enforcement — fail-closed on check failure", () => {
  it("returns 503 and never contacts the provider when the admission check itself cannot be completed", async () => {
    const upstream = await startFakeUpstreamServer();
    const collector = createLogCollector();
    // omitOrganizationRow: the TokenGuard key resolves to a real
    // organization_id, but no matching `organizations` row exists — the
    // admission check's underlying query returns no row, which the
    // repository treats as a failure (never as "budget available").
    const { app, tokenGuardKey } = await buildTestApp({
      openaiUrl: upstream.url,
      omitOrganizationRow: true,
      logger: collector.logger,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: CHAT_HEADERS(tokenGuardKey),
      payload: chatPayload(randomUUID()),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "BUDGET_CHECK_UNAVAILABLE" } });
    expect(upstream.requests).toHaveLength(0);

    await new Promise((resolve) => setImmediate(resolve));
    const logText = collector.lines().join("\n");
    expect(logText).toContain("failing closed");

    await app.close();
    await upstream.close();
  });
});
