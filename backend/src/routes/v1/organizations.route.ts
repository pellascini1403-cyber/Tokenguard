import type { FastifyInstance } from "fastify";
import { unauthorizedError } from "../../lib/errors.js";
import { extractStringField } from "../../lib/validation.js";
import type { Organization } from "../../modules/organizations/types.js";
import type { V1RouteDependencies } from "./dependencies.js";

function serializeOrganization(org: Organization) {
  return {
    id: org.id,
    name: org.name,
    monthlyBudgetUsd: org.monthlyBudgetUsd,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

export function registerOrganizationsRoutes(app: FastifyInstance, deps: V1RouteDependencies): void {
  app.post("/v1/organizations", { preHandler: deps.requireAuth }, async (request, reply) => {
    if (!request.authUser) {
      throw unauthorizedError();
    }
    const name = extractStringField(request.body, "name");
    const organization = await deps.organizationsService.createOrganization(
      request.authUser.id,
      name,
    );
    reply.status(201);
    return { organization: serializeOrganization(organization) };
  });

  app.get("/v1/organizations", { preHandler: deps.requireAuth }, async (request) => {
    if (!request.authUser) {
      throw unauthorizedError();
    }
    const organizations = await deps.organizationsService.listOrganizationsForUser(
      request.authUser.id,
    );
    return { organizations: organizations.map(serializeOrganization) };
  });
}
