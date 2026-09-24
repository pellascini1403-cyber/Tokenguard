import type { SupabaseAppClient } from "../auth/supabase-client.js";
import type { TokenGuardKeySummary } from "./types.js";

const UNIQUE_VIOLATION = "23505";

export class KeyPrefixCollisionError extends Error {
  constructor() {
    super("Generated key prefix collided with an existing key");
    this.name = "KeyPrefixCollisionError";
  }
}

interface TokenGuardKeyRow {
  id: string;
  organization_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: string;
  revoked_at: string | null;
}

/** Row shape used only inside verification, where the hash must be compared. */
export interface TokenGuardKeyWithHash extends TokenGuardKeySummary {
  keyHash: string;
}

function mapSummary(row: TokenGuardKeyRow): TokenGuardKeySummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function mapWithHash(row: TokenGuardKeyRow): TokenGuardKeyWithHash {
  return { ...mapSummary(row), keyHash: row.key_hash };
}

export interface KeysRepository {
  insert(
    organizationId: string,
    name: string,
    keyPrefix: string,
    keyHash: string,
  ): Promise<TokenGuardKeySummary>;
  findActiveByPrefix(keyPrefix: string): Promise<TokenGuardKeyWithHash[]>;
  revoke(organizationId: string, keyId: string): Promise<TokenGuardKeySummary | null>;
}

export function createKeysRepository(adminClient: SupabaseAppClient): KeysRepository {
  return {
    async insert(
      organizationId: string,
      name: string,
      keyPrefix: string,
      keyHash: string,
    ): Promise<TokenGuardKeySummary> {
      // insert()/select() on the untyped Supabase client resolves to
      // `any`; the returned row is cast to TokenGuardKeyRow below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await adminClient
        .from("token_guard_keys")
        .insert({
          organization_id: organizationId,
          name,
          key_prefix: keyPrefix,
          key_hash: keyHash,
        })
        .select()
        .single();

      if (error) {
        if (error.code === UNIQUE_VIOLATION) {
          throw new KeyPrefixCollisionError();
        }
        throw new Error(`Failed to create TokenGuard key: ${error.message}`);
      }

      return mapSummary(data as TokenGuardKeyRow);
    },

    async findActiveByPrefix(keyPrefix: string): Promise<TokenGuardKeyWithHash[]> {
      const { data, error } = await adminClient
        .from("token_guard_keys")
        .select("*")
        .eq("key_prefix", keyPrefix)
        .is("revoked_at", null);

      if (error) {
        throw new Error(`Failed to look up TokenGuard key: ${error.message}`);
      }

      return ((data ?? []) as TokenGuardKeyRow[]).map(mapWithHash);
    },

    async revoke(organizationId: string, keyId: string): Promise<TokenGuardKeySummary | null> {
      // update()/select() on the untyped Supabase client resolves to
      // `any`; the returned row is cast to TokenGuardKeyRow below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await adminClient
        .from("token_guard_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", keyId)
        .eq("organization_id", organizationId)
        .is("revoked_at", null)
        .select()
        .maybeSingle();

      if (error) {
        throw new Error(`Failed to revoke TokenGuard key: ${error.message}`);
      }

      return data ? mapSummary(data as TokenGuardKeyRow) : null;
    },
  };
}
