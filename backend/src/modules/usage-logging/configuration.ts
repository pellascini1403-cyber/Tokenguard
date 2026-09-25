import { parsePositiveInt } from "../../lib/env-parsing.js";
import type { UsageLoggingConfig } from "./types.js";

// Sensible development defaults.
//
// 5,000 queued events comfortably absorbs a burst far larger than any
// single TokenGuard instance's realistic request rate before persistence
// catches up, while still bounding worst-case memory (each event is a
// small, fixed-shape metadata object — see types.ts). 4 concurrent
// worker lanes is enough to keep pace with steady traffic without
// opening excessive concurrent connections to Postgres.
export const DEFAULT_USAGE_LOG_QUEUE_MAX_SIZE = 5_000;
export const DEFAULT_USAGE_LOG_WORKER_CONCURRENCY = 4;
// 5 seconds is generous for currently-in-flight jobs to finish and for
// the (bounded) queue to drain during a normal deploy, without making
// `SIGTERM` hang noticeably.
export const DEFAULT_USAGE_LOG_SHUTDOWN_TIMEOUT_MS = 5_000;

// Retry tuning is intentionally not environment-configurable — a small,
// stable policy suffices for a transient DB blip, and exposing it as env
// vars would add configuration surface for a knob operators are unlikely
// to need to change. See usage-worker.ts for how these are used
// (exponential backoff with jitter, capped at retryMaxDelayMs).
export const DEFAULT_USAGE_LOG_MAX_RETRY_ATTEMPTS = 5;
export const DEFAULT_USAGE_LOG_RETRY_BASE_DELAY_MS = 200;
export const DEFAULT_USAGE_LOG_RETRY_MAX_DELAY_MS = 5_000;

export function parseUsageLoggingConfig(source: NodeJS.ProcessEnv): UsageLoggingConfig {
  return {
    maxQueueSize: parsePositiveInt(
      source.USAGE_LOG_QUEUE_MAX_SIZE,
      DEFAULT_USAGE_LOG_QUEUE_MAX_SIZE,
      "USAGE_LOG_QUEUE_MAX_SIZE",
    ),
    workerConcurrency: parsePositiveInt(
      source.USAGE_LOG_WORKER_CONCURRENCY,
      DEFAULT_USAGE_LOG_WORKER_CONCURRENCY,
      "USAGE_LOG_WORKER_CONCURRENCY",
    ),
    shutdownTimeoutMs: parsePositiveInt(
      source.USAGE_LOG_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_USAGE_LOG_SHUTDOWN_TIMEOUT_MS,
      "USAGE_LOG_SHUTDOWN_TIMEOUT_MS",
    ),
    maxRetryAttempts: DEFAULT_USAGE_LOG_MAX_RETRY_ATTEMPTS,
    retryBaseDelayMs: DEFAULT_USAGE_LOG_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: DEFAULT_USAGE_LOG_RETRY_MAX_DELAY_MS,
  };
}
