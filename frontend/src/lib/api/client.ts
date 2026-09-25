import { getPublicEnv } from "@/lib/env";
import { TokenGuardApiError, TokenGuardNetworkError, type ErrorResponseBody } from "@/types/api-error";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** The signed-in user's Supabase access token. Required for every
   * current backend route — there is no unauthenticated endpoint this
   * client calls. */
  accessToken: string;
}

function isErrorResponseBody(value: unknown): value is ErrorResponseBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "object"
  );
}

/**
 * The one place that talks to the TokenGuard backend over HTTP. Callers
 * pass a route path (e.g. "/v1/me") and the caller's access token; this
 * attaches it as `Authorization: Bearer <token>`, parses JSON, and
 * normalizes every failure — HTTP error response or network failure —
 * into a typed error.
 *
 * Deliberately called only from Server Components and Server Actions in
 * this app (see the frontend README's "Why no client-side backend
 * fetches" section): the backend has no CORS configuration, so a direct
 * browser fetch to it would be blocked. Calling it from the server avoids
 * that entirely, since CORS is a browser-only mechanism.
 *
 * Never logs the access token or request/response bodies — only the
 * path, method, and resulting status code are safe to log, and even that
 * is left to call sites that actually want it.
 */
export async function tokenGuardFetch<TResponse>(
  path: string,
  options: RequestOptions,
): Promise<TResponse> {
  const env = getPublicEnv();
  const url = `${env.tokenGuardApiUrl}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch (cause) {
    throw new TokenGuardNetworkError(cause);
  }

  let parsedBody: unknown = null;
  const rawText = await response.text();
  if (rawText.length > 0) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = null;
    }
  }

  if (!response.ok) {
    if (isErrorResponseBody(parsedBody)) {
      throw new TokenGuardApiError(
        parsedBody.error.code,
        response.status,
        parsedBody.error.message,
        parsedBody.error.retryAfterSeconds,
      );
    }
    throw new TokenGuardApiError(
      "REQUEST_ERROR",
      response.status,
      `The TokenGuard backend returned an unexpected ${response.status} response.`,
    );
  }

  return parsedBody as TResponse;
}
