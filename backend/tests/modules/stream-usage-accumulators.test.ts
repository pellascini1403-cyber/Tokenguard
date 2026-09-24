import { describe, expect, it } from "vitest";
import { createOpenAiStreamUsageAccumulator } from "../../src/modules/providers/openai-usage.js";
import { createAnthropicStreamUsageAccumulator } from "../../src/modules/providers/anthropic-usage.js";
import type { SseEvent } from "../../src/modules/streaming/types.js";

function dataEvent(data: string): SseEvent {
  return { event: null, data, id: null };
}

describe("createOpenAiStreamUsageAccumulator", () => {
  it("captures the model from the first chunk that carries one", () => {
    const accumulator = createOpenAiStreamUsageAccumulator(null);
    accumulator.handleEvent(dataEvent(JSON.stringify({ model: "gpt-4o-mini", choices: [] })));
    accumulator.handleEvent(dataEvent("[DONE]"));

    expect(accumulator.finalize()).toEqual({
      model: "gpt-4o-mini",
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" },
    });
  });

  it("captures usage only from a chunk that carries a top-level usage field", () => {
    const accumulator = createOpenAiStreamUsageAccumulator(null);
    accumulator.handleEvent(dataEvent(JSON.stringify({ model: "gpt-4o", choices: [] })));
    accumulator.handleEvent(
      dataEvent(
        JSON.stringify({
          model: "gpt-4o",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      ),
    );
    accumulator.handleEvent(dataEvent("[DONE]"));

    expect(accumulator.finalize()).toEqual({
      model: "gpt-4o",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" },
    });
  });

  it("falls back to the requested model and unknown usage when the stream never includes usage", () => {
    const accumulator = createOpenAiStreamUsageAccumulator("gpt-3.5-turbo");
    accumulator.handleEvent(dataEvent(JSON.stringify({ choices: [{ delta: { content: "hi" } }] })));
    accumulator.handleEvent(dataEvent("[DONE]"));

    expect(accumulator.finalize()).toEqual({
      model: "gpt-3.5-turbo",
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" },
    });
  });

  it("tolerates malformed chunks without throwing", () => {
    const accumulator = createOpenAiStreamUsageAccumulator(null);
    expect(() => accumulator.handleEvent(dataEvent("not json"))).not.toThrow();
    expect(() => accumulator.handleEvent(dataEvent(""))).not.toThrow();
    expect(() => accumulator.handleEvent(dataEvent("null"))).not.toThrow();
    expect(() => accumulator.handleEvent(dataEvent("42"))).not.toThrow();

    expect(accumulator.finalize()).toEqual({
      model: null,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" },
    });
  });

  it("keeps the first model seen even if a later chunk also carries one", () => {
    const accumulator = createOpenAiStreamUsageAccumulator(null);
    accumulator.handleEvent(dataEvent(JSON.stringify({ model: "gpt-4o" })));
    accumulator.handleEvent(dataEvent(JSON.stringify({ model: "gpt-4o-mini" })));

    expect(accumulator.finalize().model).toBe("gpt-4o");
  });
});

describe("createAnthropicStreamUsageAccumulator", () => {
  it("captures initial usage and model from message_start", () => {
    const accumulator = createAnthropicStreamUsageAccumulator(null);
    accumulator.handleEvent(
      dataEvent(
        JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-3-5-sonnet",
            usage: { input_tokens: 20, output_tokens: 1 },
          },
        }),
      ),
    );

    expect(accumulator.finalize()).toEqual({
      model: "claude-3-5-sonnet",
      usage: { inputTokens: 20, outputTokens: 1, totalTokens: 21, source: "provider" },
    });
  });

  it("overwrites output tokens with each message_delta, keeping the final cumulative count", () => {
    const accumulator = createAnthropicStreamUsageAccumulator(null);
    accumulator.handleEvent(
      dataEvent(
        JSON.stringify({
          type: "message_start",
          message: { model: "claude-3-opus", usage: { input_tokens: 12, output_tokens: 1 } },
        }),
      ),
    );
    accumulator.handleEvent(
      dataEvent(JSON.stringify({ type: "message_delta", usage: { output_tokens: 8 } })),
    );
    accumulator.handleEvent(
      dataEvent(JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 } })),
    );

    expect(accumulator.finalize()).toEqual({
      model: "claude-3-opus",
      usage: { inputTokens: 12, outputTokens: 30, totalTokens: 42, source: "provider" },
    });
  });

  it("falls back to the requested model and unknown usage when no usage-bearing event arrives", () => {
    const accumulator = createAnthropicStreamUsageAccumulator("claude-3-haiku");
    accumulator.handleEvent(
      dataEvent(JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })),
    );
    accumulator.handleEvent(dataEvent(JSON.stringify({ type: "message_stop" })));

    expect(accumulator.finalize()).toEqual({
      model: "claude-3-haiku",
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" },
    });
  });

  it("tolerates malformed and unrelated events without throwing", () => {
    const accumulator = createAnthropicStreamUsageAccumulator(null);
    expect(() => accumulator.handleEvent(dataEvent("not json"))).not.toThrow();
    expect(() => accumulator.handleEvent(dataEvent(""))).not.toThrow();
    expect(() =>
      accumulator.handleEvent(dataEvent(JSON.stringify({ type: "ping" }))),
    ).not.toThrow();
    expect(() =>
      accumulator.handleEvent(dataEvent(JSON.stringify({ type: "message_start" }))),
    ).not.toThrow();

    expect(accumulator.finalize()).toEqual({
      model: null,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" },
    });
  });

  it("updates input tokens if a later message_delta reports them (defensive, even though Anthropic normally omits it)", () => {
    const accumulator = createAnthropicStreamUsageAccumulator(null);
    accumulator.handleEvent(
      dataEvent(
        JSON.stringify({
          type: "message_start",
          message: { model: "claude-3-5-sonnet", usage: { input_tokens: 5, output_tokens: 0 } },
        }),
      ),
    );
    accumulator.handleEvent(
      dataEvent(
        JSON.stringify({ type: "message_delta", usage: { input_tokens: 7, output_tokens: 3 } }),
      ),
    );

    expect(accumulator.finalize()).toEqual({
      model: "claude-3-5-sonnet",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, source: "provider" },
    });
  });
});
