import { badRequestError } from "../../lib/errors.js";
import { getClientHeader } from "./client-headers.js";
import type {
  ProviderAdapter,
  ProviderForwardInput,
  ProviderForwardResult,
  ProviderStreamForwardResult,
} from "./types.js";

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/**
 * Forwards to OpenAI's Chat Completions API. The client's own OpenAI key
 * (Authorization: Bearer ...) is read fresh from each request and used
 * only for the single upstream call — never stored, logged, or echoed
 * back.
 */
export function createOpenAiAdapter(baseUrl: string): ProviderAdapter {
  function buildHeaders(
    clientHeaders: ProviderForwardInput["clientHeaders"],
  ): Record<string, string> {
    const authorization = getClientHeader(clientHeaders, "authorization");
    if (!authorization) {
      throw badRequestError("Missing Authorization header for OpenAI");
    }
    return { authorization, "content-type": "application/json" };
  }

  return {
    provider: "openai",

    async forward(input: ProviderForwardInput): Promise<ProviderForwardResult> {
      const response = await fetch(new URL(CHAT_COMPLETIONS_PATH, baseUrl), {
        method: "POST",
        headers: buildHeaders(input.clientHeaders),
        body: input.body,
        signal: input.signal,
      });

      const body = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        body,
        contentType: response.headers.get("content-type"),
      };
    },

    async forwardStream(input: ProviderForwardInput): Promise<ProviderStreamForwardResult> {
      const response = await fetch(new URL(CHAT_COMPLETIONS_PATH, baseUrl), {
        method: "POST",
        headers: buildHeaders(input.clientHeaders),
        body: input.body,
        signal: input.signal,
      });

      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: response.body,
      };
    },
  };
}
