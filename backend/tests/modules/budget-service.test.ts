import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBudgetService } from "../../src/modules/budget/budget.service.js";
import { createFakeAdminClient, type FakeStore } from "../helpers/fake-admin-client.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERIOD = "2026-09-01";
const OTHER_PERIOD = "2026-10-01";

function buildStore(budgetUsd: string, extra: Partial<FakeStore> = {}) {
  return createFakeAdminClient({
    organizations: [{ id: ORG_ID, name: "Org A", monthly_budget_usd: budgetUsd }],
    ...extra,
  });
}

/** As of Step 9, a budget charge no longer requires a token_logs row to
 * exist first (see the migration decoupling the FK) — this helper seeds
 * one anyway for tests that specifically want to exercise the
 * defense-in-depth organization-match check, which still applies when a
 * matching row happens to already be present. */
function seedTokenLog(store: FakeStore, requestId: string, organizationId = ORG_ID) {
  store.token_logs.push({
    id: randomUUID(),
    organization_id: organizationId,
    token_guard_key_id: null,
    provider: "openai",
    model_used: "gpt-4o",
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
    input_cost_usd: "1.00000000",
    output_cost_usd: "1.00000000",
    total_cost_usd: "2.00000000",
    usage_source: "provider",
    pricing_version: "v1",
    duration_ms: 10,
    status_code: 200,
    request_id: requestId,
    created_at: new Date().toISOString(),
  });
}

describe("budget admission (Phase A)", () => {
  it("allows a request when committed spend is below the budget", async () => {
    const { client } = buildStore("10.00");
    const service = createBudgetService(client);

    const state = await service.checkAdmission(ORG_ID, PERIOD);
    expect(state.allowed).toBe(true);
    expect(state.committedCostUsd).toBe("0.00000000");
    expect(state.monthlyBudgetUsd).toBe("10.00");
  });

  it("rejects a request when committed spend exactly equals the budget", async () => {
    const { client, store } = buildStore("10.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "10.00000000",
    });

    const state = await service.checkAdmission(ORG_ID, PERIOD);
    expect(state.allowed).toBe(false);
  });

  it("rejects a request when committed spend is above the budget", async () => {
    const { client, store } = buildStore("5.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "7.50000000",
    });

    const state = await service.checkAdmission(ORG_ID, PERIOD);
    expect(state.allowed).toBe(false);
  });

  it("keeps different organizations' budgets fully independent", async () => {
    const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { client, store } = createFakeAdminClient({
      organizations: [
        { id: ORG_ID, name: "Org A", monthly_budget_usd: "5.00" },
        { id: orgB, name: "Org B", monthly_budget_usd: "5.00" },
      ],
    });
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId, ORG_ID);

    await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "5.00000000",
    });

    const orgAState = await service.checkAdmission(ORG_ID, PERIOD);
    const orgBState = await service.checkAdmission(orgB, PERIOD);
    expect(orgAState.allowed).toBe(false);
    expect(orgBState.allowed).toBe(true);
    expect(orgBState.committedCostUsd).toBe("0.00000000");
  });

  it("keeps different periods (months) fully independent for the same organization", async () => {
    const { client, store } = buildStore("5.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "5.00000000",
    });

    const septemberState = await service.checkAdmission(ORG_ID, PERIOD);
    const octoberState = await service.checkAdmission(ORG_ID, OTHER_PERIOD);
    expect(septemberState.allowed).toBe(false);
    expect(octoberState.allowed).toBe(true);
    expect(octoberState.committedCostUsd).toBe("0.00000000");
  });
});

