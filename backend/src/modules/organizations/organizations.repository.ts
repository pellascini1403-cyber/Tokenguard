import type { SupabaseAppClient } from "../auth/supabase-client.js";
import type { Organization, OrganizationMembership, OrganizationRole } from "./types.js";

interface OrganizationRow {
  id: string;
  name: string;
  monthly_budget_usd: string;
  created_at: string;
  updated_at: string;
}

interface OrganizationMemberRow {
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
}

function mapOrganizationRow(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    monthlyBudgetUsd: row.monthly_budget_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMembershipRow(row: OrganizationMemberRow): OrganizationMembership {
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
  };
}

export interface OrganizationsRepository {
  createWithOwner(name: string, ownerUserId: string): Promise<Organization>;
  listForUser(userId: string): Promise<Organization[]>;
  findMembership(organizationId: string, userId: string): Promise<OrganizationMembership | null>;
}

/**
 * Organization creation and owner-membership creation happen atomically via
 * the `create_organization_with_owner` Postgres function (see
 * supabase/migrations), so a failure partway through never leaves an
 * ownerless organization or an orphaned membership row.
 */
export function createOrganizationsRepository(
  adminClient: SupabaseAppClient,
): OrganizationsRepository {
  return {
    async createWithOwner(name: string, ownerUserId: string): Promise<Organization> {
      // rpc() on the untyped Supabase client resolves to `any`; the
      // returned row is validated and cast to OrganizationRow below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await adminClient.rpc("create_organization_with_owner", {
        p_name: name,
        p_owner_user_id: ownerUserId,
      });

      if (error || !data) {
        throw new Error(`Failed to create organization: ${error?.message ?? "unknown error"}`);
      }

      return mapOrganizationRow(data as OrganizationRow);
    },

    async listForUser(userId: string): Promise<Organization[]> {
      const { data, error } = await adminClient
        .from("organization_members")
        .select("organizations(*)")
        .eq("user_id", userId);

      if (error) {
        throw new Error(`Failed to list organizations: ${error.message}`);
      }

      const rows = (data ?? []) as unknown as Array<{ organizations: OrganizationRow }>;
      return rows.map((row) => mapOrganizationRow(row.organizations));
    },

    async findMembership(
      organizationId: string,
      userId: string,
    ): Promise<OrganizationMembership | null> {
      const { data, error } = await adminClient
        .from("organization_members")
        .select("organization_id, user_id, role")
        .eq("organization_id", organizationId)
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        throw new Error(`Failed to look up organization membership: ${error.message}`);
      }
      if (!data) {
        return null;
      }

      return mapMembershipRow(data);
    },
  };
}
