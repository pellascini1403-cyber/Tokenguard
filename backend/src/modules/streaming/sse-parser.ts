import type { SseEvent } from "./types.js";

/**
 * Incremental SSE (text/event-stream) parser. Feed it arbitrary text
 * chunks — an event split across any number of chunks, several events in
 * one chunk, `\n` or `\r\n` line endings, a `\r`/`\n` split exactly at a
 * chunk boundary — and it emits only fully-terminated events (a blank
 * line closes an event, per the SSE spec).
 *
 * This parser is purely an internal *inspection* tool: it never feeds
 * back into what TokenGuard forwards to the client (the raw upstream
 * bytes are written to the client separately and unmodified — see
 * stream-pump.ts). Its own buffer holds at most one in-flight, not yet
 * terminated event's worth of text, so memory use does not grow with the
 * total size of the stream.
 */
export class SseParser {
  private buffer = "";
  private eventType: string | null = null;
  private dataLines: string[] = [];
  private lastEventId: string | null = null;

  /** Parses as many complete events as the accumulated buffer allows,
   * returning them, and retains any trailing incomplete line/event for
   * the next call. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let pos = 0;

    for (;;) {
      const extracted = this.extractLine(pos);
      if (extracted === null) {
        break;
      }
      const { line, nextPos } = extracted;
      pos = nextPos;

      if (line === "") {
        const event = this.dispatchIfReady();
        if (event) {
          events.push(event);
        }
      } else if (!line.startsWith(":")) {
        this.processField(line);
      }
      // Lines starting with ":" are comments (e.g. keep-alive pings) —
      // ignored, per the SSE spec.
    }

    this.buffer = this.buffer.slice(pos);
    return events;
  }

  /** Finds the next terminated line starting at `pos`. Returns null if
   * the buffer doesn't yet contain a full line — including the case
   * where the buffer ends in a lone `\r` that might be the first half of
   * a `\r\n` pair split across chunks; the caller must wait for more
   * data rather than guessing. */
  private extractLine(pos: number): { line: string; nextPos: number } | null {
    for (let i = pos; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (char === "\n") {
        return { line: this.buffer.slice(pos, i), nextPos: i + 1 };
      }
      if (char === "\r") {
        if (i + 1 < this.buffer.length) {
          const isCrlf = this.buffer[i + 1] === "\n";
          return { line: this.buffer.slice(pos, i), nextPos: i + (isCrlf ? 2 : 1) };
        }
        return null;
      }
    }
    return null;
  }

  private processField(line: string): void {
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        this.lastEventId = value;
        break;
      default:
        // "retry" and any unrecognized field: TokenGuard doesn't need
        // them and ignores them, matching how it never invents fields
        // upstream didn't send.
        break;
    }
  }

  /** Per spec, a blank line only dispatches an event when at least one
   * `data:` line was seen since the last dispatch (an empty `data:`
   * line still counts — it pushes an empty string). */
  private dispatchIfReady(): SseEvent | null {
    const hasData = this.dataLines.length > 0;
    const event = hasData
      ? { event: this.eventType, data: this.dataLines.join("\n"), id: this.lastEventId }
      : null;
    this.eventType = null;
    this.dataLines = [];
    return event;
  }
}
