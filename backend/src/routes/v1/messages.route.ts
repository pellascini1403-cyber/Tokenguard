import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { unauthorizedError } from "../../lib/errors.js";
import { parseAnthropicResponse } from "../../modules/providers/anthropic-usage.js";
import { inspectProxyRequestBody } from "../../modules/providers/request-body.js";
import { runProviderRequest } from "../../modules/providers/provider-request-runner.js";
import { recordProxyUsageSafely } from "../../modules/proxy/usage-recorder.js";
import type { ProxyRequestContext } from "../../modules/proxy/types.js";
import type { V1RouteDependencies } from "./dependencies.js";

/**
 * Anthropic-compatible Messages proxy. Transparent for non-streaming
 * requests: the client's body is forwarded unmodified, and the upstream
 * status/body/content-type are relayed back unmodified. Usage/cost
 * tracking (Step 5) happens after the upstream response is in hand and
 * never delays or risks the client's response — a pricing or persistence
 * failure is logged, never surfaced to the caller.
 */
export function registerMessagesRoute(app: FastifyInstance, deps: V1RouteDependencies): void {
  app.post(
    "/v1/messages",
    {
      bodyLimit: deps.proxy.maxBodyBytes,
      preHandler: deps.proxy.requireTokenGuardKey,
    },
    async (request, reply) => {
      const startedAt = performance.now();
      const rawBody = request.body as Buffer;
      const { requestedModel } = inspectProxyRequestBody(rawBody);

      const tokenGuardContext = request.tokenGuardContext;
      if (!tokenGuardContext) {
        // Unreachable in practice: the preHandler above always sets this
        // before the handler runs. Defensive only, mirrors me.route.ts.
        throw unauthorizedError();
      }

      const result = await runProviderRequest(
        deps.proxy.anthropicAdapter,
        { body: rawBody, clientHeaders: request.headers },
        deps.proxy.requestTimeoutMs,
      );
      const durationMs = Math.round(performance.now() - startedAt);

      const context: ProxyRequestContext = {
        requestId: request.id,
        organizationId: tokenGuardContext.organizationId,
        tokenGuardKeyId: tokenGuardContext.keyId,
        provider: "anthropic",
        requestedModel,
        startedAt,
      };
      await recordProxyUsageSafely(
        deps.proxy.usageRecorder,
        {
          context,
          statusCode: result.status,
          durationMs,
          parsedResponse: parseAnthropicResponse(result.body, requestedModel),
        },
        request.log,
      );

      reply.status(result.status);
      if (result.contentType) {
        reply.header("content-type", result.contentType);
      }
      return reply.send(result.body);
    },
  );
}
