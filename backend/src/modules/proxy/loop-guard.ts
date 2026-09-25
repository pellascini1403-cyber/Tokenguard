import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { ErrorResponseBody } from "../../types/api.js";
import type { LoopDetector } from "../loop-detection/loop-detector.js";
import { computeRequestSignature } from "../loop-detection/request-signature.js";
import type { Provider } from "../usage/types.js";

export const AGENT_LOOP_ERROR_CODE = "AGENT_LOOP_DETECTED";

export interface LoopGuardParams {
  detector: LoopDetector;
  organizationId: string;
  tokenGuardKeyId: string;
  provider: Provider;
  endpoint: string;
  requestedModel: string | null;
  /** The already-parsed JSON request body — hashed immediately inside
   * computeRequestSignature and never retained by this function. */
  parsedBody: unknown;
  requestId: string;
}

export interface LoopGuardDecision {
  blocked: boolean;
}

/**
 * Runs loop detection for one proxy request and, if it's a repeat past
 * the configured threshold, writes the 429 response itself and reports
 * `blocked: true` — the caller must stop immediately without contacting
 * the provider. Shared by both the OpenAI and Anthropic routes, and by
 * both streaming and non-streaming requests, so this decision (and its
 * response shape) exists in exactly one place.
 */
export function enforceLoopDetection(
  params: LoopGuardParams,
  reply: FastifyReply,
  logger: FastifyBaseLogger,
): LoopGuardDecision {
  const signature = computeRequestSignature({
    organizationId: params.organizationId,
    tokenGuardKeyId: params.tokenGuardKeyId,
    provider: params.provider,
    endpoint: params.endpoint,
    model: params.requestedModel,
    parsedBody: params.parsedBody,
  });

  const result = params.detector.check(signature);
  if (!result.blocked) {
    return { blocked: false };
  }

  const retryAfterSeconds =
    result.retryAfterMs !== undefined ? Math.ceil(result.retryAfterMs / 1000) : undefined;

  // Structured, privacy-safe metadata only — never the signature itself,
  // never any request content. A logging failure must never break the
  // (already-decided) response.
  try {
    logger.warn(
      {
        requestId: params.requestId,
        organizationId: params.organizationId,
        tokenGuardKeyId: params.tokenGuardKeyId,
        provider: params.provider,
        endpoint: params.endpoint,
        model: params.requestedModel,
        errorCode: AGENT_LOOP_ERROR_CODE,
      },
      "Blocked a repeated request: possible agent loop detected",
    );
  } catch {
    // Never let a logging failure block the response below.
  }

  if (retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(retryAfterSeconds));
  }

  const body: ErrorResponseBody = {
    error: {
      code: AGENT_LOOP_ERROR_CODE,
      message:
        "Too many identical requests in a short time window. Please slow down and retry later.",
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    },
  };
  reply.status(429).send(body);
  return { blocked: true };
}
