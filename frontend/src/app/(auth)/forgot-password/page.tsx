"use client";

import { useActionState } from "react";
import Link from "next/link";
import { forgotPasswordAction } from "@/lib/auth/actions";
import { initialAuthActionState } from "@/lib/auth/auth-action-state";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";

export default function ForgotPasswordPage() {
  const [state, formAction] = useActionState(forgotPasswordAction, initialAuthActionState);
  const submitted = state.error === null;

  return (
    <form action={formAction} className="space-y-4" aria-labelledby="forgot-password-heading">
      <h1 id="forgot-password-heading" className="text-xl font-semibold text-zinc-900">
        Reset your password
      </h1>
      <FormError message={state.error} />
      <div className="space-y-1">
        <label htmlFor="email" className="text-sm font-medium text-zinc-700">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
      </div>
      <SubmitButton pendingLabel="Sending…">Send reset link</SubmitButton>
      {submitted && (
        <p className="text-sm text-zinc-600" role="status">
          If an account exists for that email, a reset link has been sent.
        </p>
      )}
      <p className="text-sm text-zinc-600">
        <Link href="/login" className="underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
