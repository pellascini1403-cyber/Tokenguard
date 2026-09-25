/**
 * Centralized environment access, mirroring the backend's config/env.ts
 * convention: parse once, fail fast with a clear message, and keep
 * browser-exposed values clearly separated from server-only ones.
 *
 * Browser-exposed (NEXT_PUBLIC_*): Supabase URL and anon key are not
 * secret — they are the same values a browser Supabase client always
 * needs, constrained by Row Level Security. The TokenGuard backend URL is
 * also not secret, only an endpoint address.
 *
 * There are currently NO server-only frontend environment variables.
 * Nothing here may ever hold a Supabase service role key or an AI
 * provider key — those belong to the backend only, never to this app.
 */

function requireEnv(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export interface PublicEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  tokenGuardApiUrl: string;
}

/**
 * NEXT_PUBLIC_* values are inlined at build time by Next.js and are safe
 * to read from both Server and Client Components.
 */
export function getPublicEnv(): PublicEnv {
  return {
    supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnonKey: requireEnv(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
    tokenGuardApiUrl: requireEnv(
      "NEXT_PUBLIC_TOKENGUARD_API_URL",
      process.env.NEXT_PUBLIC_TOKENGUARD_API_URL,
    ),
  };
}
