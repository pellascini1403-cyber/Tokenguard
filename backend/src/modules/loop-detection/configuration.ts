import { parsePositiveInt } from "../../lib/env-parsing.js";
import type { LoopDetectionConfig } from "./types.js";

// Sensible development defaults — conservative enough that ordinary
// retries and legitimate repeated calls are never blocked, while still
// catching a genuinely runaway agent quickly.
//
// 5 identical requests inside a 10-second window are allowed; the 6th
// is treated as a loop and that exact request signature is blocked for
// 30 seconds. Up to 10,000 distinct signatures are tracked at once
// (process-local — see loop-detector.ts).
export const DEFAULT_AGENT_LOOP_WINDOW_MS = 10_000;
export const DEFAULT_AGENT_LOOP_THRESHOLD = 5;
export const DEFAULT_AGENT_LOOP_BLOCK_DURATION_MS = 30_000;
export const DEFAULT_AGENT_LOOP_MAX_ENTRIES = 10_000;

export function parseLoopDetectionConfig(source: NodeJS.ProcessEnv): LoopDetectionConfig {
  return {
    windowMs: parsePositiveInt(
      source.AGENT_LOOP_WINDOW_MS,
      DEFAULT_AGENT_LOOP_WINDOW_MS,
      "AGENT_LOOP_WINDOW_MS",
    ),
    threshold: parsePositiveInt(
      source.AGENT_LOOP_THRESHOLD,
      DEFAULT_AGENT_LOOP_THRESHOLD,
      "AGENT_LOOP_THRESHOLD",
    ),
    blockDurationMs: parsePositiveInt(
      source.AGENT_LOOP_BLOCK_DURATION_MS,
      DEFAULT_AGENT_LOOP_BLOCK_DURATION_MS,
      "AGENT_LOOP_BLOCK_DURATION_MS",
    ),
    maxEntries: parsePositiveInt(
      source.AGENT_LOOP_MAX_ENTRIES,
      DEFAULT_AGENT_LOOP_MAX_ENTRIES,
      "AGENT_LOOP_MAX_ENTRIES",
    ),
  };
}
