import { describe, expect, it } from "vitest";
import { createOrganizationsService } from "../../src/modules/organizations/organizations.service.js";
import { createFakeAdminClient } from "../helpers/fake-admin-client.js";

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("organizations service", () => {
  it("lets an authenticated user create an organization", async () => {
    const { client } = createFakeAdminClient();
    const service = createOrganizationsService(client);

    const org = await service.createOrganization(USER_A, "Acme Inc");

    expect(org.name).toBe("Acme Inc");
    expect(org.id).toBeTruthy();
    expect(org.monthlyBudgetUsd).toBeTruthy();
  });

  it("makes the organization creator its owner", async () => {
    const { client } = createFakeAdminClient();
    const service = createOrganizationsService(client);

    const org = await service.createOrganization(USER_A, "Acme Inc");
    const membership = await service.requireRole(org.id, USER_A, ["owner", "member"]);

    expect(membership.role).toBe("owner");
  });

  it("lists only organizations the authenticated user belongs to", async () => {
    const { client } = createFakeAdminClient();
    const service = createOrganizationsService(client);

    const orgA = await service.createOrganization(USER_A, "Org A");
    await service.createOrganization(USER_B, "Org B");

    const orgsForUserA = await service.listOrganizationsForUser(USER_A);

    expect(orgsForUserA).toHaveLength(1);
    expect(orgsForUserA[0]?.id).toBe(orgA.id);
  });

  it("rejects a user that does not belong to another user's organization", async () => {
    const { client } = createFakeAdminClient();
    const service = createOrganizationsService(client);

    const org = await service.createOrganization(USER_A, "Org A");

    await expect(service.requireRole(org.id, USER_B, ["owner", "member"])).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });

  it("rejects an organization name that is empty", async () => {
    const { client } = createFakeAdminClient();
    const service = createOrganizationsService(client);

    await expect(service.createOrganization(USER_A, "   ")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
    });
  });
});
