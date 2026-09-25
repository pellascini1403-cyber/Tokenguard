import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface ServerSession {
  supabaseUserId: string;
  email: string | null;
  accessToken: string;
}

/**
 * Re-validates the session against Supabase (via getUser(), not the
 * cheaper-but-unverified getSession()) and returns the caller's access
 * token for use with the TokenGuard API client. Returns null rather than
 * throwing — proxy.ts already redirects unauthenticated requests away
 * from protected routes, so a null here on a protected page generally
 * means the session expired between the proxy check and this render;
 * callers redirect to /login rather than crash.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return null;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return null;
  }

  return {
    supabaseUserId: user.id,
    email: user.email ?? null,
    accessToken: session.access_token,
  };
}

/** For protected Server Components: redirect to /login if the session is
 * missing, otherwise return it. Kept separate from getServerSession() so
 * pages that need to branch on "logged in or not" (rare — proxy.ts
 * handles that for whole route groups) aren't forced into a redirect. */
export async function requireServerSession(): Promise<ServerSession> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}
