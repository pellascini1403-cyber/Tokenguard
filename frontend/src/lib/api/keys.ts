import { tokenGuardFetch } from "@/lib/api/client";
import type { CreatedTokenGuardKey } from "@/types/tokenguard-key";

/**
 * Creates a TokenGuard API key for an organization. Requires the caller
 * to hold the "owner" role in that organization — enforced entirely by
 * the backend (a non-owner gets a 403 FORBIDDEN), never re-derived here.
 * The response's `apiKey` field is the plaintext secret, shown exactly
 * once — the backend has no way to retrieve it again afterward.
 */
export async function createTokenGuardKey(
  accessToken: string,
  organizationId: string,
  name: string,
): Promise<CreatedTokenGuardKey> {
  const { key } = await tokenGuardFetch<{ key: CreatedTokenGuardKey }>(
    `/v1/organizations/${organizationId}/keys`,
    { accessToken, method: "POST", body: { name } },
  );
  return key;
}

/**
 * Revokes a TokenGuard API key by id. There is currently no backend
 * endpoint to list an organization's keys (see the README), so the
 * caller must already know the key's id — typically from the creation
 * response earlier in the same session.
 */
export async function revokeTokenGuardKey(
  accessToken: string,
  organizationId: string,
  keyId: string,
): Promise<void> {
  await tokenGuardFetch<{ revoked: true }>(
    `/v1/organizations/${organizationId}/keys/${keyId}/revoke`,
    { accessToken, method: "POST" },
  );
}
