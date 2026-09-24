import { describe, expect, it } from "vitest";
import {
  mapAnthropicUsage,
  parseAnthropicResponse,
} from "../../src/modules/providers/anthropic-usage.js";
import { mapOpenAiUsage, parseOpenAiResponse } from "../../src/modules/providers/openai-usage.js";

describe("OpenAI usage normalization", () => {
  it("normalizes prompt_tokens/completion_tokens/total_tokens", () => {
    const usage = mapOpenAiUsage({ prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 });
    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      source: "provider",
    });
  });

  it("marks usage as unknown (never 0) when the response has no usage object", () => {
    const usage = mapOpenAiUsage(undefined);
    expect(usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: "unknown",
    });
  });

  it("preserves the provider's total_tokens as-is even if inconsistent with prompt+completion", () => {
    // OpenAI is expected to be internally consistent, but this parser must
    // never silently "correct" what the provider actually reported.
    const usage = mapOpenAiUsage({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 999 });
    expect(usage.totalTokens).toBe(999);
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(10);
  });

  it("extracts the model from a full response body", () => {
    const body = Buffer.from(
      JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-4o-2024-08-06",
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      }),
    );
    const parsed = parseOpenAiResponse(body, "gpt-4o");
    expect(parsed.model).toBe("gpt-4o-2024-08-06");
    expect(parsed.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      source: "provider",
    });
  });

  it("falls back to the requested model when the response doesn't report one", () => {
    const body = Buffer.from(JSON.stringify({ id: "chatcmpl-1" }));
    const parsed = parseOpenAiResponse(body, "gpt-4o");
    expect(parsed.model).toBe("gpt-4o");
  });

  it("yields unknown usage for a response with no usage field", () => {
    const body = Buffer.from(JSON.stringify({ id: "chatcmpl-1", model: "gpt-4o" }));
    const parsed = parseOpenAiResponse(body, "gpt-4o");
    expect(parsed.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: "unknown",
    });
  });

  it("never throws on a malformed response body", () => {
    const body = Buffer.from("not json at all {{{");
    expect(() => parseOpenAiResponse(body, "gpt-4o")).not.toThrow();
    const parsed = parseOpenAiResponse(body, "gpt-4o");
    expect(parsed.usage.source).toBe("unknown");
    expect(parsed.model).toBe("gpt-4o");
  });
});

describe("Anthropic usage normalization", () => {
  it("normalizes input_tokens/output_tokens and computes totalTokens", () => {
    const usage = mapAnthropicUsage({ input_tokens: 20, output_tokens: 15 });
    expect(usage).toEqual({
      inputTokens: 20,
      outputTokens: 15,
      totalTokens: 35,
      source: "provider",
    });
  });

  it("marks usage as unknown (never 0) when the response has no usage object", () => {
    const usage = mapAnthropicUsage(undefined);
    expect(usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: "unknown",
    });
  });

  it("does not compute totalTokens when only input_tokens is known", () => {
    const usage = mapAnthropicUsage({ input_tokens: 20 });
    expect(usage.inputTokens).toBe(20);
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBeNull();
    expect(usage.source).toBe("provider");
  });

  it("does not compute totalTokens when only output_tokens is known", () => {
    const usage = mapAnthropicUsage({ output_tokens: 15 });
    expect(usage.outputTokens).toBe(15);
    expect(usage.inputTokens).toBeNull();
    expect(usage.totalTokens).toBeNull();
  });

  it("extracts the model from a full response body", () => {
    const body = Buffer.from(
      JSON.stringify({
        id: "msg_1",
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 8, output_tokens: 3 },
      }),
    );
    const parsed = parseAnthropicResponse(body, "claude-sonnet-4-5");
    expect(parsed.model).toBe("claude-sonnet-4-5-20250929");
    expect(parsed.usage).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
      source: "provider",
    });
  });

  it("falls back to the requested model when the response doesn't report one", () => {
    const body = Buffer.from(JSON.stringify({ id: "msg_1" }));
    const parsed = parseAnthropicResponse(body, "claude-sonnet-4-5");
    expect(parsed.model).toBe("claude-sonnet-4-5");
  });

  it("never throws on a malformed response body", () => {
    const body = Buffer.from("not json at all {{{");
    expect(() => parseAnthropicResponse(body, "claude-sonnet-4-5")).not.toThrow();
    const parsed = parseAnthropicResponse(body, "claude-sonnet-4-5");
    expect(parsed.usage.source).toBe("unknown");
  });
});
