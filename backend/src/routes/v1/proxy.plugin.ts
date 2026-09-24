import type { FastifyInstance } from "fastify";
import { registerChatCompletionsRoute } from "./chat-completions.route.js";
import { registerMessagesRoute } from "./messages.route.js";
import type { V1RouteDependencies } from "./dependencies.js";

/**
 * Registers the AI provider proxy routes inside their own encapsulated
 * Fastify context. The raw-buffer content type parser below is scoped to
 * this context only (Fastify's plugin encapsulation), so proxy requests
 * are forwarded byte-for-byte — never parsed and re-serialized — while
 * every other route (e.g. /v1/organizations) keeps Fastify's normal JSON
 * body parsing.
 */
export function registerProxyRoutes(app: FastifyInstance, deps: V1RouteDependencies): void {
  void app.register((instance, _opts, registerDone) => {
    const captureRawBody: Parameters<typeof instance.addContentTypeParser>[2] = (
      _request,
      body,
      parseDone,
    ) => {
      parseDone(null, body);
    };

    // A specific content-type match (like Fastify's own default JSON
    // parser, registered at the root) always wins over a '*' wildcard
    // even within this child scope, so 'application/json' must be
    // overridden explicitly here — '*' alone would never fire for it.
    instance.addContentTypeParser("application/json", { parseAs: "buffer" }, captureRawBody);
    instance.addContentTypeParser("*", { parseAs: "buffer" }, captureRawBody);

    registerChatCompletionsRoute(instance, deps);
    registerMessagesRoute(instance, deps);
    registerDone();
  });
}
