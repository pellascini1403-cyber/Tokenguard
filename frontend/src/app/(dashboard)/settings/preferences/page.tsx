import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

export default function PreferencesSettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">Preferences</h1>
      <MissingBackendCapability
        title="No user-preferences endpoint exists yet"
        explanation="The backend has no concept of stored user preferences (notification settings, display options, etc.). This page is a structural placeholder reserving the route."
      />
    </div>
  );
}
