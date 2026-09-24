import type { FastifyInstance } from "fastify";
import { unauthorizedError } from "../../lib/errors.js";
import type { V1RouteDependencies } from "./dependencies.js";

export function registerMeRoute(app: FastifyInstance, deps: V1RouteDependencies): void {
  app.get("/v1/me", { preHandler: deps.requireAuth }, (request) => {
    const user = request.authUser;
    if (!user) {
      throw unauthorizedError();
    }
    return { id: user.id, email: user.email };
  });
}
