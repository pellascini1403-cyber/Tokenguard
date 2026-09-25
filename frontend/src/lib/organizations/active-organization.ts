"use server";

import { cookies } from "next/headers";

/**
 * The "active organization" is a pure UI convenience — which organization
 * the dashboard shell currently displays — never an authorization
 * decision. Every API call that mutates or reads organization-scoped data
 * still sends an explicit organizationId, and the backend independently
 * re-verifies the caller's membership/role in it (see
 * organizations.service.ts's requireRole()) on every request. If this
 * cookie were tampered with to name an organization the user does not
 * belong to, the backend would simply reject the request with 403
 * FORBIDDEN — it is never trusted as proof of access.
 */
const ACTIVE_ORG_COOKIE = "tg_active_org_id";

export async function getActiveOrganizationId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;
}

export async function setActiveOrganizationAction(formData: FormData): Promise<void> {
  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || organizationId.length === 0) {
    return;
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
