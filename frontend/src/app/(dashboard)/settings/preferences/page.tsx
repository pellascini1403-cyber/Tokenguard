import { AppScreen } from "@/components/dashboard/app-screen";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

export default function PreferencesSettingsPage() {
  return (
    <AppScreen header={<h1 className="text-xl font-semibold">Preferences</h1>}>
      <MissingBackendCapability
        title="No user-preferences endpoint exists yet"
        explanation="The backend has no concept of stored user preferences (notification settings, display options, etc.). This page is a structural placeholder reserving the route."
      />
    </AppScreen>
  );
}
