import { describe, expect, it } from "vitest";
import { computeRequestSignature } from "../../src/modules/loop-detection/request-signature.js";
import type { RequestSignatureInput } from "../../src/modules/loop-detection/types.js";

const BASE: RequestSignatureInput = {
  organizationId: "org-a",
  tokenGuardKeyId: "key-a",
  provider: "openai",
  endpoint: "/v1/chat/completions",
  model: "gpt-4o",
  parsedBody: { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] },
};

describe("computeRequestSignature", () => {
  it("produces a 64-character hex SHA-256 digest", () => {
    const signature = computeRequestSignature(BASE);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same effective input", () => {
    const a = computeRequestSignature(BASE);
    const b = computeRequestSignature({
      ...BASE,
      parsedBody: { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] },
    });
    expect(a).toBe(b);
  });

  it("produces the same signature for the same effective JSON with different key ordering", () => {
    const a = computeRequestSignature({
      ...BASE,
      parsedBody: { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] },
    });
    const b = computeRequestSignature({
      ...BASE,
      parsedBody: { messages: [{ content: "hello", role: "user" }], model: "gpt-4o" },
    });
    expect(a).toBe(b);
  });

  it("produces a different signature for different meaningful values (not just same model/endpoint)", () => {
    const a = computeRequestSignature({
      ...BASE,
      parsedBody: { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] },
    });
    const b = computeRequestSignature({
      ...BASE,
      parsedBody: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "what is the weather?" }],
      },
    });
    expect(a).not.toBe(b);
  });

  it("produces a different signature for different organizations", () => {
    const a = computeRequestSignature(BASE);
    const b = computeRequestSignature({ ...BASE, organizationId: "org-b" });
    expect(a).not.toBe(b);
  });

  it("produces a different signature for different TokenGuard keys", () => {
    const a = computeRequestSignature(BASE);
    const b = computeRequestSignature({ ...BASE, tokenGuardKeyId: "key-b" });
    expect(a).not.toBe(b);
  });

  it("produces a different signature for different providers", () => {
    const a = computeRequestSignature(BASE);
    const b = computeRequestSignature({ ...BASE, provider: "anthropic" });
    expect(a).not.toBe(b);
  });

  it("produces a different signature for different endpoints", () => {
    const a = computeRequestSignature(BASE);
    const b = computeRequestSignature({ ...BASE, endpoint: "/v1/messages" });
    expect(a).not.toBe(b);
  });

  it("produces a different signature for different models", () => {
    const a = computeRequestSignature(BASE);
    const b = computeRequestSignature({ ...BASE, model: "gpt-3.5-turbo" });
    expect(a).not.toBe(b);
  });

  it("preserves array ordering — reordered array elements produce a different signature", () => {
    const a = computeRequestSignature({
      ...BASE,
      parsedBody: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      },
    });
    const b = computeRequestSignature({
      ...BASE,
      parsedBody: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "second" },
          { role: "user", content: "first" },
        ],
      },
    });
    expect(a).not.toBe(b);
  });

  it("does not mutate the original parsed body", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      nested: { z: 1, a: 2 },
    };
    const snapshot: unknown = JSON.parse(JSON.stringify(body));

    computeRequestSignature({ ...BASE, parsedBody: body });

    expect(body).toEqual(snapshot);
  });

  it("never includes the raw body text in its output", () => {
    const secretMarker = "MARKER-SHOULD-NEVER-APPEAR-IN-HASH";
    const signature = computeRequestSignature({
      ...BASE,
      parsedBody: { model: "gpt-4o", messages: [{ role: "user", content: secretMarker }] },
    });
    expect(signature).not.toContain(secretMarker);
  });

  it("treats null model and a present model differently", () => {
    const a = computeRequestSignature({ ...BASE, model: null });
    const b = computeRequestSignature({ ...BASE, model: "gpt-4o" });
    expect(a).not.toBe(b);
  });
});
