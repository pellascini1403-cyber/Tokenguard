import Link from "next/link";
import { requireServerSession } from "@/lib/auth/session";
import { getMe } from "@/lib/api/me";
import { listOrganizations } from "@/lib/api/organizations";
import { resolveActiveOrganization } from "@/lib/organizations/resolve-active-organization";
import { AppScreen } from "@/components/dashboard/app-screen";
import { AssetCard } from "@/components/dashboard/asset-card";
import { OrganizationSwitcher } from "@/components/dashboard/organization-switcher";

function greetingName(email: string | null): string {
  if (!email) {
    return "there";
  }
  const [local] = email.split("@");
  return local && local.length > 0 ? local : "there";
}

/**
 * The backend has no consolidated overview/summary endpoint (no
 * /v1/organizations/:id/overview, no dashboard-summary route — confirmed
 * by inspecting backend/src/routes/v1/index.ts, which registers only
 * me, organizations, organization-keys, and the AI proxy). The 5 cards
 * below show only what GET /v1/me and GET /v1/organizations actually
 * return, plus one real navigational action (Create API Key) — the
 * "Usage & Spend" card states the gap plainly rather than inventing a
 * number.
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
            <AssetCard src="/assets/overview/card-top-left.png" width={753} height={271}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Organization
              </p>
              <p className="mt-1 line-clamp-1 text-base font-semibold text-zinc-900">
                {activeOrganization?.name ?? "—"}
              </p>
            </AssetCard>

            <AssetCard src="/assets/overview/card-top-right.png" width={754} height={271}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Monthly Budget
              </p>
              <p className="mt-1 text-base font-semibold text-zinc-900">
                {activeOrganization ? `$${activeOrganization.monthlyBudgetUsd}` : "—"}
              </p>
            </AssetCard>

            <AssetCard src="/assets/overview/card-mid-left.png" width={753} height={270}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Account</p>
              <p className="mt-1 truncate text-sm font-semibold text-zinc-900">
                {user.email ?? user.id}
              </p>
            </AssetCard>

            <Link href="/api-keys" className="block">
              <AssetCard src="/assets/overview/card-mid-right.png" width={754} height={270}>
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  Quick action
                </p>
                <p className="mt-1 text-base font-semibold text-zinc-900">Create API key →</p>
              </AssetCard>
            </Link>
          </div>

          <AssetCard src="/assets/overview/card-large.png" width={1534} height={640}>
            <p className="text-xs font-medium uppercase tracking-wide text-amber-600">
              Usage &amp; spend
            </p>
            <p className="mt-2 max-w-sm text-sm text-zinc-600">
              The backend doesn&apos;t expose a usage/spend summary endpoint yet — the data exists
              internally (UsageService), but no route serves it. This card will show real numbers
              once it does.
            </p>
          </AssetCard>
        </div>
      }
    >
      <section>
        <h2 className="text-sm font-medium text-zinc-900">Your organizations</h2>
        <ul className="mt-2 divide-y divide-zinc-800 overflow-hidden rounded-lg bg-black">
          {organizations.map((org) => (
            <li key={org.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <span className="font-medium text-white">{org.name}</span>
              <span className="text-zinc-400">Monthly budget: ${org.monthlyBudgetUsd}</span>
            </li>
          ))}
        </ul>
      </section>
    </AppScreen>
  );
}
