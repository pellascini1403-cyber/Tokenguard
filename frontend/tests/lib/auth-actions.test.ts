import { describe, expect, it } from "vitest";
import { signInAction, signUpAction, forgotPasswordAction } from "@/lib/auth/actions";
import { initialAuthActionState } from "@/lib/auth/auth-action-state";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe("signInAction validation", () => {
  it("rejects a missing email without ever contacting Supabase", async () => {
    const result = await signInAction(initialAuthActionState, formData({ password: "secret123" }));
    expect(result.error).toBe("Email and password are required.");
  });

  it("rejects a missing password", async () => {
    const result = await signInAction(initialAuthActionState, formData({ email: "a@b.com" }));
    expect(result.error).toBe("Email and password are required.");
  });
});

describe("signUpAction validation", () => {
  it("rejects an empty form", async () => {
    const result = await signUpAction(initialAuthActionState, formData({}));
    expect(result.error).toBe("Email and password are required.");
  });
});

describe("forgotPasswordAction validation", () => {
  it("rejects a missing email", async () => {
    const result = await forgotPasswordAction(initialAuthActionState, formData({}));
    expect(result.error).toBe("Email is required.");
  });
});
