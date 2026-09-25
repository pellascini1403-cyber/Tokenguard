import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { loadEnv, type EnvConfig, type NodeEnv, type ProxyEnvConfig } from "./config/env.js";
import { AppError } from "./lib/errors.js";
import { buildLoggerOptions } from "./lib/logger.js";
import { resolveRequestId } from "./lib/request-id.js";
import { createRequireAuthHook } from "./modules/auth/auth.hook.js";
import { createSupabaseClients, type SupabaseClients } from "./modules/auth/supabase-client.js";
import { createBudgetService } from "./modules/budget/budget.service.js";
import { createOrganizationsService } from "./modules/organizations/organizations.service.js";
import { createKeysService } from "./modules/keys/keys.service.js";
import { createRequireTokenGuardKeyHook } from "./modules/keys/tokenguard-key.hook.js";
import { createLoopDetector } from "./modules/loop-detection/loop-detector.js";
import type { LoopDetectionConfig } from "./modules/loop-detection/types.js";
import { createAnthropicAdapter } from "./modules/providers/anthropic.adapter.js";
import { createOpenAiAdapter } from "./modules/providers/openai.adapter.js";
import { createPricingService } from "./modules/pricing/pricing.service.js";
import type { ModelPricing } from "./modules/pricing/types.js";
import { createUsageRecorder } from "./modules/proxy/usage-recorder.js";
import { createUsageService } from "./modules/usage/usage.service.js";
import { registerHealthRoute } from "./routes/health.route.js";
import { registerV1Routes } from "./routes/v1/index.js";
import type { ErrorResponseBody } from "./types/api.js";

export interface BuildAppOptions {
  nodeEnv?: NodeEnv;
  logger?: FastifyServerOptions["logger"];
  /** Inject fake/test Supabase clients. Defaults to real clients built from env. */
  supabase?: SupabaseClients;
  /** Inject proxy config (e.g. fake upstream base URLs for tests). Defaults to env. */
  proxy?: ProxyEnvConfig;
  /** Inject a deterministic pricing table for tests. Defaults to TokenGuard's
   * maintained snapshot (src/modules/pricing/pricing-table.ts). */
  pricingTable?: ModelPricing[];
  /** Inject loop-detection thresholds (e.g. a tiny threshold/window for
   * fast, deterministic tests). Defaults to env. One detector instance
   * (and its in-memory state) is created per buildApp() call and shared
   * by both proxy routes — see modules/loop-detection. */
  loopDetection?: LoopDetectionConfig;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const nodeEnv = options.nodeEnv ?? "development";

  // loadEnv() is read at most once, and only if actually needed — most
  // unit tests inject both `supabase` and `proxy` directly and never touch
  // real environment configuration at all.
  let cachedEnv: EnvConfig | null = null;
  const getEnv = (): EnvConfig => (cachedEnv ??= loadEnv());

  const app = Fastify({
    logger: options.logger ?? buildLoggerOptions(nodeEnv),
    genReqId: (req) => {
      const header = req.headers["x-tokenguard-request-id"];
      return resolveRequestId(Array.isArray(header) ? header[0] : header);
    },
  });

  // Every response carries the TokenGuard request id for this request,
  // whether it came from the proxy or any other route — useful for support
  // and, later, for correlating a proxy request to its usage log.
  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header("X-TokenGuard-Request-Id", request.id);
    done(null, payload);
  });

  const supabase = options.supabase ?? createSupabaseClients(getEnv());
  const proxyEnv = options.proxy ?? getEnv().proxy;
  const loopDetectionConfig = options.loopDetection ?? getEnv().loopDetection;

  const requireAuth = createRequireAuthHook(supabase.authClient);
  const organizationsService = createOrganizationsService(supabase.adminClient);
  const keysService = createKeysService(supabase.adminClient);
  const requireTokenGuardKey = createRequireTokenGuardKeyHook(keysService);
  const usageService = createUsageService(supabase.adminClient);
  const pricingService = createPricingService(options.pricingTable);
  const budgetService = createBudgetService(supabase.adminClient);
  const usageRecorder = createUsageRecorder(usageService, pricingService, budgetService);
  const loopDetector = createLoopDetector(loopDetectionConfig);

  registerHealthRoute(app);
  registerV1Routes(app, {
    requireAuth,
    organizationsService,
    keysService,
    proxy: {
      requireTokenGuardKey,
      openaiAdapter: createOpenAiAdapter(proxyEnv.openaiBaseUrl),
      anthropicAdapter: createAnthropicAdapter(proxyEnv.anthropicBaseUrl),
      requestTimeoutMs: proxyEnv.requestTimeoutMs,
      streamMaxDurationMs: proxyEnv.streamMaxDurationMs,
      maxBodyBytes: proxyEnv.maxBodyBytes,
      usageRecorder,
      loopDetector,
      budgetService,
    },
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorResponseBody = {
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    };
    reply.status(404).send(body);
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const isServerError = statusCode >= 500;

    if (isServerError) {
      request.log.error({ err: error }, "Unhandled error");
    } else {
      request.log.warn({ err: error }, "Request error");
    }

    // AppError is only ever constructed by our own code with a static,
    // pre-vetted message (see lib/errors.ts) — safe to expose regardless
    // of status code, unlike an unexpected 5xx from a genuine bug. This
    // matters from Step 4 onward: upstream-timeout/unavailable errors are
    // deliberate 502/504 AppErrors whose specific code the caller needs,
    // not a generic "Internal server error".
    const isKnownError = error instanceof AppError;

    const body: ErrorResponseBody = {
      error: {
        code: isKnownError
          ? error.code
          : isServerError
            ? "INTERNAL_ERROR"
            : (error.code ?? "REQUEST_ERROR"),
        message: isKnownError
          ? error.message
          : isServerError
            ? "Internal server error"
            : error.message,
      },
    };
    reply.status(statusCode).send(body);
  });

  return app;
}
