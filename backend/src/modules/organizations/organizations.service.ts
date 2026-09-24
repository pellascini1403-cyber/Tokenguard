import { badRequestError, forbiddenError } from "../../lib/errors.js";
import type { SupabaseAppClient } from "../auth/supabase-client.js";
import { createOrganizationsRepository } from "./organizations.repository.js";
import type { Organization, OrganizationMembership, OrganizationRole } from "./types.js";

const MAX_NAME_LENGTH = 200;

export interface OrganizationsService {
  createOrganization(ownerUserId: string, name: string): Promise<Organization>;
  listOrganizationsForUser(userId: string): Promise<Organization[]>;
  /**
   * Resolves the caller's membership in an organization and asserts it has
   * one of the allowed roles. Throws FORBIDDEN in both the "not a member"
   * and "insufficient role" cases so callers never learn whether an
   * organization they cannot access exists.
   */
  requireRole(
    organizationId: string,
    userId: string,
    allowedRoles: OrganizationRole[],
  ): Promise<OrganizationMembership>;
}

export function createOrganizationsService(adminClient: SupabaseAppClient): OrganizationsService {
  const repository = createOrganizationsRepository(adminClient);

  return {
    async createOrganization(ownerUserId: string, name: string): Promise<Organization> {
      const trimmedName = name.trim();
      if (trimmedName.length === 0 || trimmedName.length > MAX_NAME_LENGTH) {
        throw badRequestError(
          `Organization name must be between 1 and ${MAX_NAME_LENGTH} characters`,
        );
      }
      return repository.createWithOwner(trimmedName, ownerUserId);
    },

    async listOrganizationsForUser(userId: string): Promise<Organization[]> {
      return repository.listForUser(userId);
    },

    async requireRole(
      organizationId: string,
      userId: string,
      allowedRoles: OrganizationRole[],
    ): Promise<OrganizationMembership> {
      const membership = await repository.findMembership(organizationId, userId);
      if (!membership || !allowedRoles.includes(membership.role)) {
        throw forbiddenError("You do not have access to this organization");
      }
      return membership;
    },
  };
}
