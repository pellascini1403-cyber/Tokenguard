import type { FastifyReply, FastifyRequest } from "fastify";
import type { OrganizationsService } from "../../modules/organizations/organizations.service.js";
import type { KeysService } from "../../modules/keys/keys.service.js";
import type { ProviderAdapter } from "../../modules/providers/types.js";

export interface ProxyDependencies {
  requireTokenGuardKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  openaiAdapter: ProviderAdapter;
  anthropicAdapter: ProviderAdapter;
  requestTimeoutMs: number;
  maxBodyBytes: number;
}

export interface V1RouteDependencies {
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  organizationsService: OrganizationsService;
  keysService: KeysService;
  proxy: ProxyDependencies;
}
