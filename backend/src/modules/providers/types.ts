import type { IncomingHttpHeaders } from "node:http";
import type { Provider } from "../usage/types.js";

export type { Provider };

/**
 * What an adapter needs to forward one request. `body` is the client's
 * raw request bytes, forwarded to the provider unmodified — never
 * re-parsed and re-serialized. `clientHeaders` is the full incoming
 * header set; each adapter picks only the specific headers it needs
 * (e.g. authorization for OpenAI, x-api-key for Anthropic) rather than
 * forwarding anything blindly. Shared by both the buffered (`forward`)
 * and streaming (`forwardStream`) request paths.
 */
export interface ProviderForwardInput {
  body: Buffer;
  clientHeaders: IncomingHttpHeaders;
  signal: AbortSignal;
}

export interface ProviderForwardResult {
  status: number;
  /** Raw upstream response bytes, returned to the client unmodified. */
  body: Buffer;
  contentType: string | null;
}

/**
 * Same request/response metadata as ProviderForwardResult, but with the
 * body left as an unconsumed stream — the caller decides whether to
 * forward it live (a real SSE response) or buffer it (the provider
 * rejected the request before streaming began; see
 * isEventStreamContentType).
 */
export interface ProviderStreamForwardResult {
  status: number;
  contentType: string | null;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * A provider adapter knows how to reach exactly one upstream AI API:
 * which endpoint to call, which headers it needs from the client, and how
 * to execute the request. Adding a new provider means writing a new
 * adapter, not touching the proxy routes.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  forward(input: ProviderForwardInput): Promise<ProviderForwardResult>;
  /** Same request, but the response body is left unbuffered for the
   * caller to stream to the client. */
  forwardStream(input: ProviderForwardInput): Promise<ProviderStreamForwardResult>;
}
