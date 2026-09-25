"use client";

import { useActionState } from "react";
import { resetPasswordAction } from "@/lib/auth/actions";
import { initialAuthActionState } from "@/lib/auth/auth-action-state";
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
    <div className="max-w-sm space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">Security</h1>
      <form action={formAction} className="space-y-4">
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
    </div>
  );
}
