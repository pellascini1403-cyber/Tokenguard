import type { FastifyInstance } from "fastify";
import { registerMeRoute } from "./me.route.js";
import { registerOrganizationsRoutes } from "./organizations.route.js";
import { registerOrganizationKeysRoutes } from "./organization-keys.route.js";
import type { V1RouteDependencies } from "./dependencies.js";

export type { V1RouteDependencies } from "./dependencies.js";

/**
 * Registers the Step 2 authentication/organization API. The future AI
 * proxy (e.g. /v1/chat/completions) is NOT implemented here yet.
 */
export function registerV1Routes(app: FastifyInstance, deps: V1RouteDependencies): void {
  registerMeRoute(app, deps);
  registerOrganizationsRoutes(app, deps);
  registerOrganizationKeysRoutes(app, deps);
}
