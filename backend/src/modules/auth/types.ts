/**
 * An authenticated Supabase dashboard/API user, identified from a Supabase
 * access token. Distinct from a TokenGuard API key, which authenticates
 * customer proxy traffic rather than a human user.
 */
export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
  }
}
