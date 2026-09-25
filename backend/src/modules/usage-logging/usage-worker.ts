import type { FastifyBaseLogger } from "fastify";
import type { QueuedUsageEvent, UsageLoggingShutdownResult } from "./types.js";
import type { UsageQueue } from "./usage-queue.js";

export type UsageEventErrorClassification = "duplicate" | "permanent" | "transient";

export interface UsageWorkerDeps {
  queue: UsageQueue;
  /** Persists one event. Throws on failure — the worker classifies and
   * handles the error; this function does not need to know about
   * retries. */
  process: (event: QueuedUsageEvent) => Promise<void>;
  /** Determines whether a thrown error means "already done, treat as
   * success" (duplicate), "will never succeed, stop retrying"
   * (permanent), or "might succeed on retry" (transient — the default
   * when unset or when the classifier itself throws). */
  classifyError: (error: unknown) => UsageEventErrorClassification;
  workerConcurrency: number;
  maxRetryAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  logger: FastifyBaseLogger;
  /** Injectable only for tests that need deterministic retry timing —
   * production code never overrides this. */
  sleep?: (ms: number) => Promise<void>;
}

export interface UsageWorker {
  start(): void;
  waitForIdle(): Promise<void>;
  shutdown(timeoutMs: number): Promise<UsageLoggingShutdownResult>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter: a random delay between 0 and
 * the exponentially-growing cap, so many events retrying at once don't
 * all retry in lockstep (thundering herd) while still bounded by
 * retryMaxDelayMs regardless of attempt count. */
function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.random() * cap;
}

/**
 * Consumes a UsageQueue with a fixed pool of concurrent "lanes", each
 * running a non-busy loop: dequeue an item, or block on
 * `queue.waitForItem()` until one arrives or the queue closes. A single
 * failing/malformed event is caught, classified, retried with backoff
 * up to a bound, and then given up on — it never stops the lane or
 * crashes the process.
 */
export function createUsageWorker(deps: UsageWorkerDeps): UsageWorker {
  const sleep = deps.sleep ?? defaultSleep;
  let running = false;
  // Distinct from `queue.closed`: closing the queue only stops new
  // enqueue() calls from succeeding. `stopped` additionally tells a lane
  // to stop pulling any more (already-queued) items — set only when a
  // shutdown timeout elapses, so queued-but-not-yet-started items are
  // abandoned rather than drained regardless of how long that takes. An
  // item already being processed is unaffected: it's allowed to finish
  // (including any retry already in progress), matching "let in-flight
  // work finish, but don't start more."
  let stopped = false;
  let activeCount = 0;
  let idleWaiters: Array<() => void> = [];
  const lanePromises: Promise<void>[] = [];

  function notifyIfIdle(): void {
    if (deps.queue.size() === 0 && activeCount === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  async function processWithRetry(event: QueuedUsageEvent): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deps.process(event);
        return;
      } catch (error) {
        let classification: UsageEventErrorClassification;
        try {
          classification = deps.classifyError(error);
        } catch {
          classification = "transient";
        }

        if (classification === "duplicate") {
          // Already persisted (by an earlier attempt, or a prior
          // process instance) — this is success, not failure. See
          // idempotency notes in usage-logging.service.ts.
          deps.logger.info(
            { requestId: event.requestId, provider: event.provider, attempt },
            "Usage log already persisted — skipping duplicate (idempotent)",
          );
          return;
        }

        const exhausted = attempt >= deps.maxRetryAttempts;
        if (classification === "permanent" || exhausted) {
          deps.logger.error(
            {
              requestId: event.requestId,
              organizationId: event.organizationId,
              provider: event.provider,
              model: event.modelUsed,
              attempt,
              classification,
              err: error,
            },
            "Usage log persistence failed permanently — giving up on this event",
          );
          return;
        }

        deps.logger.warn(
          {
            requestId: event.requestId,
            provider: event.provider,
            attempt,
            maxAttempts: deps.maxRetryAttempts,
            err: error,
          },
          "Usage log persistence failed — retrying",
        );
        await sleep(backoffDelay(attempt, deps.retryBaseDelayMs, deps.retryMaxDelayMs));
      }
    }
  }

  async function lane(): Promise<void> {
    for (;;) {
      if (stopped) {
        return;
      }
      const event = deps.queue.dequeue();
      if (!event) {
        // Check `closed` (not a local flag) before deciding to wait: once
        // closed, no future enqueue() will ever fire the queue's signal
        // again, so waiting here after that point would hang forever.
        // This check and the `waitForItem()` call below are both
        // synchronous with no `await` between them, so there is no
        // window for `close()` to run in between and race this decision.
        if (deps.queue.closed) {
          return;
        }
        await deps.queue.waitForItem();
        continue;
      }

      activeCount += 1;
      try {
        await processWithRetry(event);
      } finally {
        activeCount -= 1;
        notifyIfIdle();
      }
    }
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      for (let i = 0; i < deps.workerConcurrency; i += 1) {
        lanePromises.push(lane());
      }
    },

    waitForIdle(): Promise<void> {
      if (deps.queue.size() === 0 && activeCount === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    async shutdown(timeoutMs: number): Promise<UsageLoggingShutdownResult> {
      running = false;
      deps.queue.close();

      const drainedInTime = await Promise.race([
        this.waitForIdle().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);

      if (!drainedInTime) {
        // Timed out: let whatever is currently in flight finish, but
        // stop pulling any more items off the queue so shutdown doesn't
        // keep waiting for the entire remaining backlog to drain.
        stopped = true;
      }

      await Promise.all(lanePromises);

      const remainingQueued = deps.queue.size();
      if (!drainedInTime || remainingQueued > 0) {
        deps.logger.error(
          { remainingQueued, timeoutMs },
          "Usage logging shutdown timed out before the queue fully drained — remaining events were not persisted",
        );
      } else {
        deps.logger.info({}, "Usage logging worker shut down cleanly — queue fully drained");
      }

      return { drained: drainedInTime && remainingQueued === 0, remainingQueued };
    },
  };
}
