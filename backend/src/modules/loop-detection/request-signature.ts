import { createHash } from "node:crypto";
import type { RequestSignatureInput } from "./types.js";

/**
 * Returns a deep, structurally-equal copy of `value` with every object's
 * keys sorted recursively — arrays keep their original element order
 * (order is meaningful; key order in an object is not). Applied only to
 * a throwaway copy used for hashing; never mutates `value` itself, so
 * the caller's original parsed body is completely unaffected.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sortedKeys = Object.keys(source).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize(source[key]);
    }
    return result;
  }
  return value;
}

/**
 * Derives a privacy-safe SHA-256 signature identifying "this exact
 * effective request, from this exact org+key+provider+endpoint". The
 * normalized body is built and hashed in one step here and never
 * returned, stored, or logged on its own — only the resulting hex digest
 * leaves this function. Two requests with the same meaning but
 * differently-ordered JSON keys produce the same signature; two requests
 * with different meaningful content, organizations, keys, providers,
 * endpoints, or models never do.
 */
export function computeRequestSignature(input: RequestSignatureInput): string {
  const canonicalPayload = JSON.stringify({
    organizationId: input.organizationId,
    tokenGuardKeyId: input.tokenGuardKeyId,
    provider: input.provider,
    endpoint: input.endpoint,
    model: input.model,
    body: canonicalize(input.parsedBody),
  });
  return createHash("sha256").update(canonicalPayload).digest("hex");
}
