import { requireServerSession } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/api/organizations";
import { resolveActiveOrganization } from "@/lib/organizations/resolve-active-organization";
import { AppScreen } from "@/components/dashboard/app-screen";
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
    return (
      <AppScreen header={<h1 className="text-xl font-semibold">Settings</h1>}>
        <EmptyState title="No organization selected" description="Create an organization first." />
      </AppScreen>
    );
  }

  return (
    <AppScreen header={<h1 className="text-xl font-semibold">Settings — {activeOrganization.name}</h1>}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 rounded-lg bg-black px-4 py-4 text-sm">
        <dt className="text-zinc-400">Name</dt>
        <dd className="text-white">{activeOrganization.name}</dd>
        <dt className="text-zinc-400">Monthly budget</dt>
        <dd className="text-white">${activeOrganization.monthlyBudgetUsd}</dd>
        <dt className="text-zinc-400">Created</dt>
        <dd className="text-white">{activeOrganization.createdAt}</dd>
      </dl>
      <MissingBackendCapability
        title="No organization-settings-edit endpoint exists yet"
        explanation="The backend only supports creating and listing organizations, not updating one — there is no PATCH or PUT route. This page will gain an edit form once such an endpoint exists."
      />
    </AppScreen>
  );
}
