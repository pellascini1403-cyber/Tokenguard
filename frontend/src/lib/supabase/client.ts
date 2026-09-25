"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getPublicEnv } from "@/lib/env";

/**
 * Browser Supabase client. Uses only the anon key (RLS-constrained) — the
 * service role key must never reach this file or any Client Component.
 * Session tokens are managed by Supabase's own cookie-based mechanism
 * (via @supabase/ssr), never read or stored manually.
 */
export function createSupabaseBrowserClient() {
  const env = getPublicEnv();
  return createBrowserClient(env.supabaseUrl, env.supabaseAnonKey);
}
