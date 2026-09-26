"use client";

import { useActionState } from "react";
import { resetPasswordAction } from "@/lib/auth/actions";
import { initialAuthActionState } from "@/lib/auth/auth-action-state";
import { AppScreen } from "@/components/dashboard/app-screen";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * Password change while already signed in. This reuses Supabase's own
 * updateUser() (the same action as the /reset-password flow) — it is
 * real functionality against Supabase Auth directly, not a TokenGuard
 * backend endpoint.
 */
export default function SecuritySettingsPage() {
  const [state, formAction] = useActionState(resetPasswordAction, initialAuthActionState);

  return (
    <AppScreen header={<h1 className="text-xl font-semibold">Security</h1>}>
      <form action={formAction} className="max-w-sm space-y-4">
        <FormError message={state.error} />
        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium text-zinc-700">
            New password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <SubmitButton pendingLabel="Updating…">Update password</SubmitButton>
      </form>
    </AppScreen>
  );
}
