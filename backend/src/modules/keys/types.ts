export interface TokenGuardKeySummary {
  id: string;
  organizationId: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedTokenGuardKey extends TokenGuardKeySummary {
  /** The plaintext secret. Present only in the creation response, never persisted. */
  apiKey: string;
}

/** The safe, non-secret context resolved from a verified TokenGuard API key. */
export interface VerifiedKeyContext {
  keyId: string;
  organizationId: string;
  name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set once the X-TokenGuard-Key header has been verified. Distinct
     * from `authUser` (a Supabase dashboard user): this identifies the
     * organization/credential behind proxy traffic, not a human.
     */
    tokenGuardContext?: VerifiedKeyContext;
  }
}
