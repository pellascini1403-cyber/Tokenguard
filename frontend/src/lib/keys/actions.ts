"use server";

import { requireServerSession } from "@/lib/auth/session";
import { createTokenGuardKey, revokeTokenGuardKey } from "@/lib/api/keys";
import { TokenGuardApiError } from "@/types/api-error";
import type { CreateKeyActionState, RevokeKeyActionState } from "@/lib/keys/key-action-state";

export async function createKeyAction(
  _prevState: CreateKeyActionState,
  formData: FormData,
): Promise<CreateKeyActionState> {
  const organizationId = formData.get("organizationId");
  const name = formData.get("name");
  if (typeof organizationId !== "string" || organizationId.length === 0) {
    return { error: "No active organization selected.", createdKey: null };
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "Key name is required.", createdKey: null };
  }

  const session = await requireServerSession();

  try {
    const key = await createTokenGuardKey(session.accessToken, organizationId, name.trim());
    return {
      error: null,
      createdKey: { id: key.id, prefix: key.prefix, apiKey: key.apiKey },
    };
  } catch (error) {
    if (error instanceof TokenGuardApiError) {
      return { error: error.message, createdKey: null };
    }
    return { error: "Could not reach the TokenGuard backend. Please try again.", createdKey: null };
  }
}

export async function revokeKeyAction(
  _prevState: RevokeKeyActionState,
  formData: FormData,
): Promise<RevokeKeyActionState> {
  const organizationId = formData.get("organizationId");
  const keyId = formData.get("keyId");
  if (typeof organizationId !== "string" || organizationId.length === 0) {
    return { error: "No active organization selected.", success: false };
  }
  if (typeof keyId !== "string" || keyId.trim().length === 0) {
    return { error: "Key id is required.", success: false };
  }

  const session = await requireServerSession();

  try {
    await revokeTokenGuardKey(session.accessToken, organizationId, keyId.trim());
    return { error: null, success: true };
  } catch (error) {
    if (error instanceof TokenGuardApiError) {
      return { error: error.message, success: false };
    }
    return { error: "Could not reach the TokenGuard backend. Please try again.", success: false };
  }
}
