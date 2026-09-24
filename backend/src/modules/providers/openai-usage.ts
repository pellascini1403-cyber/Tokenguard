import { parseTokenCount } from "./parse-token-count.js";
import type {
  NormalizedUsage,
  ParsedProviderResponse,
  StreamUsageAccumulator,
} from "./usage-types.js";
import type { SseEvent } from "../streaming/types.js";

const UNKNOWN_USAGE: NormalizedUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  source: "unknown",
};

/**
 * Maps an OpenAI Chat Completions `usage` object to TokenGuard's
 * normalized shape. A pure function, independent of how the raw usage
 * object was obtained — reusable by Step 6's streaming flow (which will
 * extract it from SSE events instead of a JSON body) without change.
 *
 * `total_tokens` is taken directly from the provider, never recomputed
 * from prompt+completion — if OpenAI ever reports an inconsistent trio,
 * that value is preserved as-received rather than silently corrected;
 * downstream persistence validation (see usage.service.ts) is what
 * surfaces the anomaly, safely, rather than this parser guessing at it.
 */
export function mapOpenAiUsage(rawUsage: unknown): NormalizedUsage {
  if (typeof rawUsage !== "object" || rawUsage === null) {
    return UNKNOWN_USAGE;
  }
  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = parseTokenCount(usage.prompt_tokens);
  const outputTokens = parseTokenCount(usage.completion_tokens);
  const totalTokens = parseTokenCount(usage.total_tokens);

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return UNKNOWN_USAGE;
  }
  return { inputTokens, outputTokens, totalTokens, source: "provider" };
}

/**
 * Parses a non-streaming Chat Completions response body. Never throws —
 * a malformed or unexpected body simply yields unknown usage, since a
 * usage-extraction failure must never turn into a failed AI request (the
 * response has already been forwarded to the client by the time this
 * runs; see the proxy routes).
 */
export function parseOpenAiResponse(
  body: Buffer,
  requestedModel: string | null,
): ParsedProviderResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { model: requestedModel, usage: UNKNOWN_USAGE };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { model: requestedModel, usage: UNKNOWN_USAGE };
  }

  const response = parsed as Record<string, unknown>;
  const model =
    typeof response.model === "string" && response.model.length > 0
      ? response.model
      : requestedModel;

  return { model, usage: mapOpenAiUsage(response.usage) };
}

/**
 * Consumes OpenAI Chat Completions streaming events as they arrive.
 * Usage is NOT automatic: OpenAI only includes a final chunk with a
 * top-level `usage` field when the client requests it (via
 * `stream_options: {"include_usage": true}` in the request body).
 * TokenGuard forwards the client's body unmodified (per the proxy's
 * transparency contract) and never injects that option itself — so if
 * the client didn't ask for it, no chunk will ever carry usage, and
 * `finalize()` correctly yields `source: "unknown"`. There is no second
 * request to the provider to "fetch" usage after the fact.
 */
export function createOpenAiStreamUsageAccumulator(
  requestedModel: string | null,
): StreamUsageAccumulator {
  let model: string | null = null;
  let usage: NormalizedUsage = UNKNOWN_USAGE;

  return {
    handleEvent(event: SseEvent): void {
      const data = event.data.trim();
      if (data === "" || data === "[DONE]") {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // Malformed chunk — ignore, never break the stream over it.
      }
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }

      const chunk = parsed as Record<string, unknown>;
      if (model === null && typeof chunk.model === "string" && chunk.model.length > 0) {
        model = chunk.model;
      }
      if (chunk.usage !== undefined) {
        usage = mapOpenAiUsage(chunk.usage);
      }
    },
    finalize(): ParsedProviderResponse {
      return { model: model ?? requestedModel, usage };
    },
  };
}
