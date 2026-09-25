/**
 * The monthly budget period is always a UTC calendar month —
 * 2026-09-01T00:00:00.000Z through 2026-09-30T23:59:59.999Z belongs to
 * one period, regardless of the server's local timezone. A period is
 * identified by its first day as a plain "YYYY-MM-01" date string,
 * matching the `date` column in organization_budget_periods.
 */
export function getBudgetPeriodStart(at: Date = new Date()): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/**
 * The instant (UTC) at which `periodStart`'s period ends and the next
 * one begins — the exclusive upper boundary, and a meaningful
 * `Retry-After` reference point once a budget is exhausted, since the
 * next period always starts with zero committed spend.
 */
export function getBudgetPeriodEnd(periodStart: string): Date {
  const match = /^(\d{4})-(\d{2})-01$/.exec(periodStart);
  if (!match) {
    throw new Error(`Invalid budget period start: "${periodStart}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-indexed in the string.
  // Date.UTC's month parameter is 0-indexed, so passing the 1-indexed
  // `month` as-is lands on the 1st of the *next* calendar month — the
  // exclusive end boundary this function returns.
  return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
}
