import type { FastifyInstance } from "fastify";
import { registerMeRoute } from "./me.route.js";
import { registerOrganizationsRoutes } from "./organizations.route.js";
import { registerOrganizationKeysRoutes } from "./organization-keys.route.js";
import { registerProxyRoutes } from "./proxy.plugin.js";
import type { V1RouteDependencies } from "./dependencies.js";

export type { V1RouteDependencies } from "./dependencies.js";

/**
 * Registers the authentication/organization API (Step 2) and the AI
 * provider proxy (Step 4: POST /v1/chat/completions, POST /v1/messages;
 * non-streaming only — streaming is rejected until Step 6).
 */
export function registerV1Routes(app: FastifyInstance, deps: V1RouteDependencies): void {
  registerMeRoute(app, deps);
  registerOrganizationsRoutes(app, deps);
  registerOrganizationKeysRoutes(app, deps);
  registerProxyRoutes(app, deps);
}
