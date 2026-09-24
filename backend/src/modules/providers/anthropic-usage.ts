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

function readTokenField(rawUsage: unknown, field: string): number | null {
  if (typeof rawUsage !== "object" || rawUsage === null) {
    return null;
  }
  return parseTokenCount((rawUsage as Record<string, unknown>)[field]);
}

/**
 * Consumes Anthropic Messages streaming events as they arrive. Unlike
 * OpenAI, Anthropic's usage is spread across two event types:
 * `message_start` carries the initial usage (input_tokens, and usually
 * an early output_tokens), and one or more `message_delta` events carry
 * updated, cumulative usage as generation proceeds — the last
 * `message_delta` before `message_stop` holds the final counts. Each
 * newly-seen field simply overwrites the running value; nothing is
 * summed across events, since Anthropic's own counts are already
 * cumulative.
 */
export function createAnthropicStreamUsageAccumulator(
  requestedModel: string | null,
): StreamUsageAccumulator {
  let model: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  return {
    handleEvent(event: SseEvent): void {
      const data = event.data.trim();
      if (data === "") {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // Malformed event — ignore, never break the stream over it.
      }
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }

      const payload = parsed as Record<string, unknown>;
      if (payload.type === "message_start") {
        const message = payload.message;
        if (typeof message === "object" && message !== null) {
          const messageObj = message as Record<string, unknown>;
          if (typeof messageObj.model === "string" && messageObj.model.length > 0) {
            model = messageObj.model;
          }
          const startInput = readTokenField(messageObj.usage, "input_tokens");
          const startOutput = readTokenField(messageObj.usage, "output_tokens");
          if (startInput !== null) inputTokens = startInput;
          if (startOutput !== null) outputTokens = startOutput;
        }
      } else if (payload.type === "message_delta") {
        const deltaInput = readTokenField(payload.usage, "input_tokens");
        const deltaOutput = readTokenField(payload.usage, "output_tokens");
        if (deltaInput !== null) inputTokens = deltaInput;
        if (deltaOutput !== null) outputTokens = deltaOutput;
      }
    },
    finalize(): ParsedProviderResponse {
      const usage: NormalizedUsage =
        inputTokens === null && outputTokens === null
          ? UNKNOWN_USAGE
          : mapAnthropicUsage({ input_tokens: inputTokens, output_tokens: outputTokens });
      return { model: model ?? requestedModel, usage };
    },
  };
}
