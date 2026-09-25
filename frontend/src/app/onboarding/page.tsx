import { redirect } from "next/navigation";
import { requireServerSession } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/api/organizations";
import { CreateOrganizationForm } from "./create-organization-form";

/**
 * LIMITATION (documented per Step 10's spec, not worked around): the
 * backend has no explicit "onboarding complete" flag. This page infers
 * completion from "the user belongs to at least one organization" —
 * that is a heuristic, not authoritative backend state. A user who
 * belongs to zero organizations always lands here; once
 * listOrganizations() returns anything, we send them on to /overview.
 * If the backend later adds a real onboarding-state field, this
 * inference should be replaced with it.
 */
export default async function OnboardingPage() {
  const session = await requireServerSession();
  const organizations = await listOrganizations(session.accessToken);

  if (organizations.length > 0) {
    redirect("/overview");
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Create your organization</h1>
        <p className="mt-1 text-sm text-zinc-600">
          TokenGuard groups API keys, usage, and budgets under an organization. Create one to get
          started.
        </p>
      </div>
      <CreateOrganizationForm />
    </div>
  );
}
