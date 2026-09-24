import type { IncomingHttpHeaders } from "node:http";
import { AppError, upstreamTimeoutError, upstreamUnavailableError } from "../../lib/errors.js";
import type { ProviderAdapter, ProviderStreamForwardResult } from "./types.js";

export interface RunProviderStreamInput {
  body: Buffer;
  clientHeaders: IncomingHttpHeaders;
}

export interface ProviderStreamSession {
  result: ProviderStreamForwardResult;
  /**
   * Starts the total-stream-duration guard — call once streaming
   * actually begins (after headers are already in hand), not before.
   * A single chunk trickling in does not reset this timer, so a stream
   * cannot stay open indefinitely just by dribbling data; it is a hard
   * ceiling on the whole streaming phase, separate from the connect
   * timeout already applied above. Returns a disposer; safe to call more
   * than once, and must be called once the stream has ended for any
   * reason (success, error, or abort) to release the timer.
   */
  startStreamGuard(streamMaxDurationMs: number): () => void;
}

/**
 * Establishes an upstream streaming connection. Two independent timeout
 * phases, matching the two different things that can go wrong:
 *
 *  1. Connect phase (this function): bounded by `connectTimeoutMs`
 *     (reusing the same PROVIDER_REQUEST_TIMEOUT_MS config as the
 *     non-streaming path) — how long we wait for the provider to accept
 *     the request and start responding at all.
 *  2. Stream phase (ProviderStreamSession#startStreamGuard, started by
 *     the caller once streaming begins): bounded by
 *     STREAM_MAX_DURATION_MS — a hard ceiling on the total time a
 *     stream may stay open, regardless of how many chunks arrive.
 *
 * Also wires client disconnect (`clientAbortSignal`) to abort the
 * upstream request at any point in either phase — TokenGuard never lets
 * a provider keep generating for a client that has already left.
 */
export async function startProviderStream(
  adapter: ProviderAdapter,
  input: RunProviderStreamInput,
  connectTimeoutMs: number,
  clientAbortSignal: AbortSignal,
): Promise<ProviderStreamSession> {
  const controller = new AbortController();
  const forwardClientAbort = (): void => controller.abort();
  clientAbortSignal.addEventListener("abort", forwardClientAbort, { once: true });

  let disposed = false;
  const disposeClientAbortForwarding = (): void => {
    if (!disposed) {
      disposed = true;
      clientAbortSignal.removeEventListener("abort", forwardClientAbort);
    }
  };

  const connectTimeout = setTimeout(() => controller.abort(), connectTimeoutMs);
  let result: ProviderStreamForwardResult;
  try {
    result = await adapter.forwardStream({ ...input, signal: controller.signal });
  } catch (error) {
    disposeClientAbortForwarding();
    if (error instanceof AppError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw upstreamTimeoutError();
    }
    throw upstreamUnavailableError();
  } finally {
    clearTimeout(connectTimeout);
  }

  return {
    result,
    startStreamGuard(streamMaxDurationMs: number): () => void {
      const streamTimeout = setTimeout(() => controller.abort(), streamMaxDurationMs);
      let guardDisposed = false;
      return () => {
        if (!guardDisposed) {
          guardDisposed = true;
          clearTimeout(streamTimeout);
        }
        disposeClientAbortForwarding();
      };
    },
  };
}
