"use client";

import { useActionState } from "react";
import { resetPasswordAction } from "@/lib/auth/actions";
import { initialAuthActionState } from "@/lib/auth/auth-action-state";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * Reached via the link in the password-reset email, which Supabase's own
 * flow turns into an authenticated recovery session before this page
 * loads. This form only calls supabase.auth.updateUser() (through the
 * server action) — it never handles the recovery token itself.
 */
export default function ResetPasswordPage() {
  const [state, formAction] = useActionState(resetPasswordAction, initialAuthActionState);

  return (
    <form action={formAction} className="space-y-4" aria-labelledby="reset-password-heading">
      <h1 id="reset-password-heading" className="text-xl font-semibold text-zinc-900">
        Choose a new password
      </h1>
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
  );
}
