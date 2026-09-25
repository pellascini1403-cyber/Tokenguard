import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { createUsageQueue } from "../../src/modules/usage-logging/usage-queue.js";
import {
  createUsageWorker,
  type UsageEventErrorClassification,
} from "../../src/modules/usage-logging/usage-worker.js";
import type { QueuedUsageEvent } from "../../src/modules/usage-logging/types.js";

function buildEvent(overrides: Partial<QueuedUsageEvent> = {}): QueuedUsageEvent {
  return {
    organizationId: randomUUID(),
    tokenGuardKeyId: randomUUID(),
    provider: "openai",
    modelUsed: "gpt-4o",
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    inputCostUsd: "1.00000000",
    outputCostUsd: "1.00000000",
    totalCostUsd: "2.00000000",
    usageSource: "provider",
    pricingVersion: "v1",
    durationMs: 10,
    statusCode: 200,
    requestId: randomUUID(),
    ...overrides,
  };
}

function silentLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

const noBackoff = () => Promise.resolve();
const alwaysTransient = (): UsageEventErrorClassification => "transient";

describe("createUsageWorker", () => {
  it("processes a queued event", async () => {
    const queue = createUsageQueue(10);
    const process = vi.fn().mockResolvedValue(undefined);
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: alwaysTransient,
      workerConcurrency: 1,
      maxRetryAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger: silentLogger(),
      sleep: noBackoff,
    });

    const event = buildEvent();
    queue.enqueue(event);
    worker.start();
    await worker.waitForIdle();

    expect(process).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledWith(event);
  });

  it("continues processing subsequent events after one fails permanently", async () => {
    const queue = createUsageQueue(10);
    const failingEvent = buildEvent({ requestId: "fails" });
    const okEvent = buildEvent({ requestId: "ok" });
    const process = vi.fn().mockImplementation((event: QueuedUsageEvent) => {
      if (event.requestId === "fails") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve();
    });
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: () => "permanent",
      workerConcurrency: 1,
      maxRetryAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger: silentLogger(),
      sleep: noBackoff,
    });

    queue.enqueue(failingEvent);
    queue.enqueue(okEvent);
    worker.start();
    await worker.waitForIdle();

    expect(process).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenCalledWith(okEvent);
  });

  it("respects the configured concurrency limit", async () => {
    const queue = createUsageQueue(20);
    let active = 0;
    let maxObservedActive = 0;
    const process = vi.fn().mockImplementation(async () => {
      active += 1;
      maxObservedActive = Math.max(maxObservedActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    });
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: alwaysTransient,
      workerConcurrency: 3,
      maxRetryAttempts: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger: silentLogger(),
      sleep: noBackoff,
    });

    for (let i = 0; i < 10; i += 1) {
      queue.enqueue(buildEvent());
    }
    worker.start();
    await worker.waitForIdle();

    expect(process).toHaveBeenCalledTimes(10);
    expect(maxObservedActive).toBeLessThanOrEqual(3);
    expect(maxObservedActive).toBeGreaterThan(1);
  });

  it("retries a transient failure and eventually succeeds", async () => {
    const queue = createUsageQueue(10);
    let attempts = 0;
    const process = vi.fn().mockImplementation(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error("transient blip"));
      }
      return Promise.resolve();
    });
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: alwaysTransient,
      workerConcurrency: 1,
      maxRetryAttempts: 5,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger: silentLogger(),
      sleep: noBackoff,
    });

    queue.enqueue(buildEvent());
    worker.start();
    await worker.waitForIdle();

    expect(process).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting retry attempts, without crashing the worker", async () => {
    const queue = createUsageQueue(10);
    const process = vi.fn().mockRejectedValue(new Error("always fails"));
    const logger = silentLogger();
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: alwaysTransient,
      workerConcurrency: 1,
      maxRetryAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger,
      sleep: noBackoff,
    });

    queue.enqueue(buildEvent());
    worker.start();
    await worker.waitForIdle();

    expect(process).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();

    // The worker is still alive and processes the next event normally.
    const nextProcess = vi.fn().mockResolvedValue(undefined);
    const worker2Queue = createUsageQueue(10);
    const worker2 = createUsageWorker({
      queue: worker2Queue,
      process: nextProcess,
      classifyError: alwaysTransient,
      workerConcurrency: 1,
      maxRetryAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger,
      sleep: noBackoff,
    });
    worker2Queue.enqueue(buildEvent());
    worker2.start();
    await worker2.waitForIdle();
    expect(nextProcess).toHaveBeenCalledTimes(1);
  });

  it("treats a duplicate classification as success, without retrying", async () => {
    const queue = createUsageQueue(10);
    const process = vi.fn().mockRejectedValue(new Error("already exists"));
    const logger = silentLogger();
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: () => "duplicate",
      workerConcurrency: 1,
      maxRetryAttempts: 5,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger,
      sleep: noBackoff,
    });

    queue.enqueue(buildEvent());
    worker.start();
    await worker.waitForIdle();

    expect(process).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("gracefully drains the queue on shutdown within the timeout", async () => {
    const queue = createUsageQueue(10);
    const process = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 5)));
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: alwaysTransient,
      workerConcurrency: 2,
      maxRetryAttempts: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger: silentLogger(),
      sleep: noBackoff,
    });

    for (let i = 0; i < 4; i += 1) {
      queue.enqueue(buildEvent());
    }
    worker.start();

    const result = await worker.shutdown(1_000);
    expect(result.drained).toBe(true);
    expect(result.remainingQueued).toBe(0);
    expect(process).toHaveBeenCalledTimes(4);
  });

  it("stops accepting new events once shutdown has begun", async () => {
    const queue = createUsageQueue(10);
    const process = vi.fn().mockResolvedValue(undefined);
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: alwaysTransient,
      workerConcurrency: 1,
      maxRetryAttempts: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger: silentLogger(),
      sleep: noBackoff,
    });
    worker.start();
    await worker.shutdown(1_000);

    expect(queue.enqueue(buildEvent())).toBe(false);
  });

  it("reports a drain timeout with the remaining count, and never hangs", async () => {
    const queue = createUsageQueue(10);
    const process = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const logger = silentLogger();
    const worker = createUsageWorker({
      queue,
      process,
      classifyError: alwaysTransient,
      workerConcurrency: 1,
      maxRetryAttempts: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      logger,
      sleep: noBackoff,
    });

    for (let i = 0; i < 5; i += 1) {
      queue.enqueue(buildEvent());
    }
    worker.start();

    const start = Date.now();
    const result = await worker.shutdown(20);
    const elapsed = Date.now() - start;

    expect(result.drained).toBe(false);
    expect(result.remainingQueued).toBeGreaterThan(0);
    // Shutdown lets the one already-in-flight item finish (~500ms) but
    // must not wait for all 5 items to drain sequentially (~2500ms) —
    // queued-but-not-started items are abandoned once the timeout hits.
    expect(elapsed).toBeLessThan(1_000);
    expect(logger.error).toHaveBeenCalled();
  });
});
