import { randomUUID } from "node:crypto";
import { isUuid } from "./uuid.js";

/**
 * Every request gets a TokenGuard request ID for its whole lifecycle: it
 * becomes the Fastify request id (so it appears in every structured log
 * line for that request), is returned via X-TokenGuard-Request-Id, and
 * will later correlate a proxy request to its usage log. A client-supplied
 * ID is reused only when it is already a UUID — anything else is replaced
 * rather than trusted verbatim.
 */
export function resolveRequestId(clientProvidedId: string | undefined): string {
  if (clientProvidedId && isUuid(clientProvidedId)) {
    return clientProvidedId;
  }
  return randomUUID();
}