describe("budget accounting (Phase B)", () => {
  it("commits a known cost and reflects it in the next admission check", async () => {
    const { client, store } = buildStore("100.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    const result = await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "12.34000000",
    });

    expect(result.applied).toBe(true);
    expect(result.committedCostUsd).toBe("12.34000000");

    const state = await service.checkAdmission(ORG_ID, PERIOD);
    expect(state.committedCostUsd).toBe("12.34000000");
  });

  it("commits a cost that fits within budget without rejecting", async () => {
    const { client, store } = buildStore("100.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    const result = await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "1.00000000",
    });
    expect(result.applied).toBe(true);
  });

  it("still commits (never rejects) a cost that would push spend over budget — the request already happened", async () => {
    const { client, store } = buildStore("5.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    const result = await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "50.00000000",
    });

    expect(result.applied).toBe(true);
    expect(result.committedCostUsd).toBe("50.00000000");

    // The NEXT request is what gets blocked, not this one.
    const state = await service.checkAdmission(ORG_ID, PERIOD);
    expect(state.allowed).toBe(false);
  });

  it("never charges the same request_id twice — a repeated commit is a no-op", async () => {
    const { client, store } = buildStore("100.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    const first = await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "10.00000000",
    });
    const second = await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "10.00000000",
    });
    const third = await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "10.00000000",
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(third.applied).toBe(false);

    const state = await service.checkAdmission(ORG_ID, PERIOD);
    // Only ONE charge of $10 landed, not three.
    expect(state.committedCostUsd).toBe("10.00000000");
  });

  it("accumulates multiple distinct charges correctly", async () => {
    const { client, store } = buildStore("100.00");
    const service = createBudgetService(client);
    const requestIds = [randomUUID(), randomUUID(), randomUUID()];
    requestIds.forEach((id) => seedTokenLog(store, id));

    for (const requestId of requestIds) {
      await service.commitCharge({
        organizationId: ORG_ID,
        requestId,
        periodStart: PERIOD,
        amountUsd: "3.00000000",
      });
    }

    const state = await service.checkAdmission(ORG_ID, PERIOD);
    expect(state.committedCostUsd).toBe("9.00000000");
  });

  it("concurrent commits for the same organization/period all land — none are lost", async () => {
    const { client, store } = buildStore("1000.00");
    const service = createBudgetService(client);
    const requestIds = Array.from({ length: 20 }, () => randomUUID());
    requestIds.forEach((id) => seedTokenLog(store, id));

    await Promise.all(
      requestIds.map((requestId) =>
        service.commitCharge({
          organizationId: ORG_ID,
          requestId,
          periodStart: PERIOD,
          amountUsd: "1.00000000",
        }),
      ),
    );

    const state = await service.checkAdmission(ORG_ID, PERIOD);
    expect(state.committedCostUsd).toBe("20.00000000");
  });

  it("concurrent repeated commits of the SAME request_id apply exactly once", async () => {
    const { client, store } = buildStore("1000.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.commitCharge({
          organizationId: ORG_ID,
          requestId,
          periodStart: PERIOD,
          amountUsd: "5.00000000",
        }),
      ),
    );

    const appliedCount = results.filter((r) => r.applied).length;
    expect(appliedCount).toBe(1);

    const state = await service.checkAdmission(ORG_ID, PERIOD);
    expect(state.committedCostUsd).toBe("5.00000000");
  });
});

describe("budget ledger (organization_budget_periods)", () => {
  it("creates the period row safely on the first request of the month", async () => {
    const { client, store } = buildStore("100.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    expect(store.organization_budget_periods).toHaveLength(0);
    await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "1.00000000",
    });
    expect(store.organization_budget_periods).toHaveLength(1);
  });

  it("does not create duplicate period rows under concurrent first commits", async () => {
    const { client, store } = buildStore("1000.00");
    const service = createBudgetService(client);
    const requestIds = Array.from({ length: 10 }, () => randomUUID());
    requestIds.forEach((id) => seedTokenLog(store, id));

    await Promise.all(
      requestIds.map((requestId) =>
        service.commitCharge({
          organizationId: ORG_ID,
          requestId,
          periodStart: PERIOD,
          amountUsd: "1.00000000",
        }),
      ),
    );

    const periodRows = store.organization_budget_periods.filter(
      (row) => row.organization_id === ORG_ID && row.period_start === PERIOD,
    );
    expect(periodRows).toHaveLength(1);
  });

  it("keeps different months as independent rows", async () => {
    const { client, store } = buildStore("100.00");
    const service = createBudgetService(client);
    const requestA = randomUUID();
    const requestB = randomUUID();
    seedTokenLog(store, requestA);
    seedTokenLog(store, requestB);

    await service.commitCharge({
      organizationId: ORG_ID,
      requestId: requestA,
      periodStart: PERIOD,
      amountUsd: "1.00000000",
    });
    await service.commitCharge({
      organizationId: ORG_ID,
      requestId: requestB,
      periodStart: OTHER_PERIOD,
      amountUsd: "2.00000000",
    });

    expect(store.organization_budget_periods).toHaveLength(2);
    const sept = store.organization_budget_periods.find((r) => r.period_start === PERIOD);
    const oct = store.organization_budget_periods.find((r) => r.period_start === OTHER_PERIOD);
    expect(sept?.committed_cost_usd).toBe("1.00000000");
    expect(oct?.committed_cost_usd).toBe("2.00000000");
  });
});

describe("budget module — never touches raw request/response content", () => {
  it("stores only financial/accounting metadata in the ledger rows", async () => {
    const { client, store } = buildStore("100.00");
    const service = createBudgetService(client);
    const requestId = randomUUID();
    seedTokenLog(store, requestId);

    await service.commitCharge({
      organizationId: ORG_ID,
      requestId,
      periodStart: PERIOD,
      amountUsd: "1.00000000",
    });

    const chargeRow = store.organization_budget_charges[0];
    expect(chargeRow).toBeDefined();
    expect(Object.keys(chargeRow ?? {}).sort()).toEqual(
      ["amount_usd", "created_at", "organization_id", "period_start", "request_id"].sort(),
    );

    const periodRow = store.organization_budget_periods[0];
    expect(Object.keys(periodRow ?? {}).sort()).toEqual(
      ["committed_cost_usd", "organization_id", "period_start", "updated_at"].sort(),
    );
  });
});
