import type { SupabaseAppClient } from "../../src/modules/auth/supabase-client.js";

interface FakeUser {
  id: string;
  email: string | null;
}

/**
 * Minimal fake of the Supabase auth surface our code actually calls
 * (auth.getUser). Backed by a fixed map of valid access tokens so tests
 * never need real Supabase credentials.
 */
export function createFakeAuthClient(validTokens: Record<string, FakeUser>): SupabaseAppClient {
  return {
    auth: {
      getUser: (token?: string) => {
        const user = token ? validTokens[token] : undefined;
        if (!user) {
          return Promise.resolve({
            data: { user: null },
            error: { message: "Invalid or expired token" },
          });
        }
        return Promise.resolve({ data: { user }, error: null });
      },
    },
    // Cast through unknown: this fake only implements auth.getUser, the
    // one method our code calls on the auth client.
  } as unknown as SupabaseAppClient;
}
