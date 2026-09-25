import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUsageQueue } from "../../src/modules/usage-logging/usage-queue.js";
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

describe("createUsageQueue", () => {
  it("enqueues and dequeues in FIFO order", () => {
    const queue = createUsageQueue(10);
    const a = buildEvent({ requestId: "a" });
    const b = buildEvent({ requestId: "b" });
    const c = buildEvent({ requestId: "c" });

    queue.enqueue(a);
    queue.enqueue(b);
    queue.enqueue(c);

    expect(queue.dequeue()?.requestId).toBe("a");
    expect(queue.dequeue()?.requestId).toBe("b");
    expect(queue.dequeue()?.requestId).toBe("c");
  });

  it("returns undefined when dequeuing an empty queue", () => {
    const queue = createUsageQueue(10);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("reports size accurately as items are enqueued and dequeued", () => {
    const queue = createUsageQueue(10);
    expect(queue.size()).toBe(0);
    queue.enqueue(buildEvent());
    queue.enqueue(buildEvent());
    expect(queue.size()).toBe(2);
    queue.dequeue();
    expect(queue.size()).toBe(1);
  });

  it("respects bounded capacity: enqueue rejects once at maxSize", () => {
    const queue = createUsageQueue(3);
    expect(queue.enqueue(buildEvent())).toBe(true);
    expect(queue.enqueue(buildEvent())).toBe(true);
    expect(queue.enqueue(buildEvent())).toBe(true);
    expect(queue.enqueue(buildEvent())).toBe(false);
    expect(queue.size()).toBe(3);
  });

  it("never grows past maxSize even under many rejected enqueue attempts", () => {
    const queue = createUsageQueue(5);
    for (let i = 0; i < 500; i += 1) {
      queue.enqueue(buildEvent());
    }
    expect(queue.size()).toBeLessThanOrEqual(5);
  });

  it("accepts a new enqueue again once capacity frees up after a dequeue", () => {
    const queue = createUsageQueue(1);
    expect(queue.enqueue(buildEvent({ requestId: "first" }))).toBe(true);
    expect(queue.enqueue(buildEvent({ requestId: "second" }))).toBe(false);

    queue.dequeue();
    expect(queue.enqueue(buildEvent({ requestId: "second" }))).toBe(true);
    expect(queue.size()).toBe(1);
  });

  it("rejects new enqueues once closed", () => {
    const queue = createUsageQueue(10);
    queue.close();
    expect(queue.enqueue(buildEvent())).toBe(false);
    expect(queue.closed).toBe(true);
  });

  it("close() is idempotent", () => {
    const queue = createUsageQueue(10);
    expect(() => {
      queue.close();
      queue.close();
    }).not.toThrow();
  });

  it("waitForItem() resolves once an item is enqueued", async () => {
    const queue = createUsageQueue(10);
    const waitPromise = queue.waitForItem();
    let resolved = false;
    void waitPromise.then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);

    queue.enqueue(buildEvent());
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("waitForItem() resolves once the queue is closed, so a waiting consumer is never stuck", async () => {
    const queue = createUsageQueue(10);
    const waitPromise = queue.waitForItem();
    queue.close();
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("wakes multiple concurrent waiters on a single enqueue", async () => {
    const queue = createUsageQueue(10);
    const waiters = [queue.waitForItem(), queue.waitForItem(), queue.waitForItem()];
    queue.enqueue(buildEvent());
    await expect(Promise.all(waiters)).resolves.toBeDefined();
  });
});
