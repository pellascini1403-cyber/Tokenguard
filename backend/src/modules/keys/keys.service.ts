import { badRequestError, notFoundError } from "../../lib/errors.js";
import type { SupabaseAppClient } from "../auth/supabase-client.js";
import { extractKeyPrefix, generateTokenGuardKey, verifyKeyHash } from "./key-generator.js";
import { createKeysRepository, KeyPrefixCollisionError } from "./keys.repository.js";
import type { CreatedTokenGuardKey, VerifiedKeyContext } from "./types.js";

const MAX_NAME_LENGTH = 100;
const MAX_GENERATION_ATTEMPTS = 3;

export interface KeysService {
  createKey(organizationId: string, name: string): Promise<CreatedTokenGuardKey>;
  /**
   * Resolves a plaintext TokenGuard API key to its organization, verifying
   * the cryptographic hash and revocation status. This is the reusable
   * credential-resolution path the AI proxy will call on every request in
   * a later step — no route in this step exposes it directly.
   */
  verifyKey(plaintext: string): Promise<VerifiedKeyContext | null>;
  revokeKey(organizationId: string, keyId: string): Promise<void>;
}

export function createKeysService(adminClient: SupabaseAppClient): KeysService {
  const repository = createKeysRepository(adminClient);

  return {
    async createKey(organizationId: string, name: string): Promise<CreatedTokenGuardKey> {
      const trimmedName = name.trim();
      if (trimmedName.length === 0 || trimmedName.length > MAX_NAME_LENGTH) {
        throw badRequestError(`Key name must be between 1 and ${MAX_NAME_LENGTH} characters`);
      }

      for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
        const generated = generateTokenGuardKey();
        try {
          const summary = await repository.insert(
            organizationId,
            trimmedName,
            generated.keyPrefix,
            generated.keyHash,
          );
          return { ...summary, apiKey: generated.plaintext };
        } catch (error) {
          const isLastAttempt = attempt === MAX_GENERATION_ATTEMPTS - 1;
          if (!(error instanceof KeyPrefixCollisionError) || isLastAttempt) {
            throw error;
          }
        }
      }
      // Unreachable: the loop above always returns or throws.
      throw new Error("Failed to generate a unique TokenGuard key");
    },

    async verifyKey(plaintext: string): Promise<VerifiedKeyContext | null> {
      const prefix = extractKeyPrefix(plaintext);
      if (!prefix) {
        return null;
      }

      const candidates = await repository.findActiveByPrefix(prefix);
      for (const candidate of candidates) {
        if (verifyKeyHash(plaintext, candidate.keyHash)) {
          return {
            keyId: candidate.id,
            organizationId: candidate.organizationId,
            name: candidate.name,
          };
        }
      }
      return null;
    },

    async revokeKey(organizationId: string, keyId: string): Promise<void> {
      const revoked = await repository.revoke(organizationId, keyId);
      if (!revoked) {
        throw notFoundError("TokenGuard key not found");
      }
    },
  };
}
