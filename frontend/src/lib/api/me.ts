import { tokenGuardFetch } from "@/lib/api/client";
import type { AuthenticatedUser } from "@/types/user";

export async function getMe(accessToken: string): Promise<AuthenticatedUser> {
  return tokenGuardFetch<AuthenticatedUser>("/v1/me", { accessToken });
}
