import type { FastifyReply, FastifyRequest } from "fastify";
import type { BudgetService } from "../../modules/budget/budget.service.js";
import type { OrganizationsService } from "../../modules/organizations/organizations.service.js";
import type { KeysService } from "../../modules/keys/keys.service.js";
import type { LoopDetector } from "../../modules/loop-detection/loop-detector.js";
import type { ProviderAdapter } from "../../modules/providers/types.js";
import type { UsageRecorder } from "../../modules/proxy/usage-recorder.js";

export interface ProxyDependencies {
  requireTokenGuardKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  openaiAdapter: ProviderAdapter;
  anthropicAdapter: ProviderAdapter;
  requestTimeoutMs: number;
  streamMaxDurationMs: number;
  maxBodyBytes: number;
  usageRecorder: UsageRecorder;
  loopDetector: LoopDetector;
  budgetService: BudgetService;
}

export interface V1RouteDependencies {
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  organizationsService: OrganizationsService;
  keysService: KeysService;
  proxy: ProxyDependencies;
}
