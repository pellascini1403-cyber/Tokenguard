/**
 * Whether an upstream response is actually an SSE stream. Providers
 * respond with `text/event-stream` only once they've accepted the
 * request and started generating; a rejected request (bad credentials,
 * rate limit, malformed body, etc.) gets a normal JSON error response
 * instead — the proxy uses this to decide which path to take (see
 * streaming-proxy.ts).
 */
export function isEventStreamContentType(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().startsWith("text/event-stream");
}
