import type { FastifyError } from "fastify";

export class AppError extends Error implements FastifyError {
  code: string;
  statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function unauthorizedError(message = "Authentication required"): AppError {
  return new AppError("UNAUTHORIZED", 401, message);
}

export function forbiddenError(message = "You do not have access to this resource"): AppError {
  return new AppError("FORBIDDEN", 403, message);
}

export function notFoundError(message = "Resource not found"): AppError {
  return new AppError("NOT_FOUND", 404, message);
}

export function badRequestError(message: string): AppError {
  return new AppError("BAD_REQUEST", 400, message);
}

export function streamingNotImplementedError(): AppError {
  return new AppError(
    "STREAMING_NOT_IMPLEMENTED",
    501,
    "Streaming responses are not yet supported by TokenGuard.",
  );
}

export function upstreamTimeoutError(): AppError {
  return new AppError("UPSTREAM_TIMEOUT", 504, "The AI provider did not respond in time.");
}

export function upstreamUnavailableError(): AppError {
  return new AppError("UPSTREAM_UNAVAILABLE", 502, "Failed to reach the AI provider.");
}
