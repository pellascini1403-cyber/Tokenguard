import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /health", () => {
  it("returns HTTP 200", async () => {
    const app = buildApp({ nodeEnv: "test" });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("returns the expected JSON structure", async () => {
    const app = buildApp({ nodeEnv: "test" });
    const response = await app.inject({ method: "GET", url: "/health" });
    const body: unknown = response.json();
    expect(body).toMatchObject({
      status: "ok",
      service: "tokenguard-proxy",
    });
    expect(body).toHaveProperty("version");
    await app.close();
  });
});

describe("buildApp", () => {
  it("can be instantiated without opening a network port", async () => {
    const app = buildApp({ nodeEnv: "test" });
    expect(app.server.listening).toBe(false);
    await app.close();
  });
});
