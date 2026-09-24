export type OrganizationRole = "owner" | "member";

export interface Organization {
  id: string;
  name: string;
  monthlyBudgetUsd: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}
