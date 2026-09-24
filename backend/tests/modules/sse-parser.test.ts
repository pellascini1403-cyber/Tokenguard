import { describe, expect, it } from "vitest";
import { SseParser } from "../../src/modules/streaming/sse-parser.js";

describe("SseParser", () => {
  it("parses a complete event delivered in a single chunk", () => {
    const parser = new SseParser();
    const events = parser.push('data: {"hello":"world"}\n\n');
    expect(events).toEqual([{ event: null, data: '{"hello":"world"}', id: null }]);
  });

  it("parses an event split across two chunks", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"hel')).toEqual([]);
    const events = parser.push('lo":"world"}\n\n');
    expect(events).toEqual([{ event: null, data: '{"hello":"world"}', id: null }]);
  });

  it("parses an event split across many chunks, byte by byte", () => {
    const parser = new SseParser();
    const full = 'event: chunk\ndata: {"a":1}\n\n';
    const events = [];
    for (const char of full) {
      events.push(...parser.push(char));
    }
    expect(events).toEqual([{ event: "chunk", data: '{"a":1}', id: null }]);
  });

  it("parses multiple events delivered in a single chunk", () => {
    const parser = new SseParser();
    const events = parser.push("data: one\n\ndata: two\n\ndata: three\n\n");
    expect(events).toEqual([
      { event: null, data: "one", id: null },
      { event: null, data: "two", id: null },
      { event: null, data: "three", id: null },
    ]);
  });

  it("supports \\n line endings", () => {
    const parser = new SseParser();
    const events = parser.push("event: foo\ndata: bar\n\n");
    expect(events).toEqual([{ event: "foo", data: "bar", id: null }]);
  });

  it("supports \\r\\n line endings", () => {
    const parser = new SseParser();
    const events = parser.push("event: foo\r\ndata: bar\r\n\r\n");
    expect(events).toEqual([{ event: "foo", data: "bar", id: null }]);
  });

  it("handles a \\r\\n blank-line delimiter split exactly at the chunk boundary", () => {
    const parser = new SseParser();
    // The final \r\n\r\n delimiter is split so the first chunk ends
    // right after the \r of the first \r\n.
    expect(parser.push("data: bar\r")).toEqual([]);
    const events = parser.push("\n\r\n");
    expect(events).toEqual([{ event: null, data: "bar", id: null }]);
  });

  it("handles a lone \\r at the very end of a chunk (possible start of \\r\\n)", () => {
    const parser = new SseParser();
    // \r arrives alone; parser must wait rather than guessing it's a
    // line terminator, since the next chunk might bring the \n half.
    expect(parser.push("data: bar\r")).toEqual([]);
    const events = parser.push("\r"); // now it's a lone \r line ending (Mac-classic style)
    expect(events).toEqual([]); // still waiting for the blank-line terminator
    const finalEvents = parser.push("\r");
    expect(finalEvents).toEqual([{ event: null, data: "bar", id: null }]);
  });

  it("dispatches an event with an empty data field", () => {
    const parser = new SseParser();
    const events = parser.push("data:\n\n");
    expect(events).toEqual([{ event: null, data: "", id: null }]);
  });

  it("joins multiple data: lines within one event with \\n", () => {
    const parser = new SseParser();
    const events = parser.push("data: line one\ndata: line two\n\n");
    expect(events).toEqual([{ event: null, data: "line one\nline two", id: null }]);
  });

  it("captures the id field and retains it across subsequent events without one", () => {
    const parser = new SseParser();
    const events = parser.push("id: 42\ndata: first\n\ndata: second\n\n");
    expect(events).toEqual([
      { event: null, data: "first", id: "42" },
      { event: null, data: "second", id: "42" },
    ]);
  });

  it("ignores comment lines (starting with ':')", () => {
    const parser = new SseParser();
    const events = parser.push(": keep-alive\ndata: real\n\n");
    expect(events).toEqual([{ event: null, data: "real", id: null }]);
  });

  it("does not dispatch an event that only has event:/id: fields and no data:", () => {
    const parser = new SseParser();
    const events = parser.push("event: ping\nid: 1\n\ndata: real\n\n");
    // Per the SSE spec, a blank line only dispatches when the data
    // buffer is non-empty.
    expect(events).toEqual([{ event: null, data: "real", id: "1" }]);
  });

  it("handles fragmented delimiters across many small, arbitrary-sized chunks", () => {
    const parser = new SseParser();
    const source = "event: a\ndata: one\n\ndata: two\r\n\r\nevent: b\r\ndata: three\n\n";
    const chunkSizes = [3, 1, 7, 2, 5, 4, 1, 1, 1, 6, 8, 1000];
    let offset = 0;
    const events = [];
    for (const size of chunkSizes) {
      if (offset >= source.length) break;
      const chunk = source.slice(offset, offset + size);
      offset += size;
      events.push(...parser.push(chunk));
    }
    if (offset < source.length) {
      events.push(...parser.push(source.slice(offset)));
    }

    expect(events).toEqual([
      { event: "a", data: "one", id: null },
      { event: null, data: "two", id: null },
      { event: "b", data: "three", id: null },
    ]);
  });

  it("keeps only the trailing incomplete event in memory, not the whole stream", () => {
    const parser = new SseParser();
    // Push a large number of complete events — none should accumulate.
    for (let i = 0; i < 1000; i += 1) {
      const events = parser.push(`data: event-${i}\n\n`);
      expect(events).toHaveLength(1);
    }
    // Only an incomplete trailing chunk remains buffered internally.
    parser.push("data: incompl");
    // @ts-expect-error -- reaching into private state deliberately, only to prove boundedness
    expect(parser.buffer.length).toBeLessThan(50);
  });
});
