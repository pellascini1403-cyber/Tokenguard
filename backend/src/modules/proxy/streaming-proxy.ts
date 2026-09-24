import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { bufferReadableStream } from "../streaming/buffer-readable-stream.js";
import { isEventStreamContentType } from "../streaming/content-type.js";
import { pumpSseStream } from "../streaming/stream-pump.js";
import type { ProviderAdapter } from "../providers/types.js";
import { startProviderStream } from "../providers/provider-stream-runner.js";
import type { ParsedProviderResponse, StreamUsageAccumulator } from "../providers/usage-types.js";
import { recordProxyUsageSafely } from "./usage-recorder.js";
import type { UsageRecorder } from "./usage-recorder.js";
import type { ProxyRequestContext } from "./types.js";

export interface StreamingProxyParams {
  request: FastifyRequest;
  reply: FastifyReply;
  adapter: ProviderAdapter;
  rawBody: Buffer;
  requestedModel: string | null;
  connectTimeoutMs: number;
  streamMaxDurationMs: number;
  usageRecorder: UsageRecorder;
  context: ProxyRequestContext;
  /** The same non-streaming parser already used by the buffered proxy
   * path (Step 5) — reused here for the "provider rejected before
   * streaming began" fallback, never duplicated. */
  parseBufferedResponse: (body: Buffer, requestedModel: string | null) => ParsedProviderResponse;
  createStreamAccumulator: (requestedModel: string | null) => StreamUsageAccumulator;
}

/**
 * Handles a `stream: true` proxy request end to end: connects upstream,
 * decides whether the provider actually started an SSE stream or
 * responded with an ordinary error, and either relays that error like
 * the Step 4/5 buffered proxy would, or pumps the real stream to the
 * client live while extracting usage — then records usage exactly once,
 * regardless of which path was taken or how the stream ended.
 */
export async function handleStreamingProxyRequest(params: StreamingProxyParams): Promise<void> {
  const { request, reply } = params;
  const durationSoFar = (): number => Math.round(performance.now() - params.context.startedAt);

  // Wired for the whole request lifecycle (connect phase and streaming
  // phase alike): if the client goes away, the upstream request is
  // aborted rather than left generating for nobody.
  //
  // Deliberately listens on `reply.raw` (the ServerResponse), not
  // `request.raw` (the IncomingMessage): the request stream naturally
  // ends — and auto-destroys, emitting its own 'close' — as soon as its
  // body has been fully read, which for a JSON POST happens during body
  // parsing, well before this handler even runs. That 'close' has
  // nothing to do with the client disconnecting. The response object's
  // 'close', by contrast, fires when the underlying connection is torn
  // down before the response could finish — the actual signal we want.
  const clientAbortController = new AbortController();
  const onClientClose = (): void => {
    if (!reply.raw.writableEnded) {
      clientAbortController.abort();
    }
  };
  reply.raw.on("close", onClientClose);

  try {
    const session = await startProviderStream(
      params.adapter,
      { body: params.rawBody, clientHeaders: request.headers },
      params.connectTimeoutMs,
      clientAbortController.signal,
    );

    if (!session.result.body || !isEventStreamContentType(session.result.contentType)) {
      // The provider rejected the request (bad credentials, rate limit,
      // malformed body, ...) before ever starting to stream — behave
      // exactly like the Step 4/5 non-streaming proxy: buffer the
      // (typically small) response and relay it as-is.
      const buffered = await bufferReadableStream(session.result.body);
      reply.status(session.result.status);
      if (session.result.contentType) {
        reply.header("content-type", session.result.contentType);
      }
      await recordProxyUsageSafely(
        params.usageRecorder,
        {
          context: params.context,
          statusCode: session.result.status,
          durationMs: durationSoFar(),
          parsedResponse: params.parseBufferedResponse(buffered, params.requestedModel),
        },
        request.log,
      );
      reply.send(buffered);
      return;
    }

    const disposeStreamGuard = session.startStreamGuard(params.streamMaxDurationMs);
    const accumulator = params.createStreamAccumulator(params.requestedModel);
    const passThrough = new PassThrough();

    reply.status(session.result.status);
    reply.header("content-type", "text/event-stream");
    // SSE responses must never be cached — a proxy or browser cache
    // would otherwise replay a stale generation.
    reply.header("cache-control", "no-cache");
    reply.send(passThrough);

    try {
      await pumpSseStream({
        upstreamBody: session.result.body,
        passThrough,
        onEvent: (event) => accumulator.handleEvent(event),
      });
    } finally {
      disposeStreamGuard();
      await recordProxyUsageSafely(
        params.usageRecorder,
        {
          context: params.context,
          statusCode: session.result.status,
          durationMs: durationSoFar(),
          parsedResponse: accumulator.finalize(),
        },
        request.log,
      );
    }
  } finally {
    reply.raw.off("close", onClientClose);
  }
}
