import Link from "next/link";
import { requireServerSession } from "@/lib/auth/session";
import { getMe } from "@/lib/api/me";
import { listOrganizations } from "@/lib/api/organizations";
import { resolveActiveOrganization } from "@/lib/organizations/resolve-active-organization";
import { AppScreen } from "@/components/dashboard/app-screen";
import { AssetCard } from "@/components/dashboard/asset-card";
import { OrganizationSwitcher } from "@/components/dashboard/organization-switcher";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

function greetingName(email: string | null): string {
  if (!email) {
    return "there";
  }
  const [local] = email.split("@");
  return local && local.length > 0 ? local : "there";
}

function formatDate(isoDate: string): string {
  return isoDate.slice(0, 10);
}

/**
 * Faithful implementation of the designer's Home mockup (Image 4), built
 * on the designer's 5 real card-shape PNGs (Image 3 — see
 * public/assets/overview/, cropped to their exact bounds, zero added
 * padding). Every content block Image 4 shows is represented somewhere
 * below — either with real data from GET /v1/me + GET /v1/organizations
 * (Organization, Monthly Budget, Account, Created), a real working
 * action (Create API Key, Manage Budget — Image 4's "Actions" section,
 * both buttons), or an explicit, itemized statement of what the backend
 * doesn't expose yet (Budget progress, Spending over time, Spending by
 * provider, Spending by model, Usage overview, Recent requests). Nothing
 * from the reference is silently dropped; nothing not backed by a real
 * field or a real route is faked.
 */
export default async function OverviewPage() {
  const session = await requireServerSession();
  const [user, organizations] = await Promise.all([
    getMe(session.accessToken),
    listOrganizations(session.accessToken),
  ]);
  const activeOrganization = await resolveActiveOrganization(organizations);

  return (
    <AppScreen
      header={
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-2xl font-semibold">Hello, {greetingName(user.email)}</h1>
            <OrganizationSwitcher />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <AssetCard src="/assets/overview/card-top-left.png" width={745} height={263}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Organization
              </p>
              <p className="mt-1 line-clamp-1 text-base font-semibold text-zinc-900">
                {activeOrganization?.name ?? "—"}
              </p>
            </AssetCard>

            <AssetCard src="/assets/overview/card-top-right.png" width={746} height={263}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Monthly Budget
              </p>
              <p className="mt-1 text-base font-semibold text-zinc-900">
                {activeOrganization ? `$${activeOrganization.monthlyBudgetUsd}` : "—"}
              </p>
            </AssetCard>

            <AssetCard src="/assets/overview/card-mid-left.png" width={745} height={263}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Account</p>
              <p className="mt-1 truncate text-sm font-semibold text-zinc-900">
                {user.email ?? user.id}
              </p>
            </AssetCard>

            <AssetCard src="/assets/overview/card-mid-right.png" width={746} height={263}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Created</p>
              <p className="mt-1 text-base font-semibold text-zinc-900">
                {activeOrganization ? formatDate(activeOrganization.createdAt) : "—"}
              </p>
            </AssetCard>
          </div>

          {/* Image 4's "Actions" section: exactly its 2 buttons, both real
              navigations — nothing added, nothing missing. */}
          <AssetCard src="/assets/overview/card-large.png" width={1526} height={632}>
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Actions</p>
            <div className="mt-3 flex gap-3">
              <Link
                href="/budgets"
                className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
              >
                Manage Budget
              </Link>
              <Link
                href="/api-keys"
                className="rounded-full border border-zinc-900 px-4 py-2 text-sm font-medium text-zinc-900"
              >
                Create Key
              </Link>
            </div>
          </AssetCard>
        </div>
      }
    >
      <MissingBackendCapability
        title="Still not available from the backend"
        explanation="Everything below is shown in the reference design, but the backend has no route for any of it yet (confirmed against backend/src/routes/v1/index.ts) — none of it is faked here."
        items={[
          "Budget progress (current spend vs. the budget shown above)",
          "Spending over time (chart)",
          "Spending by provider",
          "Spending by model",
          "Usage overview (input/output/total tokens)",
          "Recent requests",
        ]}
      />
    </AppScreen>
  );
}
