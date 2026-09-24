import type { FastifyInstance } from "fastify";
import { rejectIfStreamingRequested } from "../../modules/providers/request-body.js";
import { runProviderRequest } from "../../modules/providers/provider-request-runner.js";
import type { V1RouteDependencies } from "./dependencies.js";

/**
 * OpenAI-compatible Chat Completions proxy. Transparent for non-streaming
 * requests: the client's body is forwarded unmodified, and the upstream
 * status/body/content-type are relayed back unmodified. No token
 * counting, pricing, or usage persistence happens here — see Step 3/5+.
 */
export function registerChatCompletionsRoute(
  app: FastifyInstance,
  deps: V1RouteDependencies,
): void {
  app.post(
    "/v1/chat/completions",
    {
      bodyLimit: deps.proxy.maxBodyBytes,
      preHandler: deps.proxy.requireTokenGuardKey,
    },
    async (request, reply) => {
      const rawBody = request.body as Buffer;
      rejectIfStreamingRequested(rawBody);

      const result = await runProviderRequest(
        deps.proxy.openaiAdapter,
        { body: rawBody, clientHeaders: request.headers },
        deps.proxy.requestTimeoutMs,
      );

      reply.status(result.status);
      if (result.contentType) {
        reply.header("content-type", result.contentType);
      }
      return reply.send(result.body);
    },
  );
}
