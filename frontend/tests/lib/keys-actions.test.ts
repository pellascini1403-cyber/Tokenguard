import { describe, expect, it } from "vitest";
import { createKeyAction, revokeKeyAction } from "@/lib/keys/actions";
import { initialCreateKeyActionState, initialRevokeKeyActionState } from "@/lib/keys/key-action-state";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe("createKeyAction validation", () => {
  it("rejects a missing organizationId without touching the session", async () => {
    const result = await createKeyAction(initialCreateKeyActionState, formData({ name: "prod" }));
    expect(result).toEqual({ error: "No active organization selected.", createdKey: null });
  });

  it("rejects a missing/blank key name", async () => {
    const result = await createKeyAction(
      initialCreateKeyActionState,
      formData({ organizationId: "org-1", name: "   " }),
    );
    expect(result).toEqual({ error: "Key name is required.", createdKey: null });
  });
});

describe("revokeKeyAction validation", () => {
  it("rejects a missing organizationId", async () => {
    const result = await revokeKeyAction(initialRevokeKeyActionState, formData({ keyId: "key-1" }));
    expect(result).toEqual({ error: "No active organization selected.", success: false });
  });

  it("rejects a missing keyId", async () => {
    const result = await revokeKeyAction(
      initialRevokeKeyActionState,
      formData({ organizationId: "org-1" }),
    );
    expect(result).toEqual({ error: "Key id is required.", success: false });
  });
});
