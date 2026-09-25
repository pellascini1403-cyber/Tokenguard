import { describe, expect, it } from "vitest";
import {
  getBudgetPeriodEnd,
  getBudgetPeriodStart,
} from "../../src/modules/budget/budget-period.js";

describe("getBudgetPeriodStart", () => {
  it("returns the UTC first-of-month for a September date", () => {
    const at = new Date("2026-09-15T12:30:00.000Z");
    expect(getBudgetPeriodStart(at)).toBe("2026-09-01");
  });

  it("returns the UTC first-of-month for an October date — a different period than September", () => {
    const at = new Date("2026-10-15T12:30:00.000Z");
    expect(getBudgetPeriodStart(at)).toBe("2026-10-01");
    expect(getBudgetPeriodStart(at)).not.toBe(
      getBudgetPeriodStart(new Date("2026-09-15T12:30:00.000Z")),
    );
  });

  it("treats the last instant of September (UTC) as still belonging to September", () => {
    const at = new Date("2026-09-30T23:59:59.999Z");
    expect(getBudgetPeriodStart(at)).toBe("2026-09-01");
  });

  it("treats the first instant of October (UTC) as already belonging to October", () => {
    const at = new Date("2026-10-01T00:00:00.000Z");
    expect(getBudgetPeriodStart(at)).toBe("2026-10-01");
  });

  it("uses UTC, not the server's local timezone, for the boundary", () => {
    // 2026-09-30T23:30:00-01:00 is 2026-10-01T00:30:00Z — already October
    // in UTC, regardless of what a local-timezone read of this instant
    // might suggest.
    const at = new Date("2026-09-30T23:30:00.000-01:00");
    expect(getBudgetPeriodStart(at)).toBe("2026-10-01");
  });

  it("pads single-digit months", () => {
    expect(getBudgetPeriodStart(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-01");
  });
});

describe("getBudgetPeriodEnd", () => {
  it("returns the first instant of the following month for a mid-year period", () => {
    const end = getBudgetPeriodEnd("2026-09-01");
    expect(end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rolls over the year boundary for December", () => {
    const end = getBudgetPeriodEnd("2026-12-01");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("throws on a malformed period start", () => {
    expect(() => getBudgetPeriodEnd("not-a-date")).toThrow();
    expect(() => getBudgetPeriodEnd("2026-09-15")).toThrow();
  });
});
