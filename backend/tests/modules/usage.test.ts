import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUsageService } from "../../src/modules/usage/usage.service.js";
import type { UsageLogInput } from "../../src/modules/usage/types.js";
import { createFakeAdminClient, type FakeStore } from "../helpers/fake-admin-client.js";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seedWithOrgsAndKeys(): {
  client: ReturnType<typeof createFakeAdminClient>["client"];
  store: FakeStore;
  keyForOrgA: string;
  keyForOrgB: string;
} {
  const keyForOrgA = randomUUID();
  const keyForOrgB = randomUUID();
  const { client, store } = createFakeAdminClient({
    organizations: [
      { id: ORG_A, name: "Org A", monthly_budget_usd: "500.00" },
      { id: ORG_B, name: "Org B", monthly_budget_usd: "500.00" },
    ],
    token_guard_keys: [
      {
        id: keyForOrgA,
        organization_id: ORG_A,
        key_prefix: "prefixA",
        key_hash: "hashA",
        name: "Org A key",
        revoked_at: null,
      },
      {
        id: keyForOrgB,
        organization_id: ORG_B,
        key_prefix: "prefixB",
        key_hash: "hashB",
        name: "Org B key",
        revoked_at: null,
      },
    ],
  });
  return { client, store, keyForOrgA, keyForOrgB };
}

function validInput(overrides: Partial<UsageLogInput> = {}): UsageLogInput {
  return {
    organizationId: ORG_A,
    tokenGuardKeyId: null,
    provider: "openai",
    modelUsed: "gpt-4o",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    inputCostUsd: "0.00010000",
    outputCostUsd: "0.00020000",
    totalCostUsd: "0.00030000",
    usageSource: "provider",
    pricingVersion: "test-pricing-snapshot",
    durationMs: 250,
    statusCode: 200,
    requestId: randomUUID(),
    ...overrides,
  };
}

