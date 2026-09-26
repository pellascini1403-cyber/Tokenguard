"use client";

import { useActionState } from "react";
import { createKeyAction } from "@/lib/keys/actions";
import { initialCreateKeyActionState } from "@/lib/keys/key-action-state";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";

interface CreateKeyFormProps {
  organizationId: string;
}

export function CreateKeyForm({ organizationId }: CreateKeyFormProps) {
  const [state, formAction] = useActionState(createKeyAction, initialCreateKeyActionState);

  return (
    <div className="space-y-3">
      <form action={formAction} className="flex items-end gap-3">
        <input type="hidden" name="organizationId" value={organizationId} />
        <div className="flex-1 space-y-1">
          <label htmlFor="key-name" className="text-sm font-medium text-zinc-700">
            Key name
          </label>
          <input
            id="key-name"
            name="name"
            type="text"
            required
            maxLength={100}
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <SubmitButton pendingLabel="Creating…">Create key</SubmitButton>
      </form>
      <FormError message={state.error} />
      {state.createdKey && (
        <div role="status" className="rounded-md bg-black p-3 text-sm">
          <p className="font-medium text-amber-400">
            Key created — copy this now, it will not be shown again.
          </p>
          <p className="mt-1 break-all font-mono text-white">{state.createdKey.apiKey}</p>
          <p className="mt-1 text-zinc-400">
            id: {state.createdKey.id} · prefix: {state.createdKey.prefix}
          </p>
        </div>
      )}
    </div>
  );
}
