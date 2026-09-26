import { AppScreen } from "@/components/dashboard/app-screen";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

/**
 * organizations.repository has membership rows (owner/member), and
 * organizations.service.ts's requireRole() reads them, but nothing
 * exposes a member list, invites, or role changes over HTTP.
 */
export default function MembersPage() {
  return (
    <AppScreen header={<h1 className="text-xl font-semibold">Members</h1>}>
      <MissingBackendCapability
        title="No member-management endpoint exists yet"
        explanation="Organization membership and roles exist in the database and are enforced server-side (OrganizationsService.requireRole), but there is no route to list members, invite someone, or change a role."
      />
    </AppScreen>
  );
}
