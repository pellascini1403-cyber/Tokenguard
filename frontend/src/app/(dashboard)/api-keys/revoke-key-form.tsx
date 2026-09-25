"use client";

import { useActionState } from "react";
import { revokeKeyAction } from "@/lib/keys/actions";
import { initialRevokeKeyActionState } from "@/lib/keys/key-action-state";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";

interface RevokeKeyFormProps {
  organizationId: string;
}

export function RevokeKeyForm({ organizationId }: RevokeKeyFormProps) {
  const [state, formAction] = useActionState(revokeKeyAction, initialRevokeKeyActionState);

  return (
    <div className="space-y-3">
      <form action={formAction} className="flex items-end gap-3">
        <input type="hidden" name="organizationId" value={organizationId} />
        <div className="flex-1 space-y-1">
          <label htmlFor="key-id" className="text-sm font-medium text-zinc-700">
            Key id
          </label>
          <input
            id="key-id"
            name="keyId"
            type="text"
            required
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <SubmitButton pendingLabel="Revoking…">Revoke key</SubmitButton>
      </form>
      <FormError message={state.error} />
      {state.success && (
        <p role="status" className="text-sm text-zinc-600">
          Key revoked.
        </p>
      )}
    </div>
  );
}
