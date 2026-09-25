import type { Organization } from "@/types/organization";
import { getActiveOrganizationId } from "@/lib/organizations/active-organization";

/**
 * Resolves which organization a Server Component should treat as
 * "active," given the full list already fetched for this user. This is
 * the same fallback rule the client-side OrganizationProvider uses
 * (active-org cookie, else the first organization) — kept in one place
 * so a page can't drift from what the switcher shows. Purely a UI
 * convenience; never an authorization decision (see
 * active-organization.ts).
 */
export async function resolveActiveOrganization(
  organizations: Organization[],
): Promise<Organization | null> {
  const activeId = await getActiveOrganizationId();
  return organizations.find((org) => org.id === activeId) ?? organizations[0] ?? null;
}
