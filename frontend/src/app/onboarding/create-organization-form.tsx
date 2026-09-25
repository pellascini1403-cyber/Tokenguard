"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createOrganizationAction } from "@/lib/organizations/actions";
import { initialCreateOrganizationActionState } from "@/lib/organizations/organization-action-state";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";

export function CreateOrganizationForm() {
  const [state, formAction] = useActionState(
    createOrganizationAction,
    initialCreateOrganizationActionState,
  );
  const router = useRouter();

  useEffect(() => {
    if (state.createdOrganizationId) {
      router.push("/overview");
    }
  }, [state.createdOrganizationId, router]);

  return (
    <form action={formAction} className="space-y-4">
      <FormError message={state.error} />
      <div className="space-y-1">
        <label htmlFor="name" className="text-sm font-medium text-zinc-700">
          Organization name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={200}
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
      </div>
      <SubmitButton pendingLabel="Creating…">Create organization</SubmitButton>
    </form>
  );
}
