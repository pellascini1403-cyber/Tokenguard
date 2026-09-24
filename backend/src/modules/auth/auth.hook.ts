import type { FastifyReply, FastifyRequest } from "fastify";
import { unauthorizedError } from "../../lib/errors.js";
import type { SupabaseAppClient } from "./supabase-client.js";
import { verifyAccessToken } from "./verify-access-token.js";

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    throw unauthorizedError("Authentication required");
  }
  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    throw unauthorizedError("Authentication required");
  }
  return token;
}

/**
 * Fastify preHandler hook that verifies the caller's Supabase access token
 * and attaches the resulting user to `request.authUser`. Intended for
 * routes used by dashboard/API users, not by TokenGuard-API-key proxy
 * traffic (which will use a separate resolution path).
 */
export function createRequireAuthHook(authClient: SupabaseAppClient) {
  return async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    request.authUser = await verifyAccessToken(authClient, token);
  };
}
