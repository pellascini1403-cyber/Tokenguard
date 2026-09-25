import { requireServerSession } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/api/organizations";
import { resolveActiveOrganization } from "@/lib/organizations/resolve-active-organization";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * There is no PATCH/PUT /v1/organizations/:organizationId route — only
 * POST (create) and GET (list) exist (confirmed against
 * backend/src/routes/v1/organizations.route.ts). This page can only
 * display the organization's current settings, not edit them.
 */
export default async function SettingsPage() {
  const session = await requireServerSession();
  const organizations = await listOrganizations(session.accessToken);
  const activeOrganization = await resolveActiveOrganization(organizations);

  if (!activeOrganization) {
    return <EmptyState title="No organization selected" description="Create an organization first." />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">Settings — {activeOrganization.name}</h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-zinc-500">Name</dt>
        <dd className="text-zinc-900">{activeOrganization.name}</dd>
        <dt className="text-zinc-500">Monthly budget</dt>
        <dd className="text-zinc-900">${activeOrganization.monthlyBudgetUsd}</dd>
        <dt className="text-zinc-500">Created</dt>
        <dd className="text-zinc-900">{activeOrganization.createdAt}</dd>
      </dl>
      <MissingBackendCapability
        title="No organization-settings-edit endpoint exists yet"
        explanation="The backend only supports creating and listing organizations, not updating one — there is no PATCH or PUT route. This page will gain an edit form once such an endpoint exists."
      />
    </div>
  );
}
