import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { loadEnv, type NodeEnv } from "./config/env.js";
import { buildLoggerOptions } from "./lib/logger.js";
import { createRequireAuthHook } from "./modules/auth/auth.hook.js";
import { createSupabaseClients, type SupabaseClients } from "./modules/auth/supabase-client.js";
import { createOrganizationsService } from "./modules/organizations/organizations.service.js";
import { createKeysService } from "./modules/keys/keys.service.js";
import { registerHealthRoute } from "./routes/health.route.js";
import { registerV1Routes } from "./routes/v1/index.js";
import type { ErrorResponseBody } from "./types/api.js";

export interface BuildAppOptions {
  nodeEnv?: NodeEnv;
  logger?: FastifyServerOptions["logger"];
  /** Inject fake/test Supabase clients. Defaults to real clients built from env. */
  supabase?: SupabaseClients;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? buildLoggerOptions(options.nodeEnv ?? "development"),
  });

  const supabase = options.supabase ?? createSupabaseClients(loadEnv());
  const requireAuth = createRequireAuthHook(supabase.authClient);
  const organizationsService = createOrganizationsService(supabase.adminClient);
  const keysService = createKeysService(supabase.adminClient);

  registerHealthRoute(app);
  registerV1Routes(app, { requireAuth, organizationsService, keysService });

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

    const body: ErrorResponseBody = {
      error: {
        code: isServerError ? "INTERNAL_ERROR" : (error.code ?? "REQUEST_ERROR"),
        // Never leak internal error details (stack traces, file paths, etc.) to clients.
        message: isServerError ? "Internal server error" : error.message,
      },
    };
    reply.status(statusCode).send(body);
  });

  return app;
}
