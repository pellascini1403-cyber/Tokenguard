import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TokenGuard API keys authenticate customer application/proxy traffic and
 * are distinct from Supabase access tokens, which authenticate dashboard
 * users. Format: tg_usr_live_<43-char base64url secret>.
 */
export const TOKENGUARD_KEY_PREFIX = "tg_usr_live_";

// 256 bits of randomness from Node's CSPRNG — comparable to a raw API
// token from GitHub or Stripe, and not brute-forceable.
const SECRET_BYTE_LENGTH = 32;

// Non-secret leading slice of the secret, stored in the database so a
// credential can be looked up by an indexed column before doing any
// cryptographic comparison. Knowing this alone does not grant access.
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedKey {
  /** The full secret, returned to the caller exactly once and never stored. */
  plaintext: string;
  /** Non-secret, indexed lookup identifier stored in the database. */
  keyPrefix: string;
  /** One-way SHA-256 hash of the full plaintext key, stored in the database. */
  keyHash: string;
}

export function hashTokenGuardKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function generateTokenGuardKey(): GeneratedKey {
  const secret = randomBytes(SECRET_BYTE_LENGTH).toString("base64url");
  const plaintext = `${TOKENGUARD_KEY_PREFIX}${secret}`;
  return {
    plaintext,
    keyPrefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
    keyHash: hashTokenGuardKey(plaintext),
  };
}

/**
 * Extracts the lookup prefix from a plaintext key presented by a caller,
 * without touching the database. Returns null for anything that isn't
 * shaped like a TokenGuard key.
 */
export function extractKeyPrefix(plaintext: string): string | null {
  if (!plaintext.startsWith(TOKENGUARD_KEY_PREFIX)) {
    return null;
  }
  const secret = plaintext.slice(TOKENGUARD_KEY_PREFIX.length);
  if (secret.length < DISPLAY_PREFIX_LENGTH) {
    return null;
  }
  return secret.slice(0, DISPLAY_PREFIX_LENGTH);
}

/** Constant-time comparison against a stored hash to avoid timing side channels. */
export function verifyKeyHash(plaintext: string, storedHashHex: string): boolean {
  const computed = Buffer.from(hashTokenGuardKey(plaintext), "hex");
  const stored = Buffer.from(storedHashHex, "hex");
  if (computed.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(computed, stored);
}
