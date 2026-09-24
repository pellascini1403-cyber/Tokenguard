import { badRequestError, streamingNotImplementedError } from "../../lib/errors.js";

/**
 * Rejects `stream: true` requests before any upstream contact, per Step 4
 * scope (streaming lands in Step 6). This is the only reason the raw body
 * is ever parsed — the parsed value is discarded immediately afterward;
 * the original buffer is what gets forwarded upstream, never a
 * re-serialized reconstruction of it.
 */
export function rejectIfStreamingRequested(rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw badRequestError("Request body must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequestError("Request body must be a JSON object");
  }

  if ((parsed as Record<string, unknown>).stream === true) {
    throw streamingNotImplementedError();
  }
}
