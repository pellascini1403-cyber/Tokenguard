import type { IncomingHttpHeaders } from "node:http";

/** Node normalizes incoming header names to lowercase; a header can still
 * arrive as an array if sent multiple times. Adapters use this to read
 * exactly the one client header they need — never the full header set. */
export function getClientHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}
