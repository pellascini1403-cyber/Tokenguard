/**
 * Error codes the TokenGuard backend actually returns, gathered from
 * backend/src/lib/errors.ts, budget-errors.ts, and loop-guard.ts. This is
 * deliberately not exhaustive of every string the backend could ever
 * produce (an unrecognized error still round-trips through the `string`
 * fallback in TokenGuardApiError) — it exists so call sites can switch on
 * the codes that matter today without inventing ones the backend doesn't
 * have.
 */
export type KnownApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "AGENT_LOOP_DETECTED"
  | "MONTHLY_BUDGET_EXCEEDED"
  | "BUDGET_CHECK_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "REQUEST_ERROR";

/** Mirrors backend/src/types/api.ts's ErrorResponseBody exactly. */
export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
  };
}

/**
 * Thrown by the API client for any non-2xx backend response, and for
 * network-level failures (no response at all). `code` is left as
 * `string`, not `KnownApiErrorCode`, because a client-side switch should
 * still have a safe default for a code this file doesn't know about yet
 * — narrow with the KnownApiErrorCode union at the call site instead of
 * trusting this type to be closed.
 */
export class TokenGuardApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryAfterSeconds?: number;

  constructor(code: string, statusCode: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "TokenGuardApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A request-level failure before any HTTP response was received. */
export class TokenGuardNetworkError extends Error {
  constructor(cause: unknown) {
    super("Failed to reach the TokenGuard backend");
    this.name = "TokenGuardNetworkError";
    this.cause = cause;
  }
}
