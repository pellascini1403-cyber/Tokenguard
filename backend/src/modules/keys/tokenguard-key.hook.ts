import type { FastifyReply, FastifyRequest } from "fastify";
import { unauthorizedError } from "../../lib/errors.js";
import type { KeysService } from "./keys.service.js";

const HEADER_NAME = "x-tokenguard-key";

/**
 * Fastify preHandler hook that authenticates proxy traffic via
 * X-TokenGuard-Key, reusing keysService.verifyKey() from Step 2 rather
 * than duplicating credential-resolution logic. A missing header, an
 * invalid key, and a revoked key all produce the exact same generic 401 —
 * `keysService.verifyKey` already excludes revoked keys from its lookup,
 * so this hook never learns (and can never leak) whether a key existed.
 */
export function createRequireTokenGuardKeyHook(keysService: KeysService) {
  return async function requireTokenGuardKey(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const headerValue = request.headers[HEADER_NAME];
    const plaintext = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!plaintext) {
      throw unauthorizedError();
    }

    const context = await keysService.verifyKey(plaintext);
    if (!context) {
      throw unauthorizedError();
    }

    request.tokenGuardContext = context;
  };
}
