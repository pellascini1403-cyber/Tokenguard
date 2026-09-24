import type { SupabaseAppClient } from "../auth/supabase-client.js";
import type {
  DateRangeFilter,
  PaginatedResult,
  PaginationParams,
  Provider,
  UsageLog,
  UsageLogFilter,
  UsageLogInput,
  UsageSummary,
} from "./types.js";

const UNIQUE_VIOLATION = "23505";
/** Default Postgres SQLSTATE for a plain `raise exception` (no explicit errcode). */
const RAISE_EXCEPTION = "P0001";

export class DuplicateRequestIdError extends Error {
  constructor() {
    super("A usage log for this request_id already exists");
    this.name = "DuplicateRequestIdError";
  }
}

/** Thrown when organization_id does not match token_guard_key_id's owning
 * organization — mirrors the database trigger that is the real source of
 * truth for this invariant (see supabase/migrations). */
export class InconsistentKeyOrganizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InconsistentKeyOrganizationError";
  }
}

const MAX_PAGE_SIZE = 100;

interface TokenLogRow {
  id: string;
  organization_id: string;
  token_guard_key_id: string | null;
  provider: string;
  model_used: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  input_cost_usd: string | null;
  output_cost_usd: string | null;
  total_cost_usd: string | null;
  duration_ms: number;
  status_code: number;
  request_id: string;
  created_at: string;
}

interface UsageSummaryRow {
  request_count: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cost_usd: string;
  requests_with_unknown_usage: number;
}

function mapRow(row: TokenLogRow): UsageLog {
  return {
    id: row.id,
    organizationId: row.organization_id,
    tokenGuardKeyId: row.token_guard_key_id,
    provider: row.provider as Provider,
    modelUsed: row.model_used,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    inputCostUsd: row.input_cost_usd,
    outputCostUsd: row.output_cost_usd,
    totalCostUsd: row.total_cost_usd,
    durationMs: row.duration_ms,
    statusCode: row.status_code,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

function mapSummaryRow(row: UsageSummaryRow): UsageSummary {
  return {
    requestCount: row.request_count,
    totalPromptTokens: row.total_prompt_tokens,
    totalCompletionTokens: row.total_completion_tokens,
    totalTokens: row.total_tokens,
    totalCostUsd: row.total_cost_usd,
    requestsWithUnknownUsage: row.requests_with_unknown_usage,
  };
}

export interface UsageRepository {
  /**
   * Persists one usage log. Never called with pre-aggregated or bulk
   * data — this is the single-row write the future proxy calls once per
   * completed request.
   */
  insert(input: UsageLogInput): Promise<UsageLog>;
  getOrganizationLogs(
    organizationId: string,
    filter: UsageLogFilter,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<UsageLog>>;
  getOrganizationUsageSummary(
    organizationId: string,
    filter: DateRangeFilter,
  ): Promise<UsageSummary>;
}

export function createUsageRepository(adminClient: SupabaseAppClient): UsageRepository {
  return {
    async insert(input: UsageLogInput): Promise<UsageLog> {
      // insert()/select() on the untyped Supabase client resolves to
      // `any`; the returned row is cast to TokenLogRow below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await adminClient
        .from("token_logs")
        .insert({
          organization_id: input.organizationId,
          token_guard_key_id: input.tokenGuardKeyId,
          provider: input.provider,
          model_used: input.modelUsed,
          prompt_tokens: input.promptTokens,
          completion_tokens: input.completionTokens,
          total_tokens: input.totalTokens,
          input_cost_usd: input.inputCostUsd,
          output_cost_usd: input.outputCostUsd,
          total_cost_usd: input.totalCostUsd,
          duration_ms: input.durationMs,
          status_code: input.statusCode,
          request_id: input.requestId,
        })
        .select()
        .single();

      if (error) {
        if (error.code === UNIQUE_VIOLATION) {
          throw new DuplicateRequestIdError();
        }
        if (error.code === RAISE_EXCEPTION) {
          throw new InconsistentKeyOrganizationError(error.message);
        }
        throw new Error(`Failed to persist usage log: ${error.message}`);
      }

      return mapRow(data as TokenLogRow);
    },

    async getOrganizationLogs(
      organizationId: string,
      filter: UsageLogFilter,
      pagination: PaginationParams,
    ): Promise<PaginatedResult<UsageLog>> {
      const pageSize = Math.min(Math.max(Math.trunc(pagination.pageSize), 1), MAX_PAGE_SIZE);
      const page = Math.max(Math.trunc(pagination.page), 1);
      const from = (page - 1) * pageSize;
      // Fetch one extra row so `hasMore` needs no separate COUNT(*) query.
      const to = from + pageSize;

      let query = adminClient.from("token_logs").select("*").eq("organization_id", organizationId);

      if (filter.provider) {
        query = query.eq("provider", filter.provider);
      }
      if (filter.model) {
        query = query.eq("model_used", filter.model);
      }
      if (filter.startDate) {
        query = query.gte("created_at", filter.startDate);
      }
      if (filter.endDate) {
        query = query.lte("created_at", filter.endDate);
      }

      // id as a tiebreaker keeps ordering deterministic when multiple
      // rows share the same created_at timestamp.
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);

      if (error) {
        throw new Error(`Failed to list usage logs: ${error.message}`);
      }

      const rows = (data ?? []) as TokenLogRow[];
      const hasMore = rows.length > pageSize;
      return { items: rows.slice(0, pageSize).map(mapRow), page, pageSize, hasMore };
    },

    async getOrganizationUsageSummary(
      organizationId: string,
      filter: DateRangeFilter,
    ): Promise<UsageSummary> {
      // rpc() on the untyped Supabase client resolves to `any`; the
      // returned row is cast to UsageSummaryRow below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await adminClient.rpc("get_organization_usage_summary", {
        p_organization_id: organizationId,
        p_start: filter.startDate ?? null,
        p_end: filter.endDate ?? null,
      });

      if (error) {
        throw new Error(`Failed to summarize usage: ${error.message}`);
      }

      const rows = data as UsageSummaryRow[];
      const row = rows[0];
      if (!row) {
        throw new Error("Usage summary query returned no row");
      }
      return mapSummaryRow(row);
    },
  };
}
