import { tokenGuardFetch } from "@/lib/api/client";
import type { Organization } from "@/types/organization";

export async function listOrganizations(accessToken: string): Promise<Organization[]> {
  const { organizations } = await tokenGuardFetch<{ organizations: Organization[] }>(
    "/v1/organizations",
    { accessToken },
  );
  return organizations;
}

export async function createOrganization(
  accessToken: string,
  name: string,
): Promise<Organization> {
  const { organization } = await tokenGuardFetch<{ organization: Organization }>(
    "/v1/organizations",
    { accessToken, method: "POST", body: { name } },
  );
  return organization;
}
