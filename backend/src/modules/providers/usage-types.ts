import type { SseEvent } from "../streaming/types.js";
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

/**
 * The streaming counterpart of parseOpenAiResponse/parseAnthropicResponse
 * (which parse one complete JSON body): consumes SSE events one at a
 * time as they arrive, and produces the same ParsedProviderResponse once
 * the stream ends. Provider-specific (each provider streams a different
 * event shape) — the generic SSE transport (src/modules/streaming) never
 * implements this itself, only calls it.
 */
export interface StreamUsageAccumulator {
  /** Never throws — a malformed or unexpected event is ignored rather
   * than aborting the stream, since a usage-extraction failure must
   * never break the client's already-flowing response. */
  handleEvent(event: SseEvent): void;
  finalize(): ParsedProviderResponse;
}
