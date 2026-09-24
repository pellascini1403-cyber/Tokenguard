import type { FastifyInstance } from "fastify";

/**
 * Registration point for the future /v1 AI proxy API (e.g. /v1/chat/completions).
 * Intentionally empty in Step 1 — no proxy behavior exists yet, and this must
 * not expose any endpoint until it is implemented in a later step.
 */
export function registerV1Routes(_app: FastifyInstance): void {
  // No /v1 routes are implemented yet.
}
