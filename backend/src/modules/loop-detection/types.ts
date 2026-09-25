/** Tunables for the in-memory loop detector. See configuration.ts for
 * environment-variable parsing and documented defaults. */
export interface LoopDetectionConfig {
  /** Fixed window, in milliseconds, over which identical requests are
   * counted. */
  windowMs: number;
  /** Maximum number of identical requests allowed within `windowMs`
   * before the next one is treated as a loop and blocked. */
  threshold: number;
  /** How long a detected signature stays blocked once the threshold is
   * exceeded, in milliseconds. */
  blockDurationMs: number;
  /** Maximum number of distinct signatures tracked at once. Bounds
   * memory use — never grows without limit. */
  maxEntries: number;
}

export interface LoopCheckResult {
  blocked: boolean;
  /** Only set when `blocked` is true: milliseconds remaining until this
   * exact signature's block expires. */
  retryAfterMs?: number;
}

/**
 * Everything needed to derive a privacy-safe request signature. Never
 * retained after the signature is computed — see request-signature.ts.
 */
export interface RequestSignatureInput {
  organizationId: string;
  tokenGuardKeyId: string;
  provider: string;
  endpoint: string;
  model: string | null;
  /** The already-parsed JSON request body. Hashed immediately by
   * computeRequestSignature and never stored, logged, or returned. */
  parsedBody: unknown;
}
