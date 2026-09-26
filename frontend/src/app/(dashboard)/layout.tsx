import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requireServerSession } from "@/lib/auth/session";
import { getMe } from "@/lib/api/me";
import { listOrganizations } from "@/lib/api/organizations";
import { getActiveOrganizationId } from "@/lib/organizations/active-organization";
import { OrganizationProvider } from "@/lib/organizations/context";
import { AppNavigation } from "@/components/dashboard/app-navigation";

/**
 * The authenticated app shell. proxy.ts already redirects unauthenticated
 * requests before this runs, but per Next.js's own Server Actions
 * security guidance ("verify authentication inside each Server Function
 * rather than relying on Proxy alone"), every Server Component under
 * this layout that can mutate or read organization-scoped data
 * re-verifies the session itself (see lib/auth/session.ts).
 *
 * Visual shell: a fixed bottom tab bar built from 5 provided PNG assets
 * (see components/dashboard/app-navigation.tsx) replaces the earlier
 * desktop sidebar — each page supplies its own black-header/white-body
 * zones via AppScreen.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireServerSession();
  const [user, organizations, activeOrganizationId] = await Promise.all([
    getMe(session.accessToken),
    listOrganizations(session.accessToken),
    getActiveOrganizationId(),
  ]);

  if (organizations.length === 0) {
    redirect("/onboarding");
  }

  return (
    <OrganizationProvider organizations={organizations} activeOrganizationId={activeOrganizationId}>
      <div className="min-h-dvh bg-white pb-24">{children}</div>
      <AppNavigation userEmail={user.email} />
    </OrganizationProvider>
  );
}
