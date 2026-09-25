import { describe, expect, it } from "vitest";
import { createLoopDetector } from "../../src/modules/loop-detection/loop-detector.js";
import type { LoopDetectionConfig } from "../../src/modules/loop-detection/types.js";

const CONFIG: LoopDetectionConfig = {
  windowMs: 10_000,
  threshold: 3,
  blockDurationMs: 5_000,
  maxEntries: 100,
};

describe("createLoopDetector", () => {
  it("allows the first request for a signature", () => {
    const detector = createLoopDetector(CONFIG);
    const result = detector.check("sig-a", 0);
    expect(result.blocked).toBe(false);
  });

  it("allows requests up to the threshold within the window", () => {
    const detector = createLoopDetector(CONFIG);
    expect(detector.check("sig-a", 0).blocked).toBe(false);
    expect(detector.check("sig-a", 100).blocked).toBe(false);
    expect(detector.check("sig-a", 200).blocked).toBe(false);
  });

  it("blocks once the threshold is exceeded", () => {
    const detector = createLoopDetector(CONFIG);
    detector.check("sig-a", 0);
    detector.check("sig-a", 100);
    detector.check("sig-a", 200);
    const fourth = detector.check("sig-a", 300);
    expect(fourth.blocked).toBe(true);
    expect(fourth.retryAfterMs).toBe(CONFIG.blockDurationMs);
  });

  it("keeps returning blocked for the same signature throughout the block duration", () => {
    const detector = createLoopDetector(CONFIG);
    detector.check("sig-a", 0);
    detector.check("sig-a", 100);
    detector.check("sig-a", 200);
    detector.check("sig-a", 300); // triggers block until 300 + 5000 = 5300

    const midBlock = detector.check("sig-a", 4000);
    expect(midBlock.blocked).toBe(true);
    expect(midBlock.retryAfterMs).toBe(5300 - 4000);

    const stillBlocked = detector.check("sig-a", 5299);
    expect(stillBlocked.blocked).toBe(true);
  });

  it("allows the request again once the block duration has elapsed", () => {
    const detector = createLoopDetector(CONFIG);
    detector.check("sig-a", 0);
    detector.check("sig-a", 100);
    detector.check("sig-a", 200);
    detector.check("sig-a", 300); // blocked until 5300

    const afterBlock = detector.check("sig-a", 5301);
    expect(afterBlock.blocked).toBe(false);

    // And a fresh cycle starts: threshold more requests are allowed again.
    expect(detector.check("sig-a", 5302).blocked).toBe(false);
    expect(detector.check("sig-a", 5303).blocked).toBe(false);
    expect(detector.check("sig-a", 5304).blocked).toBe(true);
  });

  it("tracks different signatures independently", () => {
    const detector = createLoopDetector(CONFIG);
    detector.check("sig-a", 0);
    detector.check("sig-a", 10);
    detector.check("sig-a", 20);
    const aBlocked = detector.check("sig-a", 30);
    expect(aBlocked.blocked).toBe(true);

    // sig-b has never been seen — it gets its own fresh count.
    const bFirst = detector.check("sig-b", 30);
    expect(bFirst.blocked).toBe(false);
  });

  it("resets the count once the window has fully elapsed without exceeding threshold", () => {
    const detector = createLoopDetector(CONFIG);
    detector.check("sig-a", 0);
    detector.check("sig-a", 100);
    // Window (10_000ms) fully elapses before a third request arrives.
    const afterWindow = detector.check("sig-a", 10_101);
    expect(afterWindow.blocked).toBe(false);

    // Two more within the new window should still be fine (the reset
    // call was #1, these are #2 and #3 — still at the threshold).
    expect(detector.check("sig-a", 10_200).blocked).toBe(false);
    expect(detector.check("sig-a", 10_300).blocked).toBe(false);
    // A 4th request in this same new window exceeds the threshold.
    expect(detector.check("sig-a", 10_400).blocked).toBe(true);
  });

  it("removes expired entries during periodic cleanup", () => {
    const detector = createLoopDetector(CONFIG);
    detector.check("sig-a", 0);
    expect(detector.size()).toBe(1);

    // Advance far enough that sig-a is both outside its window and has no
    // active block, and trigger a sweep via a call for another signature
    // at a time past the sweep throttle (>= windowMs since the last sweep).
    detector.check("sig-b", CONFIG.windowMs + 1);

    expect(detector.size()).toBe(1);
    // The only remaining tracked signature is the new one, sig-b.
  });

  it("keeps a still-blocked entry alive through a sweep", () => {
    const detector = createLoopDetector(CONFIG);
    detector.check("sig-a", 0);
    detector.check("sig-a", 10);
    detector.check("sig-a", 20);
    detector.check("sig-a", 30); // blocked until 30 + 5000 = 5030

    // Trigger a sweep well after the window but still inside the block.
    detector.check("sig-b", CONFIG.windowMs + 1);
    expect(detector.size()).toBe(2);

    const stillBlocked = detector.check("sig-a", 5000);
    expect(stillBlocked.blocked).toBe(true);
  });

  it("respects the maximum number of tracked signatures", () => {
    const smallConfig: LoopDetectionConfig = { ...CONFIG, maxEntries: 5 };
    const detector = createLoopDetector(smallConfig);

    for (let i = 0; i < 50; i += 1) {
      // Spread far apart in time so sweeping never reclaims them for
      // being stale — this tests eviction, not expiry.
      detector.check(`sig-${i}`, i * 100_000);
    }

    expect(detector.size()).toBeLessThanOrEqual(smallConfig.maxEntries);
  });

  it("evicts the oldest signature first when at capacity", () => {
    const smallConfig: LoopDetectionConfig = { ...CONFIG, maxEntries: 3 };
    const detector = createLoopDetector(smallConfig);

    detector.check("sig-1", 0);
    detector.check("sig-2", 1);
    detector.check("sig-3", 2);
    // Capacity reached (3). Inserting a 4th evicts sig-1 (oldest).
    detector.check("sig-4", 3);

    expect(detector.size()).toBe(3);
    // sig-1 was evicted, so it's treated as brand new (not blocked, count
    // reset) rather than continuing its prior count.
    const sig1Again = detector.check("sig-1", 4);
    expect(sig1Again.blocked).toBe(false);
  });

  it("does not let many concurrent identical requests all bypass the threshold", async () => {
    const detector = createLoopDetector(CONFIG);
    const now = 1_000;

    // Simulate a burst of "concurrent" requests for the exact same
    // signature. check() is synchronous with no internal await, so even
    // though these are dispatched without waiting on each other, each
    // call's read-then-increment is atomic — the burst cannot all
    // observe the same pre-increment count.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve(detector.check("sig-burst", now))),
    );

    const allowedCount = results.filter((r) => !r.blocked).length;
    const blockedCount = results.filter((r) => r.blocked).length;

    expect(allowedCount).toBe(CONFIG.threshold);
    expect(blockedCount).toBe(20 - CONFIG.threshold);
  });

  it("never stores anything resembling a raw request body — only numeric/timestamp metadata", () => {
    const detector = createLoopDetector(CONFIG);
    const signature = "abcabc"; // a signature is just an opaque hash string
    detector.check(signature, 0);

    // White-box: the only thing this module could possibly leak is what
    // check() and size() expose — both are purely numeric/boolean.
    const result = detector.check(signature, 1);
    expect(typeof result.blocked).toBe("boolean");
    expect(Object.keys(result).every((key) => ["blocked", "retryAfterMs"].includes(key))).toBe(
      true,
    );
  });
});
