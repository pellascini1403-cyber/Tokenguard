import { badRequestError } from "../../lib/errors.js";
import { getClientHeader } from "./client-headers.js";
import type { ProviderAdapter, ProviderForwardInput, ProviderForwardResult } from "./types.js";

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/**
 * Forwards to OpenAI's Chat Completions API. The client's own OpenAI key
 * (Authorization: Bearer ...) is read fresh from each request and used
 * only for the single upstream call — never stored, logged, or echoed
 * back.
 */
export function createOpenAiAdapter(baseUrl: string): ProviderAdapter {
  return {
    provider: "openai",

    async forward(input: ProviderForwardInput): Promise<ProviderForwardResult> {
      const authorization = getClientHeader(input.clientHeaders, "authorization");
      if (!authorization) {
        throw badRequestError("Missing Authorization header for OpenAI");
      }

      const upstreamUrl = new URL(CHAT_COMPLETIONS_PATH, baseUrl);
      const response = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
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
  };
}
