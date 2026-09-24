import { describe, expect, it } from "vitest";
import {
  extractKeyPrefix,
  generateTokenGuardKey,
  hashTokenGuardKey,
  TOKENGUARD_KEY_PREFIX,
  verifyKeyHash,
} from "../../src/modules/keys/key-generator.js";

describe("generateTokenGuardKey", () => {
  it("produces a key in the tg_usr_live_ format", () => {
    const { plaintext } = generateTokenGuardKey();
    expect(plaintext.startsWith(TOKENGUARD_KEY_PREFIX)).toBe(true);
  });

  it("has sufficient randomness in the secret portion", () => {
    const secret = generateTokenGuardKey().plaintext.slice(TOKENGUARD_KEY_PREFIX.length);
    // 32 random bytes base64url-encoded is at least 40 characters.
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates unique keys across calls", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateTokenGuardKey().plaintext));
    expect(keys.size).toBe(100);
  });

  it("returns a hash that does not equal the plaintext key", () => {
    const { plaintext, keyHash } = generateTokenGuardKey();
    expect(keyHash).not.toBe(plaintext);
    expect(keyHash).not.toContain(plaintext);
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
  });

  it("derives keyPrefix as a leading slice of the secret", () => {
    const { plaintext, keyPrefix } = generateTokenGuardKey();
    const secret = plaintext.slice(TOKENGUARD_KEY_PREFIX.length);
    expect(secret.startsWith(keyPrefix)).toBe(true);
  });
});

describe("verifyKeyHash", () => {
  it("verifies a matching plaintext/hash pair", () => {
    const { plaintext, keyHash } = generateTokenGuardKey();
    expect(verifyKeyHash(plaintext, keyHash)).toBe(true);
  });

  it("rejects a wrong plaintext key against a valid hash", () => {
    const { keyHash } = generateTokenGuardKey();
    const other = generateTokenGuardKey().plaintext;
    expect(verifyKeyHash(other, keyHash)).toBe(false);
  });

  it("rejects a tampered plaintext key", () => {
    const { plaintext, keyHash } = generateTokenGuardKey();
    const tampered = plaintext.slice(0, -1) + (plaintext.endsWith("A") ? "B" : "A");
    expect(verifyKeyHash(tampered, keyHash)).toBe(false);
  });
});

describe("extractKeyPrefix", () => {
  it("extracts the prefix from a well-formed key", () => {
    const { plaintext, keyPrefix } = generateTokenGuardKey();
    expect(extractKeyPrefix(plaintext)).toBe(keyPrefix);
  });

  it("returns null for a key with the wrong scheme", () => {
    expect(extractKeyPrefix("sk_live_notATokenGuardKey")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractKeyPrefix("")).toBeNull();
  });
});

describe("hashTokenGuardKey", () => {
  it("is deterministic for the same input", () => {
    const plaintext = generateTokenGuardKey().plaintext;
    expect(hashTokenGuardKey(plaintext)).toBe(hashTokenGuardKey(plaintext));
  });
});
