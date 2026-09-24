import "dotenv/config";

export type NodeEnv = "development" | "test" | "production";

export interface SupabaseEnvConfig {
  /** Project URL. Same value a browser/dashboard client would use — not secret. */
  url: string;
  /** Public, RLS-constrained key. Safe to ship to a browser client. */
  anonKey: string;
  /**
   * Privileged key that bypasses Row Level Security. Server-only.
   * MUST NEVER be sent to a browser, logged, or embedded in client code.
   */
  serviceRoleKey: string;
}

export interface EnvConfig {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  isProduction: boolean;
  supabase: SupabaseEnvConfig;
}

function parseNodeEnv(value: string | undefined): NodeEnv {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }
  return "development";
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 3000;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: "${value}". Expected an integer between 1 and 65535.`);
  }
  return parsed;
}

const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const DEV_SUPABASE_ANON_KEY = "development-placeholder-anon-key";
const DEV_SUPABASE_SERVICE_ROLE_KEY = "development-placeholder-service-role-key";

function parseSupabaseConfig(source: NodeJS.ProcessEnv, nodeEnv: NodeEnv): SupabaseEnvConfig {
  const url = source.SUPABASE_URL;
  const anonKey = source.SUPABASE_ANON_KEY;
  const serviceRoleKey = source.SUPABASE_SERVICE_ROLE_KEY;

  if (nodeEnv === "production") {
    if (!url || !anonKey || !serviceRoleKey) {
      throw new Error(
        "SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are required in production.",
      );
    }
    return { url, anonKey, serviceRoleKey };
  }

  // Non-production defaults point at the local Supabase CLI stack so the
  // server can boot without secrets. These placeholders cannot authenticate
  // against a real Supabase project.
  return {
    url: url && url.length > 0 ? url : LOCAL_SUPABASE_URL,
    anonKey: anonKey && anonKey.length > 0 ? anonKey : DEV_SUPABASE_ANON_KEY,
    serviceRoleKey:
      serviceRoleKey && serviceRoleKey.length > 0 ? serviceRoleKey : DEV_SUPABASE_SERVICE_ROLE_KEY,
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): EnvConfig {
  const nodeEnv = parseNodeEnv(source.NODE_ENV);
  return {
    nodeEnv,
    port: parsePort(source.PORT),
    host: source.HOST && source.HOST.length > 0 ? source.HOST : "0.0.0.0",
    isProduction: nodeEnv === "production",
    supabase: parseSupabaseConfig(source, nodeEnv),
  };
}
