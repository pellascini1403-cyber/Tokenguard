import type { FastifyBaseLogger } from "fastify";
import { AppError } from "../../lib/errors.js";
import {
  DuplicateRequestIdError,
  InconsistentKeyOrganizationError,
} from "../usage/usage.repository.js";
import type { UsageService } from "../usage/usage.service.js";
import { createUsageQueue } from "./usage-queue.js";
import { createUsageWorker, type UsageEventErrorClassification } from "./usage-worker.js";
import type { QueuedUsageEvent, UsageLoggingConfig, UsageLoggingService } from "./types.js";

/**
 * token_logs.request_id is already a unique index (Step 3) — the same
 * guarantee `usageService.createUsageLog()` already enforces for a
 * direct/synchronous caller. Reusing it here (rather than inventing a
 * second, queue-specific idempotency mechanism) is what makes a worker
 * retry, or a process-level duplicate enqueue, safe: the second attempt
 * always hits the same DuplicateRequestIdError and is treated as
 * success, never a second row.
 */
function classifyUsageLogError(error: unknown): UsageEventErrorClassification {
  if (error instanceof DuplicateRequestIdError) {
    return "duplicate";
  }
  if (error instanceof InconsistentKeyOrganizationError || error instanceof AppError) {
    // Validation/consistency errors are a bug in what was enqueued, not
    // a transient DB hiccup — retrying the exact same event can only
    // ever fail the same way.
    return "permanent";
  }
  return "transient";
}

/**
 * Builds the async usage-logging service: an in-process bounded queue
 * plus a small worker pool that persists queued events via the existing
 * Step 3 `usageService.createUsageLog()` — no second, parallel
 * persistence path. This is the ONLY thing this service does; Step 8
 * budget accounting is a separate, synchronous concern handled directly
 * in usage-recorder.ts before an event ever reaches this queue (see that
 * module's doc comments for why).
 */
export function createUsageLoggingService(
  usageService: UsageService,
  config: UsageLoggingConfig,
  logger: FastifyBaseLogger,
): UsageLoggingService {
  const queue = createUsageQueue(config.maxQueueSize);
  const worker = createUsageWorker({
    queue,
    process: async (event: QueuedUsageEvent) => {
      await usageService.createUsageLog(event);
    },
    classifyError: classifyUsageLogError,
    workerConcurrency: config.workerConcurrency,
    maxRetryAttempts: config.maxRetryAttempts,
    retryBaseDelayMs: config.retryBaseDelayMs,
    retryMaxDelayMs: config.retryMaxDelayMs,
    logger,
  });

  worker.start();
  logger.info(
    { maxQueueSize: config.maxQueueSize, workerConcurrency: config.workerConcurrency },
    "Usage logging queue initialized",
  );

  return {
    enqueue(event: QueuedUsageEvent): boolean {
      const accepted = queue.enqueue(event);
      if (!accepted) {
        // Usage tracking is financially relevant — this is never a
        // silent drop. The provider response itself is already decided
        // by the time this runs (see usage-recorder.ts), so this can
        // only ever affect the audit trail, never the client, and never
        // Step 8 budget accounting (already committed synchronously,
        // before this call).
        logger.error(
          {
            requestId: event.requestId,
            organizationId: event.organizationId,
            provider: event.provider,
            model: event.modelUsed,
            queueSize: queue.size(),
            maxQueueSize: queue.maxSize,
            errorCode: "USAGE_LOG_QUEUE_FULL",
          },
          "Usage logging queue is full — this request's usage log could not be queued and may be lost",
        );
      }
      return accepted;
    },
    size(): number {
      return queue.size();
    },
    waitForIdle(): Promise<void> {
      return worker.waitForIdle();
    },
    shutdown(timeoutMs?: number) {
      return worker.shutdown(timeoutMs ?? config.shutdownTimeoutMs);
    },
  };
}
