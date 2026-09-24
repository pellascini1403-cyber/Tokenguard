import type { FastifyServerOptions } from "fastify";
import type { NodeEnv } from "../config/env.js";

// Headers and fields that must never appear in logs. This matters because
// future requests will carry TokenGuard API keys, provider credentials, and
// customer prompts that must not be persisted to logs.
const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.headers['x-tokenguard-api-key']",
  "req.body",
  "res.body",
];

export function buildLoggerOptions(nodeEnv: NodeEnv): FastifyServerOptions["logger"] {
  const redact = {
    paths: REDACTED_PATHS,
    censor: "[redacted]",
  };

  if (nodeEnv === "production") {
    return { level: "info", redact };
  }

  if (nodeEnv === "test") {
    return false;
  }

  return {
    level: "debug",
    redact,
    transport: {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
    },
  };
}
