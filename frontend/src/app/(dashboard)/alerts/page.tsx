import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

/**
 * There is no alerts concept anywhere in the backend yet — no table, no
 * service, no route. This placeholder exists only to reserve the route,
 * per Step 10's structural-only scope.
 */
export default function AlertsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">Alerts</h1>
      <MissingBackendCapability
        title="Alerts are not implemented in the backend yet"
        explanation="There is no alerts table, service, or route in the backend today. This page is a structural placeholder reserving the route for a later step."
      />
    </div>
  );
}
