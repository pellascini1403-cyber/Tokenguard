import { Writable } from "node:stream";
import type { FastifyServerOptions } from "fastify";
import { REDACTED_PATHS } from "../../src/lib/logger.js";

export interface LogCollector {
  /** Pass as buildApp's `logger` option to capture what would actually be logged. */
  logger: FastifyServerOptions["logger"];
  /** Every collected log line as a raw string, once requests have settled. */
  lines(): string[];
}

/**
 * A real logger (same redaction config as production) writing to an
 * in-memory stream instead of stdout, so tests can assert that no secret
 * ever appears in a log line — not just that redaction is configured, but
 * that nothing bypasses it (e.g. an accidental extra log field).
 */
export function createLogCollector(): LogCollector {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });

  return {
    logger: {
      level: "debug",
      stream,
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    },
    lines: () => chunks.join("").split("\n").filter(Boolean),
  };
}
