"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signInAction } from "@/lib/auth/actions";
import { initialAuthActionState } from "@/lib/auth/auth-action-state";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";

export default function LoginPage() {
  const [state, formAction] = useActionState(signInAction, initialAuthActionState);

  return (
    <form action={formAction} className="space-y-4" aria-labelledby="login-heading">
      <h1 id="login-heading" className="text-xl font-semibold text-zinc-900">
        Sign in
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
      <div className="space-y-1">
        <label htmlFor="password" className="text-sm font-medium text-zinc-700">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
      </div>
      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      <div className="flex justify-between text-sm text-zinc-600">
        <Link href="/register" className="underline">
          Create an account
        </Link>
        <Link href="/forgot-password" className="underline">
          Forgot password?
        </Link>
      </div>
    </form>
  );
}
