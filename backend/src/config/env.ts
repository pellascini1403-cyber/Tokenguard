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

export interface ProxyEnvConfig {
  /** Upstream base URL for OpenAI-compatible requests. Not secret. */
  openaiBaseUrl: string;
  /** Upstream base URL for Anthropic requests. Not secret. */
  anthropicBaseUrl: string;
  /** How long the proxy waits for an upstream provider response (connect/
   * headers phase) before aborting. Applies to both non-streaming
   * requests and the connect phase of a streaming request. */
  requestTimeoutMs: number;
  /** Hard ceiling on how long a single SSE stream may stay open, once it
   * has started. Independent of requestTimeoutMs — a chunk arriving does
   * not reset this timer, so a slow-trickling stream cannot stay open
   * indefinitely. */
  streamMaxDurationMs: number;
  /** Maximum accepted request body size for proxy endpoints, in bytes. */
  maxBodyBytes: number;
}

export interface EnvConfig {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  isProduction: boolean;
  supabase: SupabaseEnvConfig;
  proxy: ProxyEnvConfig;
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

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
// Generous enough for large multi-turn contexts as raw JSON, still bounded
// against arbitrarily large request bodies.
const DEFAULT_MAX_PROXY_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
// Generous enough for a long generation (reasoning models can run for
// minutes) while still guaranteeing a streaming connection cannot stay
// open forever just by trickling occasional bytes.
const DEFAULT_STREAM_MAX_DURATION_MS = 300_000;

function parseBaseUrl(value: string | undefined, defaultValue: string, label: string): string {
  const url = value && value.length > 0 ? value : defaultValue;
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid ${label} value: "${url}". Expected an absolute URL.`);
  }
  return url;
}

function parsePositiveInt(value: string | undefined, defaultValue: number, label: string): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label} value: "${value}". Expected a positive integer.`);
  }
  return parsed;
}

function parseProxyConfig(source: NodeJS.ProcessEnv): ProxyEnvConfig {
  return {
    openaiBaseUrl: parseBaseUrl(source.OPENAI_BASE_URL, DEFAULT_OPENAI_BASE_URL, "OPENAI_BASE_URL"),
    anthropicBaseUrl: parseBaseUrl(
      source.ANTHROPIC_BASE_URL,
      DEFAULT_ANTHROPIC_BASE_URL,
      "ANTHROPIC_BASE_URL",
    ),
    requestTimeoutMs: parsePositiveInt(
      source.PROVIDER_REQUEST_TIMEOUT_MS,
      DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
      "PROVIDER_REQUEST_TIMEOUT_MS",
    ),
    streamMaxDurationMs: parsePositiveInt(
      source.STREAM_MAX_DURATION_MS,
      DEFAULT_STREAM_MAX_DURATION_MS,
      "STREAM_MAX_DURATION_MS",
    ),
    maxBodyBytes: parsePositiveInt(
      source.MAX_PROXY_BODY_BYTES,
      DEFAULT_MAX_PROXY_BODY_BYTES,
      "MAX_PROXY_BODY_BYTES",
    ),
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
    proxy: parseProxyConfig(source),
  };
}
