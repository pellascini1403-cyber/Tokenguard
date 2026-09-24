import { badRequestError, streamingNotImplementedError } from "../../lib/errors.js";

export interface InspectedRequestBody {
  /** The client's requested `model`, used as a fallback when the
   * provider's response doesn't echo one back (see usage parsers). */
  requestedModel: string | null;
}

/**
 * Rejects `stream: true` requests before any upstream contact, per Step 4
 * scope (streaming lands in Step 6), and extracts the requested model for
 * later usage-log fallback. This is the only reason the raw body is ever
 * parsed here — the original buffer, not this parsed value, is what gets
 * forwarded upstream, never a re-serialized reconstruction of it.
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
  if (body.stream === true) {
    throw streamingNotImplementedError();
  }

  return {
    requestedModel: typeof body.model === "string" && body.model.length > 0 ? body.model : null,
  };
}
