import { badRequestError } from "../../lib/errors.js";
import { isUuid } from "../../lib/uuid.js";
import type { SupabaseAppClient } from "../auth/supabase-client.js";
import { createUsageRepository } from "./usage.repository.js";
import { isProvider, PROVIDERS } from "./types.js";
import type {
  DateRangeFilter,
  PaginatedResult,
  PaginationParams,
  UsageLog,
  UsageLogFilter,
  UsageLogInput,
  UsageSummary,
} from "./types.js";

const MAX_MODEL_LENGTH = 200;
const MIN_STATUS_CODE = 100;
const MAX_STATUS_CODE = 599;
const DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;

function validateTokenCount(field: string, value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    throw badRequestError(`${field} must be a non-negative integer or null`);
  }
}

function validateCost(field: string, value: string | null): void {
  if (value !== null && !DECIMAL_STRING_PATTERN.test(value)) {
    throw badRequestError(`${field} must be a non-negative decimal string or null`);
  }
}

/**
 * Shape-and-range validation only. This service does not (and must not)
 * compute token counts or costs itself — it persists metadata the caller
 * (the future proxy) has already calculated. Cross-table consistency
 * between organizationId and tokenGuardKeyId is the database trigger's
 * job (see supabase/migrations); re-checking it here would mean an extra
 * query on every AI request just to duplicate what Postgres already
 * guarantees atomically.
 */
function validateUsageLogInput(input: UsageLogInput): void {
  if (!isUuid(input.organizationId)) {
    throw badRequestError("organizationId must be a valid UUID");
  }
  if (input.tokenGuardKeyId !== null && !isUuid(input.tokenGuardKeyId)) {
    throw badRequestError("tokenGuardKeyId must be a valid UUID or null");
  }
  if (!isProvider(input.provider)) {
    throw badRequestError(`provider must be one of: ${PROVIDERS.join(", ")}`);
  }
  if (
    typeof input.modelUsed !== "string" ||
    input.modelUsed.trim().length === 0 ||
    input.modelUsed.length > MAX_MODEL_LENGTH
  ) {
    throw badRequestError(
      `modelUsed must be a non-empty string of at most ${MAX_MODEL_LENGTH} characters`,
    );
  }

  validateTokenCount("promptTokens", input.promptTokens);
  validateTokenCount("completionTokens", input.completionTokens);
  validateTokenCount("totalTokens", input.totalTokens);
  if (
    input.promptTokens !== null &&
    input.completionTokens !== null &&
    input.totalTokens !== null &&
    input.totalTokens !== input.promptTokens + input.completionTokens
  ) {
    throw badRequestError(
      "totalTokens must equal promptTokens + completionTokens when all three are known",
    );
  }

  validateCost("inputCostUsd", input.inputCostUsd);
  validateCost("outputCostUsd", input.outputCostUsd);
  validateCost("totalCostUsd", input.totalCostUsd);

  if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
    throw badRequestError("durationMs must be a non-negative integer");
  }
  if (
    !Number.isInteger(input.statusCode) ||
    input.statusCode < MIN_STATUS_CODE ||
    input.statusCode > MAX_STATUS_CODE
  ) {
    throw badRequestError(
      `statusCode must be an integer between ${MIN_STATUS_CODE} and ${MAX_STATUS_CODE}`,
    );
  }
  if (!isUuid(input.requestId)) {
    throw badRequestError("requestId must be a valid UUID");
  }
}

const DEFAULT_PAGE_SIZE = 50;

export interface UsageService {
  /**
   * Persists one already-calculated usage log. The future proxy calls
   * this once per completed AI request; this service performs no token
   * counting or pricing of its own. Errors are thrown, never swallowed —
   * whether a persistence failure should fail the proxy's own response is
   * a decision for the caller, not this service.
   */
  createUsageLog(input: UsageLogInput): Promise<UsageLog>;
  /**
   * Returns a page of an organization's usage logs. `organizationId` must
   * already be an authorized value from the caller's perspective — this
   * service does not itself verify the caller's membership in it (that is
   * the route/session boundary's job, as with organizationsService).
   */
  getOrganizationLogs(
    organizationId: string,
    filter?: UsageLogFilter,
    pagination?: Partial<PaginationParams>,
  ): Promise<PaginatedResult<UsageLog>>;
  getOrganizationUsageSummary(
    organizationId: string,
    filter?: DateRangeFilter,
  ): Promise<UsageSummary>;
}

export function createUsageService(adminClient: SupabaseAppClient): UsageService {
  const repository = createUsageRepository(adminClient);

  return {
    async createUsageLog(input: UsageLogInput): Promise<UsageLog> {
      validateUsageLogInput(input);
      return repository.insert(input);
    },

    async getOrganizationLogs(
      organizationId: string,
      filter: UsageLogFilter = {},
      pagination: Partial<PaginationParams> = {},
    ): Promise<PaginatedResult<UsageLog>> {
      if (!isUuid(organizationId)) {
        throw badRequestError("organizationId must be a valid UUID");
      }
      return repository.getOrganizationLogs(organizationId, filter, {
        page: pagination.page ?? 1,
        pageSize: pagination.pageSize ?? DEFAULT_PAGE_SIZE,
      });
    },

    async getOrganizationUsageSummary(
      organizationId: string,
      filter: DateRangeFilter = {},
    ): Promise<UsageSummary> {
      if (!isUuid(organizationId)) {
        throw badRequestError("organizationId must be a valid UUID");
      }
      return repository.getOrganizationUsageSummary(organizationId, filter);
    },
  };
}
