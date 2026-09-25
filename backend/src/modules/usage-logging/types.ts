import type { UsageLogInput } from "../usage/types.js";

/**
 * Exactly what a queued usage-logging job needs to eventually persist
 * one token_logs row — reuses Step 3/5's own `UsageLogInput` rather than
 * duplicating its fields. Deliberately excludes anything this shape
 * doesn't already carry: no provider API keys, Authorization headers,
 * prompts, responses, or raw request bodies ever flow through this
 * queue — `UsageLogInput` was already metadata-only.
 */
export type QueuedUsageEvent = UsageLogInput;

/** Tunables for the in-process usage-logging queue/worker. See
 * configuration.ts for environment-variable parsing and documented
 * defaults. */
export interface UsageLoggingConfig {
  /** Maximum number of queued-but-not-yet-processed events. Bounds
   * memory use — enqueue() rejects (returns false) once full rather
   * than growing without limit. */
  maxQueueSize: number;
  /** Number of events the worker processes concurrently. */
  workerConcurrency: number;
  /** How many times a transient failure is retried before the event is
   * given up on (logged, not persisted). Not env-configurable — small
   * and stable enough to be a documented constant; see
   * configuration.ts. */
  maxRetryAttempts: number;
  /** Base delay for exponential backoff between retry attempts, in
   * milliseconds. */
  retryBaseDelayMs: number;
  /** Ceiling on the backoff delay, in milliseconds, regardless of how
   * many attempts have elapsed. */
  retryMaxDelayMs: number;
  /** Default timeout for graceful shutdown (draining the queue) when
   * none is explicitly passed to `shutdown()`. */
  shutdownTimeoutMs: number;
}

/** Result of a graceful shutdown attempt. */
export interface UsageLoggingShutdownResult {
  /** True if the queue was fully drained (empty, nothing in flight)
   * before the timeout elapsed. */
  drained: boolean;
  /** Number of events still queued (not yet even started) when shutdown
   * returned — 0 when `drained` is true. */
  remainingQueued: number;
}

export interface UsageLoggingService {
  /**
   * Enqueues one usage event for asynchronous persistence. Synchronous,
   * non-blocking, and never throws: returns `true` if accepted, `false`
   * if the queue is full (bounded — see maxQueueSize). A `false` result
   * is not a request failure; the caller already has its provider
   * response and this service has already logged the drop internally
   * (see usage-logging.service.ts) — callers do not need to log it
   * again.
   */
  enqueue(event: QueuedUsageEvent): boolean;
  /** Current queue length (not counting events currently being
   * processed by a worker lane). */
  size(): number;
  /**
   * Resolves once the queue is empty and no event is currently being
   * processed. Not part of the production request path — intended for
   * graceful shutdown and for tests that need to observe the outcome of
   * an enqueued event.
   */
  waitForIdle(): Promise<void>;
  /**
   * Stops accepting new events, waits for the queue to drain (up to
   * `timeoutMs`, defaulting to the configured shutdownTimeoutMs), then
   * stops the worker. Safe to call once during application shutdown.
   */
  shutdown(timeoutMs?: number): Promise<UsageLoggingShutdownResult>;
}

declare module "fastify" {
  interface FastifyInstance {
    /**
     * The app's single usage-logging queue/worker instance. Decorated
     * on the instance (rather than threaded through DI everywhere) so
     * tests and operational tooling can reach it directly — e.g.
     * `await app.usageLoggingService.waitForIdle()` to deterministically
     * observe a queued event's outcome, or its `size()` for a health
     * check. `app.close()` already drains it gracefully via an `onClose`
     * hook (see app.ts) — most callers never need this directly.
     */
    usageLoggingService: UsageLoggingService;
  }
}
