import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedUpstreamRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface FakeUpstreamResponse {
  kind?: "json";
  status: number;
  body: string | Buffer;
  contentType?: string;
}

/**
 * A genuine multi-chunk SSE response: chunks are written to the socket
 * one at a time (optionally spaced by `chunkDelayMs`), proving real
 * streaming timing rather than one buffered write. `destroyAfterChunks`
 * abruptly kills the TCP connection after N chunks (no proper SSE
 * termination), simulating a provider disconnecting mid-stream.
 */
export interface FakeUpstreamSseResponse {
  kind: "sse";
  status?: number;
  chunks: string[];
  chunkDelayMs?: number;
  destroyAfterChunks?: number;
  headers?: Record<string, string>;
}

export type FakeUpstreamHandlerResult = FakeUpstreamResponse | FakeUpstreamSseResponse | void;

export interface FakeUpstreamOptions {
  status?: number;
  body?: string | Buffer;
  contentType?: string;
  /** Delay before responding, to simulate a slow/unresponsive provider. */
  delayMs?: number;
  /** Overrides the default response per request, given the captured request. */
  handler?: (request: CapturedUpstreamRequest) => FakeUpstreamHandlerResult;
}

export interface FakeUpstreamServer {
  url: string;
  requests: CapturedUpstreamRequest[];
  /**
   * Count of SSE responses whose underlying socket closed before the
   * response was properly ended — i.e. the client (TokenGuard) tore down
   * the connection to this upstream mid-stream. Used to prove that a
   * client disconnect propagates into an aborted upstream request.
   */
  sseAbortedConnections: number;
  close(): Promise<void>;
}

/** A real local HTTP server standing in for OpenAI/Anthropic in tests —
 * never depends on a real provider. */
export function startFakeUpstreamServer(
  options: FakeUpstreamOptions = {},
): Promise<FakeUpstreamServer> {
  const requests: CapturedUpstreamRequest[] = [];
  const abortState = { count: 0 };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedUpstreamRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);

      const respond = (): void => {
        const override = options.handler?.(captured);

        if (override && override.kind === "sse") {
          const status = override.status ?? 200;
          res.writeHead(status, {
            "content-type": "text/event-stream",
            ...override.headers,
          });
          res.on("close", () => {
            if (!res.writableEnded) {
              abortState.count += 1;
            }
          });
          const delayMs = override.chunkDelayMs ?? 0;
          let index = 0;
          const writeNext = (): void => {
            if (index >= override.chunks.length) {
              return;
            }
            const written = override.chunks[index] as string;
            index += 1;
            if (override.destroyAfterChunks !== undefined && index >= override.destroyAfterChunks) {
              // Give the socket a tick to actually flush the bytes already
              // written before tearing the connection down — an immediate
              // destroy() can race the OS write, corrupting the framing so
              // the client never even sees the chunks sent before it.
              res.write(written, () => res.destroy());
              return;
            }
            res.write(written);
            if (index >= override.chunks.length) {
              res.end();
              return;
            }
            setTimeout(writeNext, delayMs);
          };
          writeNext();
          return;
        }

        const status = override?.status ?? options.status ?? 200;
        const body = override?.body ?? options.body ?? JSON.stringify({ ok: true });
        const contentType = override?.contentType ?? options.contentType ?? "application/json";
        res.writeHead(status, { "content-type": contentType });
        res.end(body);
      };

      if (options.delayMs) {
        setTimeout(respond, options.delayMs);
      } else {
        respond();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        reject(new Error("Failed to determine fake upstream server address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        get sseAbortedConnections() {
          return abortState.count;
        },
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
