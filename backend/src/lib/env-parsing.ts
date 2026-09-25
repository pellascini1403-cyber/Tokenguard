/**
 * Parses a positive-integer environment variable, falling back to
 * `defaultValue` when unset/empty. Shared by `config/env.ts` and any
 * module that owns its own slice of environment configuration (e.g.
 * `modules/loop-detection/configuration.ts`), so validation behavior and
 * error messages stay identical everywhere an env var is read this way.
 */
export function parsePositiveInt(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label} value: "${value}". Expected a positive integer.`);
  }
  return parsed;
}
