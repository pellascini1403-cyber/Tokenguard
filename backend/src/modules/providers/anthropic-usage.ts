import { parseTokenCount } from "./parse-token-count.js";
import type { NormalizedUsage, ParsedProviderResponse } from "./usage-types.js";

const UNKNOWN_USAGE: NormalizedUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  source: "unknown",
};

/**
 * Maps an Anthropic Messages `usage` object to TokenGuard's normalized
 * shape. A pure function, independent of how the raw usage object was
 * obtained — reusable by Step 6's streaming flow (which will accumulate
 * it from SSE `message_start`/`message_delta` events instead of a JSON
 * body) without change.
 *
 * Anthropic's usage object has no `total_tokens` field of its own —
 * unlike OpenAI's parser, this one computes totalTokens itself, and only
 * when both input and output are known (never summing a known value with
 * an assumed zero for the unknown half).
 */
export function mapAnthropicUsage(rawUsage: unknown): NormalizedUsage {
  if (typeof rawUsage !== "object" || rawUsage === null) {
    return UNKNOWN_USAGE;
  }
  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = parseTokenCount(usage.input_tokens);
  const outputTokens = parseTokenCount(usage.output_tokens);

  if (inputTokens === null && outputTokens === null) {
    return UNKNOWN_USAGE;
  }

  const totalTokens =
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  return { inputTokens, outputTokens, totalTokens, source: "provider" };
}

/**
 * Parses a non-streaming Messages response body. Never throws — a
 * malformed or unexpected body simply yields unknown usage, since a
 * usage-extraction failure must never turn into a failed AI request (the
 * response has already been forwarded to the client by the time this
 * runs; see the proxy routes).
 */
export function parseAnthropicResponse(
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

  return { model, usage: mapAnthropicUsage(response.usage) };
}
