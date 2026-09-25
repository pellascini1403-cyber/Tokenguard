"use server";

import { requireServerSession } from "@/lib/auth/session";
import { createOrganization } from "@/lib/api/organizations";
import { TokenGuardApiError } from "@/types/api-error";
import type { CreateOrganizationActionState } from "@/lib/organizations/organization-action-state";

export async function createOrganizationAction(
  _prevState: CreateOrganizationActionState,
  formData: FormData,
): Promise<CreateOrganizationActionState> {
  const name = formData.get("name");
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "Organization name is required.", createdOrganizationId: null };
  }

  const session = await requireServerSession();

  try {
    const organization = await createOrganization(session.accessToken, name.trim());
    return { error: null, createdOrganizationId: organization.id };
  } catch (error) {
    if (error instanceof TokenGuardApiError) {
      return { error: error.message, createdOrganizationId: null };
    }
    return {
      error: "Could not reach the TokenGuard backend. Please try again.",
      createdOrganizationId: null,
    };
  }
}
