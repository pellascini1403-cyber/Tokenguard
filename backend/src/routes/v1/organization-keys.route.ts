import type { FastifyInstance } from "fastify";
import { badRequestError, unauthorizedError } from "../../lib/errors.js";
import { extractStringField } from "../../lib/validation.js";
import { isUuid } from "../../lib/uuid.js";
import type { V1RouteDependencies } from "./dependencies.js";

interface OrganizationParams {
  organizationId: string;
}

interface OrganizationKeyParams extends OrganizationParams {
  keyId: string;
}

function requireUuidParam(value: string, label: string): void {
  if (!isUuid(value)) {
    throw badRequestError(`"${label}" must be a valid UUID`);
  }
}

export function registerOrganizationKeysRoutes(
  app: FastifyInstance,
  deps: V1RouteDependencies,
): void {
  app.post<{ Params: OrganizationParams }>(
    "/v1/organizations/:organizationId/keys",
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      if (!request.authUser) {
        throw unauthorizedError();
      }
      const { organizationId } = request.params;
      requireUuidParam(organizationId, "organizationId");

      await deps.organizationsService.requireRole(organizationId, request.authUser.id, ["owner"]);

      const name = extractStringField(request.body, "name");
      const created = await deps.keysService.createKey(organizationId, name);

      reply.status(201);
      return {
        key: {
          id: created.id,
          organizationId: created.organizationId,
          name: created.name,
          prefix: created.keyPrefix,
          apiKey: created.apiKey,
          createdAt: created.createdAt,
        },
      };
    },
  );

  app.post<{ Params: OrganizationKeyParams }>(
    "/v1/organizations/:organizationId/keys/:keyId/revoke",
    { preHandler: deps.requireAuth },
    async (request) => {
      if (!request.authUser) {
        throw unauthorizedError();
      }
      const { organizationId, keyId } = request.params;
      requireUuidParam(organizationId, "organizationId");
      requireUuidParam(keyId, "keyId");

      await deps.organizationsService.requireRole(organizationId, request.authUser.id, ["owner"]);
      await deps.keysService.revokeKey(organizationId, keyId);

      return { revoked: true };
    },
  );
}
