import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedUpstreamRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface FakeUpstreamResponse {
  status: number;
  body: string | Buffer;
  contentType?: string;
}

export interface FakeUpstreamOptions {
  status?: number;
  body?: string | Buffer;
  contentType?: string;
  /** Delay before responding, to simulate a slow/unresponsive provider. */
  delayMs?: number;
  /** Overrides the default response per request, given the captured request. */
  handler?: (request: CapturedUpstreamRequest) => FakeUpstreamResponse | void;
}

export interface FakeUpstreamServer {
  url: string;
  requests: CapturedUpstreamRequest[];
  close(): Promise<void>;
}

/** A real local HTTP server standing in for OpenAI/Anthropic in tests —
 * never depends on a real provider. */
export function startFakeUpstreamServer(
  options: FakeUpstreamOptions = {},
): Promise<FakeUpstreamServer> {
  const requests: CapturedUpstreamRequest[] = [];

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
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
