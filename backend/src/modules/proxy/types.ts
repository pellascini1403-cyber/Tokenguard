import type { Provider } from "../usage/types.js";

/**
 * Everything the usage-recording orchestration needs about one proxied
 * call, gathered once in the route so it isn't threaded through many
 * layers as loose parameters. Deliberately excludes: the provider API
 * key, the TokenGuard API key (plaintext or otherwise), prompts,
 * response content, and any header value — this context is metadata
 * only, exactly like the token_logs row it eventually produces.
 */
export interface ProxyRequestContext {
  /** Same value returned to the client as X-TokenGuard-Request-Id. */
  requestId: string;
  organizationId: string;
  tokenGuardKeyId: string;
  provider: Provider;
  /** The `model` field from the client's request body, if present —
   * used as a fallback when the provider's response doesn't echo one. */
  requestedModel: string | null;
  /** High-resolution start time (performance.now()), used only to
   * compute duration — never persisted or logged directly. */
  startedAt: number;
}
