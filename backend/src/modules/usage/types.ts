export const PROVIDERS = ["openai", "anthropic"] as const;

export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export const USAGE_SOURCES = ["provider", "estimated", "unknown"] as const;

/**
 * Where the token counts on a usage log came from: reported directly by
 * the AI provider, estimated by TokenGuard (architecture reserved for a
 * later step — see src/modules/providers usage parsers), or unknown
 * (neither — token fields are null, never a fake 0).
 */
export type UsageSource = (typeof USAGE_SOURCES)[number];

export function isUsageSource(value: string): value is UsageSource {
  return (USAGE_SOURCES as readonly string[]).includes(value);
}

/**
 * What the future proxy will pass to `usageService.createUsageLog()` after
 * completing a request. Token counts and cost fields are `null`, never 0,
 * when a provider response did not report usage or cost has not been
 * calculated — this service only persists already-computed metadata, it
 * does not count tokens or price requests itself. Monetary values are
 * decimal strings (not `number`) to avoid floating-point precision loss,
 * matching how Postgres NUMERIC values round-trip through this codebase
 * (see `Organization.monthlyBudgetUsd`).
 */
export interface UsageLogInput {
  organizationId: string;
  /** The TokenGuard credential that authenticated this request, if any. */
  tokenGuardKeyId: string | null;
  provider: Provider;
  modelUsed: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  inputCostUsd: string | null;
  outputCostUsd: string | null;
  totalCostUsd: string | null;
  /** Where the token counts above came from. Never inferred by this module. */
  usageSource: UsageSource;
  /** Identifies which pricing snapshot priced this row, or null when no
   * pricing was available for the model (costs are then also null). Set
   * once at insert time and never recalculated — a later pricing update
   * must not change a historical row's cost. */
  pricingVersion: string | null;
  durationMs: number;
  statusCode: number;
  /** Correlates this log to one proxy request. Must be unique. */
  requestId: string;
}

export interface UsageLog extends UsageLogInput {
  id: string;
  createdAt: string;
}

export interface DateRangeFilter {
  /** ISO 8601 timestamp, inclusive. */
  startDate?: string;
  /** ISO 8601 timestamp, inclusive. */
  endDate?: string;
}

export interface UsageLogFilter extends DateRangeFilter {
  provider?: Provider;
  model?: string;
}

export interface PaginationParams {
  /** 1-based. */
  page: number;
  pageSize: number;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  /** Whether a further page exists, without requiring a separate COUNT(*) query. */
  hasMore: boolean;
}

export interface UsageSummary {
  requestCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: string;
  /** Requests where the provider did not report token usage. */
  requestsWithUnknownUsage: number;
}
