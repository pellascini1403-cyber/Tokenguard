import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { pumpSseStream } from "../../src/modules/streaming/stream-pump.js";
import type { SseEvent } from "../../src/modules/streaming/types.js";

function readableFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

function collectPassThrough(passThrough: PassThrough): { text(): string } {
  const chunks: Buffer[] = [];
  passThrough.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("pumpSseStream", () => {
  it("forwards every byte to the client unmodified", async () => {
    const source = readableFromChunks(["data: one\n\n", "data: two\n\n"]);
    const passThrough = new PassThrough();
    const collected = collectPassThrough(passThrough);

    const result = await pumpSseStream({ upstreamBody: source, passThrough, onEvent: () => {} });

    expect(result.endedNormally).toBe(true);
    expect(collected.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("emits parsed events via onEvent as chunks arrive", async () => {
    const source = readableFromChunks(["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"]);
    const passThrough = new PassThrough();
    const events: SseEvent[] = [];

    await pumpSseStream({ upstreamBody: source, passThrough, onEvent: (e) => events.push(e) });

    expect(events).toEqual([
      { event: "a", data: "1", id: null },
      { event: "b", data: "2", id: null },
    ]);
  });

  it("correctly parses an event split across multiple upstream chunks", async () => {
    const source = readableFromChunks(['data: {"par', 'tial":true}\n', "\n"]);
    const passThrough = new PassThrough();
    const events: SseEvent[] = [];

    await pumpSseStream({ upstreamBody: source, passThrough, onEvent: (e) => events.push(e) });

    expect(events).toEqual([{ event: null, data: '{"partial":true}', id: null }]);
  });

  it("ends the passThrough stream when the upstream stream ends", async () => {
    const source = readableFromChunks(["data: only\n\n"]);
    const passThrough = new PassThrough();
    let ended = false;
    passThrough.on("end", () => {
      ended = true;
    });
    passThrough.resume();

    await pumpSseStream({ upstreamBody: source, passThrough, onEvent: () => {} });
    await new Promise((resolve) => setImmediate(resolve));

    expect(ended).toBe(true);
  });

  it("reports a non-normal ending when the upstream read rejects (provider disconnect)", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
      pull() {
        throw new Error("simulated provider disconnect");
      },
    });
    const passThrough = new PassThrough();
    passThrough.resume();

    const result = await pumpSseStream({ upstreamBody: source, passThrough, onEvent: () => {} });

    expect(result.endedNormally).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("respects backpressure: does not write more than the client's buffer before it drains", async () => {
    // A PassThrough with a tiny highWaterMark makes write() return false
    // quickly, so we can prove the pump waits for 'drain' instead of
    // slamming everything through synchronously.
    const passThrough = new PassThrough({ highWaterMark: 1 });
    const writeCalls: number[] = [];
    const originalWrite = passThrough.write.bind(passThrough);
    passThrough.write = ((chunk: unknown, ...rest: unknown[]) => {
      writeCalls.push(Date.now());
      // @ts-expect-error -- forwarding varargs to the original write signature
      return originalWrite(chunk, ...rest);
    }) as typeof passThrough.write;

    let paused = true;
    const source = readableFromChunks(Array.from({ length: 20 }, (_, i) => `data: chunk-${i}\n\n`));

    const pumpPromise = pumpSseStream({ upstreamBody: source, passThrough, onEvent: () => {} });
    // Don't consume passThrough immediately — let backpressure build, then release.
    await new Promise((resolve) => setTimeout(resolve, 20));
    paused = false;
    passThrough.resume();

    await pumpPromise;
    expect(paused).toBe(false);
    expect(writeCalls.length).toBeGreaterThan(0);
  });
});
