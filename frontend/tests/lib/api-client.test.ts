import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenGuardFetch } from "@/lib/api/client";
import { TokenGuardApiError, TokenGuardNetworkError } from "@/types/api-error";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("tokenGuardFetch", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("NEXT_PUBLIC_TOKENGUARD_API_URL", "http://localhost:3000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("attaches the Bearer token and returns the parsed body on success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { id: "user-1", email: "a@b.com" }));

    const result = await tokenGuardFetch<{ id: string; email: string }>("/v1/me", {
      accessToken: "token-abc",
    });

    expect(result).toEqual({ id: "user-1", email: "a@b.com" });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/me");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
  });

  it("throws TokenGuardApiError with the backend's code and message on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(403, { error: { code: "FORBIDDEN", message: "You do not have access." } }),
    );

    await expect(
      tokenGuardFetch("/v1/organizations/org-1/keys", { accessToken: "t", method: "POST" }),
    ).rejects.toMatchObject({
      name: "TokenGuardApiError",
      code: "FORBIDDEN",
      statusCode: 403,
      message: "You do not have access.",
    });
  });

  it("carries retryAfterSeconds through for a 429 loop-detection response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(429, {
        error: { code: "AGENT_LOOP_DETECTED", message: "Blocked.", retryAfterSeconds: 30 },
      }),
    );

    try {
      await tokenGuardFetch("/v1/chat/completions", { accessToken: "t", method: "POST" });
      expect.unreachable("expected tokenGuardFetch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenGuardApiError);
      expect((error as TokenGuardApiError).retryAfterSeconds).toBe(30);
    }
  });

  it("wraps a network failure in TokenGuardNetworkError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(tokenGuardFetch("/v1/me", { accessToken: "t" })).rejects.toBeInstanceOf(
      TokenGuardNetworkError,
    );
  });

  it("falls back to a generic REQUEST_ERROR when a non-2xx response has no parseable error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));

    await expect(tokenGuardFetch("/v1/me", { accessToken: "t" })).rejects.toMatchObject({
      code: "REQUEST_ERROR",
      statusCode: 500,
    });
  });
});