describe("usage service — creation", () => {
  it("accepts a valid usage log", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    const log = await service.createUsageLog(validInput());

    expect(log.id).toBeTruthy();
    expect(log.organizationId).toBe(ORG_A);
    expect(log.createdAt).toBeTruthy();
  });

  it("persists null token counts as null, not zero, when usage is unknown", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    const log = await service.createUsageLog(
      validInput({
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        inputCostUsd: null,
        outputCostUsd: null,
        totalCostUsd: null,
      }),
    );

    expect(log.promptTokens).toBeNull();
    expect(log.totalTokens).toBeNull();
    expect(log.totalCostUsd).toBeNull();
  });

  it("requires a valid organization ID", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(
      service.createUsageLog(validInput({ organizationId: "not-a-uuid" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", statusCode: 400 });
  });

  it("requires a supported provider", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    // @ts-expect-error deliberately invalid provider for the runtime check
    await expect(service.createUsageLog(validInput({ provider: "azure" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("requires a non-empty model", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(service.createUsageLog(validInput({ modelUsed: "" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("requires a valid request ID", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(
      service.createUsageLog(validInput({ requestId: "not-a-uuid" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects negative token counts", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(service.createUsageLog(validInput({ promptTokens: -1 }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects non-integer token counts", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(service.createUsageLog(validInput({ promptTokens: 1.5 }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects a total that does not equal prompt + completion when all are known", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(
      service.createUsageLog(
        validInput({ promptTokens: 100, completionTokens: 50, totalTokens: 999 }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a negative monetary value", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(
      service.createUsageLog(validInput({ totalCostUsd: "-1.00" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a negative duration", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(service.createUsageLog(validInput({ durationMs: -1 }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects an out-of-range status code", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(service.createUsageLog(validInput({ statusCode: 999 }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("usage service — relationships", () => {
  it("associates a usage log with its organization", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    const log = await service.createUsageLog(validInput({ organizationId: ORG_B }));
    expect(log.organizationId).toBe(ORG_B);
  });

  it("associates a usage log with the TokenGuard key that authenticated it", async () => {
    const { client, keyForOrgA } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    const log = await service.createUsageLog(
      validInput({ organizationId: ORG_A, tokenGuardKeyId: keyForOrgA }),
    );
    expect(log.tokenGuardKeyId).toBe(keyForOrgA);
  });

  it("allows a usage log with no TokenGuard key", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    const log = await service.createUsageLog(validInput({ tokenGuardKeyId: null }));
    expect(log.tokenGuardKeyId).toBeNull();
  });

  it("rejects a usage log whose organization does not own the referenced key", async () => {
    // Enforced by a database trigger in the real schema (see
    // supabase/migrations); the fake admin client mirrors that same
    // rejection so this invariant is covered without a live database.
    const { client, keyForOrgB } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(
      service.createUsageLog(validInput({ organizationId: ORG_A, tokenGuardKeyId: keyForOrgB })),
    ).rejects.toThrow(/does not match the organization owning/);
  });
});

describe("usage service — retrieval", () => {
  async function seedLogsForBothOrgs(count: { orgA: number; orgB: number }) {
    const setup = seedWithOrgsAndKeys();
    const service = createUsageService(setup.client);
    for (let i = 0; i < count.orgA; i += 1) {
      await service.createUsageLog(validInput({ organizationId: ORG_A }));
    }
    for (let i = 0; i < count.orgB; i += 1) {
      await service.createUsageLog(validInput({ organizationId: ORG_B }));
    }
    return { ...setup, service };
  }

  it("scopes the usage summary to only the requested organization", async () => {
    const { service } = await seedLogsForBothOrgs({ orgA: 3, orgB: 5 });

    const summaryA = await service.getOrganizationUsageSummary(ORG_A);
    const summaryB = await service.getOrganizationUsageSummary(ORG_B);

    expect(summaryA.requestCount).toBe(3);
    expect(summaryB.requestCount).toBe(5);
  });

  it("returns zeroed totals for an organization with no usage", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    const summary = await service.getOrganizationUsageSummary(ORG_A);

    expect(summary).toMatchObject({
      requestCount: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      requestsWithUnknownUsage: 0,
    });
  });

  it("counts requests with unknown token usage separately from known usage", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await service.createUsageLog(validInput());
    await service.createUsageLog(
      validInput({
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        inputCostUsd: null,
        outputCostUsd: null,
        totalCostUsd: null,
      }),
    );

    const summary = await service.getOrganizationUsageSummary(ORG_A);
    expect(summary.requestCount).toBe(2);
    expect(summary.requestsWithUnknownUsage).toBe(1);
    expect(summary.totalPromptTokens).toBe(100);
  });

  it("scopes paginated logs to only the requested organization", async () => {
    const { service } = await seedLogsForBothOrgs({ orgA: 2, orgB: 4 });

    const page = await service.getOrganizationLogs(ORG_A);
    expect(page.items).toHaveLength(2);
    expect(page.items.every((log) => log.organizationId === ORG_A)).toBe(true);
  });

  it("orders logs deterministically (most recent first, id as tiebreaker)", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    for (let i = 0; i < 5; i += 1) {
      await service.createUsageLog(validInput());
    }

    const page = await service.getOrganizationLogs(ORG_A, {}, { page: 1, pageSize: 10 });
    const timestamps = page.items.map((log) => log.createdAt);
    const sorted = [...timestamps].sort().reverse();
    expect(timestamps).toEqual(sorted);
  });

  it("bounds pagination to a maximum page size", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);
    for (let i = 0; i < 10; i += 1) {
      await service.createUsageLog(validInput());
    }

    const page = await service.getOrganizationLogs(ORG_A, {}, { page: 1, pageSize: 100000 });
    expect(page.items.length).toBeLessThanOrEqual(100);
  });

  it("paginates without gaps or overlap across pages", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);
    for (let i = 0; i < 5; i += 1) {
      await service.createUsageLog(validInput({ requestId: randomUUID() }));
    }

    const pageOne = await service.getOrganizationLogs(ORG_A, {}, { page: 1, pageSize: 2 });
    const pageTwo = await service.getOrganizationLogs(ORG_A, {}, { page: 2, pageSize: 2 });
    const pageThree = await service.getOrganizationLogs(ORG_A, {}, { page: 3, pageSize: 2 });

    expect(pageOne.hasMore).toBe(true);
    expect(pageTwo.hasMore).toBe(true);
    expect(pageThree.hasMore).toBe(false);

    const allIds = [...pageOne.items, ...pageTwo.items, ...pageThree.items].map((log) => log.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("filters logs by date range", async () => {
    const { client, store } = seedWithOrgsAndKeys();
    const service = createUsageService(client);
    const now = Date.now();

    await service.createUsageLog(validInput());
    await service.createUsageLog(validInput());

    // Pin explicit, unambiguous timestamps rather than relying on wall-clock
    // timing between statements, which could otherwise land in the same
    // millisecond and make the filter boundary flaky.
    const [older, newer] = store.token_logs;
    if (older) older.created_at = new Date(now - 3_600_000).toISOString();
    if (newer) newer.created_at = new Date(now + 3_600_000).toISOString();

    const cutoff = new Date(now).toISOString();
    const page = await service.getOrganizationLogs(
      ORG_A,
      { startDate: cutoff },
      { page: 1, pageSize: 10 },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(newer?.id);
  });

  it("filters logs by provider", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await service.createUsageLog(validInput({ provider: "openai" }));
    await service.createUsageLog(validInput({ provider: "anthropic" }));

    const page = await service.getOrganizationLogs(
      ORG_A,
      { provider: "anthropic" },
      { page: 1, pageSize: 10 },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.provider).toBe("anthropic");
  });

  it("filters logs by model", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await service.createUsageLog(validInput({ modelUsed: "gpt-4o" }));
    await service.createUsageLog(validInput({ modelUsed: "gpt-4o-mini" }));

    const page = await service.getOrganizationLogs(
      ORG_A,
      { model: "gpt-4o-mini" },
      { page: 1, pageSize: 10 },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.modelUsed).toBe("gpt-4o-mini");
  });

  it("rejects an invalid organization ID for summaries and logs", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    await expect(service.getOrganizationUsageSummary("not-a-uuid")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(service.getOrganizationLogs("not-a-uuid")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("usage log privacy", () => {
  it("has no field for a plaintext API key, authorization token, prompt, or response", async () => {
    const { client } = seedWithOrgsAndKeys();
    const service = createUsageService(client);

    const log = await service.createUsageLog(validInput());
    const fieldNames = Object.keys(log).map((key) => key.toLowerCase());

    // promptTokens/completionTokens are usage *counts*, not prompt/response
    // content, so "prompt"/"response" substrings are checked against the
    // full field name rather than banned outright.
    expect(fieldNames).not.toContain("prompt");
    expect(fieldNames).not.toContain("response");
    for (const forbidden of ["authorization", "apikey", "api_key", "secret", "plaintext"]) {
      expect(fieldNames.some((name) => name.includes(forbidden))).toBe(false);
    }
  });
});
