import type { FastifyInstance } from "fastify";
import { packageVersion } from "../lib/package-info.js";
import type { HealthResponseBody } from "../types/api.js";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", (): HealthResponseBody => {
    return {
      status: "ok",
      service: "tokenguard-proxy",
      version: packageVersion,
    };
  });
}
