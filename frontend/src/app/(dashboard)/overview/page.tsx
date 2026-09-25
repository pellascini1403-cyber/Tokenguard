import { requireServerSession } from "@/lib/auth/session";
import { getMe } from "@/lib/api/me";
import { listOrganizations } from "@/lib/api/organizations";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

/**
 * The backend has no consolidated overview/summary endpoint (no
 * /v1/organizations/:id/overview, no dashboard-summary route — confirmed
 * by inspecting backend/src/routes/v1/index.ts, which registers only
 * me, organizations, organization-keys, and the AI proxy). This page
 * only renders what GET /v1/me and GET /v1/organizations actually
 * return, and says plainly that usage/spend/request-volume summaries
 * aren't available yet — it never fabricates numbers to fill the gap.
 */
export default async function OverviewPage() {
  const session = await requireServerSession();
  const [user, organizations] = await Promise.all([
    getMe(session.accessToken),
    listOrganizations(session.accessToken),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Overview</h1>
        <p className="text-sm text-zinc-600">Signed in as {user.email ?? user.id}</p>
      </div>

      <section>
        <h2 className="text-sm font-medium text-zinc-900">Organizations</h2>
        <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200">
          {organizations.map((org) => (
            <li key={org.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <span className="font-medium text-zinc-900">{org.name}</span>
              <span className="text-zinc-500">Monthly budget: ${org.monthlyBudgetUsd}</span>
            </li>
          ))}
        </ul>
      </section>

      <MissingBackendCapability
        title="Usage, spend, and request-volume summaries aren't available yet"
        explanation="The backend does not currently expose a consolidated overview endpoint, nor an HTTP route for the usage summary it already computes internally (UsageService.getOrganizationUsageSummary exists but is not wired to any route). This section will show real metrics once that endpoint exists — see the frontend README for details."
      />
    </div>
  );
}
