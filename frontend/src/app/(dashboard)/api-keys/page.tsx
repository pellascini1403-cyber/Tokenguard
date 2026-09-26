import { requireServerSession } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/api/organizations";
import { resolveActiveOrganization } from "@/lib/organizations/resolve-active-organization";
import { AppScreen } from "@/components/dashboard/app-screen";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";
import { EmptyState } from "@/components/ui/empty-state";
import { CreateKeyForm } from "./create-key-form";
import { RevokeKeyForm } from "./revoke-key-form";

/**
 * POST .../keys and POST .../keys/:keyId/revoke are real, implemented
 * backend endpoints (backend/src/routes/v1/organization-keys.route.ts),
 * so this page wires them up for real — no mocked create/revoke flow.
 * What the backend does NOT have is a GET route to list an
 * organization's keys, so this page can only ever show a key it just
 * created in this session, and revocation requires the caller to already
 * know the key's id.
 */
export default async function ApiKeysPage() {
  const session = await requireServerSession();
  const organizations = await listOrganizations(session.accessToken);
  const activeOrganization = await resolveActiveOrganization(organizations);

  if (!activeOrganization) {
    return (
      <AppScreen header={<h1 className="text-xl font-semibold">API Keys</h1>}>
        <EmptyState
          title="No organization selected"
          description="Create an organization first to manage its API keys."
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen
      header={<h1 className="text-xl font-semibold">API Keys — {activeOrganization.name}</h1>}
    >
      <MissingBackendCapability
        title="No key-listing endpoint exists yet"
        explanation="The backend can create and revoke TokenGuard keys, but has no GET route to list an organization's existing keys. Because of this, a newly created key's plaintext secret and id are only ever shown once, right after creation, and revoking a key requires already knowing its id."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-900">Create a new key</h2>
        <CreateKeyForm organizationId={activeOrganization.id} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-900">Revoke a key by id</h2>
        <RevokeKeyForm organizationId={activeOrganization.id} />
      </section>
    </AppScreen>
  );
}
