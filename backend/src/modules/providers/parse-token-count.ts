/** A token count is trusted only if it's a sane non-negative integer —
 * anything else (missing, NaN, negative, fractional) is treated as
 * unknown rather than risking a garbage value flowing into a usage log. */
export function parseTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
