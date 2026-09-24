import type { IncomingHttpHeaders } from "node:http";
import { AppError, upstreamTimeoutError, upstreamUnavailableError } from "../../lib/errors.js";
import type { ProviderAdapter, ProviderForwardResult } from "./types.js";

export interface RunProviderRequestInput {
  body: Buffer;
  clientHeaders: IncomingHttpHeaders;
}

/**
 * Cross-cutting orchestration shared by every provider route: applies the
 * request timeout and turns adapter failures into TokenGuard's error
 * envelope. Adapters themselves stay focused on "how to talk to this
 * provider" — timeout policy and error shaping live here once, not
 * duplicated per adapter.
 */
export async function runProviderRequest(
  adapter: ProviderAdapter,
  input: RunProviderRequestInput,
  timeoutMs: number,
): Promise<ProviderForwardResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await adapter.forward({ ...input, signal: controller.signal });
  } catch (error) {
    // A validation error the adapter raised itself (e.g. a missing
    // provider credential header) — not a network failure, pass through.
    if (error instanceof AppError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw upstreamTimeoutError();
    }
    throw upstreamUnavailableError();
  } finally {
    clearTimeout(timeout);
  }
}
