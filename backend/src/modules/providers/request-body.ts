import { badRequestError } from "../../lib/errors.js";

export interface InspectedRequestBody {
  /** The client's requested `model`, used as a fallback when the
   * provider's response doesn't echo one back (see usage parsers). */
  requestedModel: string | null;
  /** Whether the client requested `stream: true`. */
  isStreaming: boolean;
}

/**
 * Extracts what the route needs to decide how to handle a proxy request
 * — the requested model (usage-log fallback) and whether streaming was
 * requested — without touching what actually gets forwarded upstream.
 * This is the only reason the raw body is ever parsed here; the original
 * buffer, not this parsed value, is what gets forwarded, never a
 * re-serialized reconstruction of it.
 */
export function inspectProxyRequestBody(rawBody: Buffer): InspectedRequestBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw badRequestError("Request body must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequestError("Request body must be a JSON object");
  }

  const body = parsed as Record<string, unknown>;
  return {
    requestedModel: typeof body.model === "string" && body.model.length > 0 ? body.model : null,
    isStreaming: body.stream === true,
  };
}
