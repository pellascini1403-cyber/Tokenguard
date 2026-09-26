import { AppScreen } from "@/components/dashboard/app-screen";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

/**
 * backend/src/modules/usage/usage.service.ts already has
 * getOrganizationLogs() and getOrganizationUsageSummary(), but no route
 * in backend/src/routes/v1/ exposes either one over HTTP — confirmed by
 * reading routes/v1/index.ts, which registers only me, organizations,
 * organization-keys, and the proxy. This page cannot honestly show usage
 * data until such a route exists.
 */
export default function UsagePage() {
  return (
    <AppScreen header={<h1 className="text-xl font-semibold">Usage</h1>}>
      <MissingBackendCapability
        title="No usage-read endpoint exists yet"
        explanation="The backend computes per-organization usage logs and summaries internally (UsageService), but has not exposed them over HTTP. Once a route such as GET /v1/organizations/:organizationId/usage exists, this page will list real usage data here."
      />
    </AppScreen>
  );
}
