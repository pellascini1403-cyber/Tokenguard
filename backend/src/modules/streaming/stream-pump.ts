import { once } from "node:events";
import type { PassThrough } from "node:stream";
import { SseParser } from "./sse-parser.js";
import type { SseEvent } from "./types.js";

export interface PumpSseStreamInput {
  upstreamBody: ReadableStream<Uint8Array>;
  /** Bytes are written here immediately and unmodified, in the same
   * chunks they arrive from upstream — this is what the client
   * ultimately receives. */
  passThrough: PassThrough;
  /** Called once per fully-parsed SSE event, for internal inspection
   * only (e.g. extracting usage) — never influences what is forwarded. */
  onEvent: (event: SseEvent) => void;
}

export interface PumpSseStreamResult {
  /** True if the upstream stream ended on its own (successful completion
   * or a provider-sent terminal frame) rather than being aborted
   * (timeout/client disconnect) or failing outright (a dropped upstream
   * connection). */
  endedNormally: boolean;
  error: unknown;
}

/**
 * Reads upstream bytes and, per chunk: forwards it to the client
 * immediately (respecting the client's own backpressure via the
 * PassThrough's write()/'drain' signal — pausing the upstream read loop
 * until the client catches up, so a slow client cannot cause unbounded
 * buffering), and feeds a decoded copy into the SSE parser purely for
 * internal usage inspection. Memory use is bounded by the SSE parser's
 * own internal buffer (at most one in-flight event's worth of text),
 * never the size of the response as a whole.
 *
 * Never throws: any read failure (client/upstream disconnect, the
 * timeout/max-duration AbortSignal firing) is caught and reported in the
 * result so the caller can still finalize usage with whatever was
 * captured before the interruption.
 */
export async function pumpSseStream(input: PumpSseStreamInput): Promise<PumpSseStreamResult> {
  const reader = input.upstreamBody.getReader();
  const parser = new SseParser();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!input.passThrough.write(value)) {
        await once(input.passThrough, "drain");
      }

      const text = decoder.decode(value, { stream: true });
      for (const event of parser.push(text)) {
        input.onEvent(event);
      }
    }
    return { endedNormally: true, error: null };
  } catch (error) {
    return { endedNormally: false, error };
  } finally {
    input.passThrough.end();
  }
}
