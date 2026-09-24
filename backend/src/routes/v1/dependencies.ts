import type { FastifyReply, FastifyRequest } from "fastify";
import type { OrganizationsService } from "../../modules/organizations/organizations.service.js";
import type { KeysService } from "../../modules/keys/keys.service.js";

export interface V1RouteDependencies {
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  organizationsService: OrganizationsService;
  keysService: KeysService;
}
