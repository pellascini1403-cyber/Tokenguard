import { badRequestError } from "../../lib/errors.js";
import { getClientHeader } from "./client-headers.js";
import type {
  ProviderAdapter,
  ProviderForwardInput,
  ProviderForwardResult,
  ProviderStreamForwardResult,
} from "./types.js";

const MESSAGES_PATH = "/v1/messages";

/**
 * Forwards to Anthropic's Messages API. The client's own Anthropic key
 * (x-api-key) is read fresh from each request and used only for the
 * single upstream call — never stored, logged, or echoed back.
 * anthropic-version is forwarded when the client provides it; TokenGuard
 * never invents or defaults a version on the client's behalf.
 */
export function createAnthropicAdapter(baseUrl: string): ProviderAdapter {
  function buildHeaders(
    clientHeaders: ProviderForwardInput["clientHeaders"],
  ): Record<string, string> {
    const apiKey = getClientHeader(clientHeaders, "x-api-key");
    if (!apiKey) {
      throw badRequestError("Missing x-api-key header for Anthropic");
    }
    const headers: Record<string, string> = {
      "x-api-key": apiKey,
      "content-type": "application/json",
    };
    const anthropicVersion = getClientHeader(clientHeaders, "anthropic-version");
    if (anthropicVersion) {
      headers["anthropic-version"] = anthropicVersion;
    }
    return headers;
  }

  return {
    provider: "anthropic",

    async forward(input: ProviderForwardInput): Promise<ProviderForwardResult> {
      const response = await fetch(new URL(MESSAGES_PATH, baseUrl), {
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
      const response = await fetch(new URL(MESSAGES_PATH, baseUrl), {
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
