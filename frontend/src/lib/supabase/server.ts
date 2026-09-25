import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getPublicEnv } from "@/lib/env";

/**
 * Server-side Supabase client for Server Components, Server Actions, and
 * Route Handlers. Reads/writes the session via Next.js's cookie store, so
 * it shares Supabase's own refresh mechanism with the browser client —
 * this app never parses or stores a raw access token itself.
 *
 * Only the anon key is used here, same as the browser client. Calling
 * `.auth.getUser()` on the returned client re-validates the session
 * against Supabase on every call, which is what route protection in
 * proxy.ts and every server-rendered page relies on.
 *
 * `cookies().set()` throws when called from a plain Server Component
 * (rendering can't mutate response cookies) — Server Components only ever
 * read the session, so that failure is swallowed there. Server Actions
 * and Route Handlers, where writing is valid, call this from a context
 * where the try/catch is a no-op.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const env = getPublicEnv();

  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component during rendering — session
          // writes only matter in proxy.ts (which runs before rendering)
          // and in Server Actions/Route Handlers, both of which are able
          // to set cookies. Safe to ignore here.
        }
      },
    },
  });
}
