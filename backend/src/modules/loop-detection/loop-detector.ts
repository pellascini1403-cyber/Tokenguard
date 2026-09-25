import type { LoopCheckResult, LoopDetectionConfig } from "./types.js";

interface SignatureEntry {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  blockedUntil: number | null;
}

export interface LoopDetector {
  /**
   * Checks a request signature against the current window/threshold and
   * atomically records this occurrence — a single synchronous call, so
   * there is no gap between "check" and "update" for concurrent callers
   * to race through (see the class doc comment below for why this
   * matters and what it doesn't cover).
   */
  check(signature: string, now?: number): LoopCheckResult;
  /** Number of distinct signatures currently tracked. Exposed for tests
   * (memory-bound and cleanup assertions) — not used on the request path. */
  size(): number;
}

/**
 * Bounded, in-memory, process-local loop detector. Tracks only minimal
 * per-signature metadata (count/firstSeenAt/lastSeenAt/blockedUntil) —
 * never the request body or anything derived from it beyond the
 * signature hash the caller already computed.
 *
 * Concurrency: `check()` is a single synchronous function with no
 * `await` inside it. Node.js runs synchronous code to completion before
 * yielding to any other callback, so however many "concurrent" requests
 * call `check()` for the same signature, each call's read-then-increment
 * happens atomically with respect to every other call — there is no
 * window in which two callers can both observe the pre-increment count.
 * This requires the caller to actually await nothing between fetching
 * the signature and calling `check()` — the proxy routes do this.
 *
 * This is process-local state: it protects one running instance of this
 * server. Running multiple instances behind a load balancer means each
 * instance tracks its own counts independently, so a loop whose requests
 * are spread across instances could exceed the configured threshold
 * before any single instance blocks it. Deliberately out of scope for
 * this step — see README's "Agent loop detection" section.
 */
export function createLoopDetector(config: LoopDetectionConfig): LoopDetector {
  const entries = new Map<string, SignatureEntry>();
  let lastSweepAt = 0;

  function isStale(entry: SignatureEntry, now: number): boolean {
    const blockActive = entry.blockedUntil !== null && now < entry.blockedUntil;
    const windowActive = now - entry.lastSeenAt < config.windowMs;
    return !blockActive && !windowActive;
  }

  function sweepExpired(now: number): void {
    for (const [signature, entry] of entries) {
      if (isStale(entry, now)) {
        entries.delete(signature);
      }
    }
  }

  /** Sweeps at most once per window — cheap enough to run on the hot
   * path without scanning the whole map on every single request. */
  function maybeSweep(now: number): void {
    if (now - lastSweepAt < config.windowMs) {
      return;
    }
    lastSweepAt = now;
    sweepExpired(now);
  }

  function evictIfAtCapacity(now: number): void {
    if (entries.size < config.maxEntries) {
      return;
    }
    // Reclaim genuinely stale entries first rather than evicting a
    // still-active signature purely because the map happens to be full.
    sweepExpired(now);
    // Map iteration order is insertion order and untouched by in-place
    // updates to an existing key, so this evicts the oldest-inserted
    // (still-active) signatures first — simple, predictable FIFO.
    while (entries.size >= config.maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      entries.delete(oldestKey);
    }
  }

  return {
    check(signature: string, now: number = Date.now()): LoopCheckResult {
      maybeSweep(now);

      let entry = entries.get(signature);

      if (entry && entry.blockedUntil !== null) {
        if (now < entry.blockedUntil) {
          return { blocked: true, retryAfterMs: entry.blockedUntil - now };
        }
        // Block expired: resume normal evaluation from a clean slate.
        entry.count = 0;
        entry.firstSeenAt = now;
        entry.lastSeenAt = now;
        entry.blockedUntil = null;
      }

      if (!entry) {
        evictIfAtCapacity(now);
        entry = { count: 0, firstSeenAt: now, lastSeenAt: now, blockedUntil: null };
        entries.set(signature, entry);
      } else if (now - entry.firstSeenAt > config.windowMs) {
        // The window fully elapsed since this signature's first
        // occurrence — start counting fresh rather than penalizing
        // requests spread out over time.
        entry.count = 0;
        entry.firstSeenAt = now;
      }

      entry.count += 1;
      entry.lastSeenAt = now;

      if (entry.count > config.threshold) {
        entry.blockedUntil = now + config.blockDurationMs;
        return { blocked: true, retryAfterMs: config.blockDurationMs };
      }

      return { blocked: false };
    },
    size(): number {
      return entries.size;
    },
  };
}
