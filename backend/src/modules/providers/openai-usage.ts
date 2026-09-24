import { parseTokenCount } from "./parse-token-count.js";
import type { NormalizedUsage, ParsedProviderResponse } from "./usage-types.js";

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
