import type { QueuedUsageEvent } from "./types.js";

/**
 * A minimal async condition signal: any number of callers can `wait()`
 * for "something happened", and `fire()` wakes all of them at once.
 * Used so worker lanes can block until new work arrives (or the queue
 * closes) without busy-polling — no timers, no interval checks.
 */
class Signal {
  private waiters: Array<() => void> = [];

  wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  fire(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}

export interface UsageQueue {
  readonly maxSize: number;
  readonly closed: boolean;
  /** FIFO-orders a new event. Returns false without enqueuing if the
   * queue is at `maxSize` or already closed — never grows past
   * `maxSize`, never throws. */
  enqueue(event: QueuedUsageEvent): boolean;
  /** Removes and returns the oldest event, or undefined if empty. */
  dequeue(): QueuedUsageEvent | undefined;
  size(): number;
  /** Resolves once `enqueue()` succeeds or `close()` is called, whichever
   * comes first — the caller should re-check `size()`/`closed` after
   * waking, since multiple lanes race to dequeue. */
  waitForItem(): Promise<void>;
  /** Stops accepting new events (enqueue() becomes a no-op returning
   * false) and wakes any waiting lanes so they can observe the closure
   * and exit once the queue is empty. Idempotent. */
  close(): void;
}

/**
 * A bounded, in-process, FIFO queue. Backed by a plain array — at the
 * sizes this queue is configured for (thousands of small metadata
 * objects, see configuration.ts), an O(n) `shift()` per dequeue is not a
 * meaningful cost, and a plain array keeps this easy to read. This is
 * deliberately the only data structure here: an external durable queue
 * (Step 9's documented future direction) would replace this whole file,
 * not extend it.
 */
export function createUsageQueue(maxSize: number): UsageQueue {
  const items: QueuedUsageEvent[] = [];
  const signal = new Signal();
  let closed = false;

  return {
    maxSize,
    get closed() {
      return closed;
    },
    enqueue(event: QueuedUsageEvent): boolean {
      if (closed || items.length >= maxSize) {
        return false;
      }
      items.push(event);
      signal.fire();
      return true;
    },
    dequeue(): QueuedUsageEvent | undefined {
      return items.shift();
    },
    size(): number {
      return items.length;
    },
    waitForItem(): Promise<void> {
      return signal.wait();
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      signal.fire();
    },
  };
}
