import type { UsageSource } from "../usage/types.js";

export type { UsageSource };

/**
 * Token usage in TokenGuard's own vocabulary, independent of any
 * provider's response shape. `null` (never 0) means the value isn't
 * known — a provider that didn't report usage, for example.
 */
export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  source: UsageSource;
}

/** What a provider-specific response parser extracts. `model` is the
 * provider's own reported model identifier, or null if the response
 * didn't include one — callers fall back to the requested model. */
export interface ParsedProviderResponse {
  model: string | null;
  usage: NormalizedUsage;
}
