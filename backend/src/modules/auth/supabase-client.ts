import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EnvConfig } from "../../config/env.js";

/* eslint-disable @typescript-eslint/no-explicit-any --
 * This module is the single boundary that pins supabase-js's Database
 * generic. We don't generate Database types from a live Supabase project
 * in this step, so `any` is used deliberately and consistently here (and
 * nowhere else — repositories consume `SupabaseAppClient` and cast query
 * results to their own row interfaces) rather than left to infer, since
 * supabase-js's generic defaults resolve inconsistently through
 * `ReturnType<typeof createClient>` across TypeScript versions.
 */

/** The client type used consistently across modules instead of importing
 * the bare, unparameterized `SupabaseClient` type. */
export type SupabaseAppClient = SupabaseClient<any, any, any>;

export interface SupabaseClients {
  /**
   * Constructed with the anon key. Used only to validate a user's Supabase
   * access token (auth.getUser). Never used to query application tables.
   */
  authClient: SupabaseAppClient;
  /**
   * Constructed with the service role key. Bypasses Row Level Security.
   * Server-only: used for all application table reads/writes, after the
   * request has already been authenticated and authorized in application
   * code. Never construct this client with a key that could reach a
   * browser.
   */
  adminClient: SupabaseAppClient;
}

export function createSupabaseClients(env: EnvConfig): SupabaseClients {
  const clientOptions = {
    auth: { autoRefreshToken: false, persistSession: false },
  };

  return {
    authClient: createClient<any, any, any>(env.supabase.url, env.supabase.anonKey, clientOptions),
    adminClient: createClient<any, any, any>(
      env.supabase.url,
      env.supabase.serviceRoleKey,
      clientOptions,
    ),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
