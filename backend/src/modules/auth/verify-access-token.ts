import { unauthorizedError } from "../../lib/errors.js";
import type { SupabaseAppClient } from "./supabase-client.js";
import type { AuthenticatedUser } from "./types.js";

/**
 * Validates a Supabase access token (the dashboard/API user's Bearer
 * token) and resolves the authenticated user. This is distinct from
 * TokenGuard API key verification, which authenticates proxy traffic.
 */
export async function verifyAccessToken(
  authClient: SupabaseAppClient,
  accessToken: string,
): Promise<AuthenticatedUser> {
  const { data, error } = await authClient.auth.getUser(accessToken);

  if (error || !data.user) {
    throw unauthorizedError("Invalid or expired access token");
  }

  return { id: data.user.id, email: data.user.email ?? null };
}
