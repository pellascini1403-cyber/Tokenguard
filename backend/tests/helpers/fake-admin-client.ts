import { randomUUID } from "node:crypto";
import type { SupabaseAppClient } from "../../src/modules/auth/supabase-client.js";

type Row = Record<string, unknown>;

export interface FakeStore {
  organizations: Row[];
  organization_members: Row[];
  token_guard_keys: Row[];
  token_logs: Row[];
}

type TableName = keyof FakeStore;

interface PostgrestLikeError {
  message: string;
  code?: string;
}

type QueryResult = { data: unknown; error: PostgrestLikeError | null };

type FilterOp = "eq" | "is" | "gte" | "lte";
interface Filter {
  col: string;
  op: FilterOp;
  value: unknown;
}
interface OrderClause {
  col: string;
  ascending: boolean;
}

/** Tables with a column that must be unique, mirroring a real unique index. */
const UNIQUE_COLUMNS: Partial<Record<TableName, string[]>> = {
  token_guard_keys: ["key_prefix"],
  token_logs: ["request_id"],
};

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return 0;
}

function matchesFilters(row: Row, filters: Filter[]): boolean {
  return filters.every(({ col, op, value }) => {
    const rowValue = row[col];
    switch (op) {
      case "eq":
      case "is":
        return rowValue === value;
      case "gte":
        return compareValues(rowValue, value) >= 0;
      case "lte":
        return compareValues(rowValue, value) <= 0;
      default:
        return true;
    }
  });
}

/**
 * A narrow, hand-rolled fake of the exact supabase-js query-builder chain
 * our repositories use (from/select/insert/update/eq/is/gte/lte/order/
 * range/single/maybeSingle), backed by an in-memory array per table. It
 * is not a general-purpose Postgrest emulator — only what this codebase
 * calls.
 */
class FakeQueryBuilder implements PromiseLike<QueryResult> {
  private filters: Filter[] = [];
  private orderClauses: OrderClause[] = [];
  private rangeBounds: { from: number; to: number } | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;
  private selectColumns: string | null = null;

  constructor(
    private readonly store: FakeStore,
    private readonly table: TableName,
    private readonly op: "select" | "insert" | "update",
    private readonly payload?: Row,
  ) {}

  select(columns?: string): this {
    this.selectColumns = columns ?? null;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ col, op: "eq", value });
    return this;
  }

  is(col: string, value: unknown): this {
    this.filters.push({ col, op: "is", value });
    return this;
  }

  gte(col: string, value: unknown): this {
    this.filters.push({ col, op: "gte", value });
    return this;
  }

  lte(col: string, value: unknown): this {
    this.filters.push({ col, op: "lte", value });
    return this;
  }

  order(col: string, options?: { ascending?: boolean }): this {
    this.orderClauses.push({ col, ascending: options?.ascending ?? true });
    return this;
  }

  /** Inclusive on both ends, matching supabase-js's Range-header semantics. */
  range(from: number, to: number): this {
    this.rangeBounds = { from, to };
    return this;
  }

  single(): this {
    this.singleMode = "single";
    return this;
  }

  maybeSingle(): this {
    this.singleMode = "maybeSingle";
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private compareByOrder = (a: Row, b: Row): number => {
    for (const { col, ascending } of this.orderClauses) {
      const cmp = compareValues(a[col], b[col]);
      if (cmp !== 0) {
        return ascending ? cmp : -cmp;
      }
    }
    return 0;
  };

  private execute(): QueryResult {
    const rows = this.store[this.table];

    if (this.op === "select") {
      let matched: Row[] = rows.filter((row) => matchesFilters(row, this.filters));

      if (this.table === "organization_members" && this.selectColumns === "organizations(*)") {
        matched = matched.map((row) => ({
          organizations: this.store.organizations.find((o) => o.id === row.organization_id),
        }));
      }

      if (this.orderClauses.length > 0) {
        matched = [...matched].sort(this.compareByOrder);
      }

      if (this.rangeBounds) {
        matched = matched.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
      }

      if (this.singleMode === "single") {
        return matched.length === 1
          ? { data: matched[0], error: null }
          : { data: null, error: { message: "no rows found" } };
      }
      if (this.singleMode === "maybeSingle") {
        return { data: matched[0] ?? null, error: null };
      }
      return { data: matched, error: null };
    }

    if (this.op === "insert") {
      const payload = this.payload ?? {};

      for (const col of UNIQUE_COLUMNS[this.table] ?? []) {
        const value = payload[col];
        if (value !== undefined && rows.some((row) => row[col] === value)) {
          return { data: null, error: { message: `duplicate value for ${col}`, code: "23505" } };
        }
      }

      if (this.table === "token_logs" && payload.token_guard_key_id) {
        const keyRow = this.store.token_guard_keys.find((k) => k.id === payload.token_guard_key_id);
        if (!keyRow) {
          return {
            data: null,
            error: {
              message: `token_guard_key_id ${JSON.stringify(payload.token_guard_key_id)} does not exist`,
              code: "P0001",
            },
          };
        }
        if (keyRow.organization_id !== payload.organization_id) {
          return {
            data: null,
            error: {
              message: `organization_id ${JSON.stringify(payload.organization_id)} does not match the organization owning token_guard_key_id ${JSON.stringify(payload.token_guard_key_id)}`,
              code: "P0001",
            },
          };
        }
      }

      const row: Row = {
        id: randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        revoked_at: null,
        ...payload,
      };
      rows.push(row);
      return { data: row, error: null };
    }

    // update
    const matched = rows.filter((row) => matchesFilters(row, this.filters));
    matched.forEach((row) => Object.assign(row, this.payload));
    if (this.singleMode === "maybeSingle") {
      return { data: matched[0] ?? null, error: null };
    }
    return { data: matched, error: null };
  }
}

function sumColumn(rows: Row[], col: string): number {
  return rows.reduce((total, row) => {
    const value = row[col];
    return value === null || value === undefined ? total : total + Number(value);
  }, 0);
}

export function createFakeAdminClient(seed?: Partial<FakeStore>): {
  client: SupabaseAppClient;
  store: FakeStore;
} {
  const store: FakeStore = {
    organizations: seed?.organizations ?? [],
    organization_members: seed?.organization_members ?? [],
    token_guard_keys: seed?.token_guard_keys ?? [],
    token_logs: seed?.token_logs ?? [],
  };

  const client = {
    from(table: TableName) {
      return {
        select: (columns?: string) => new FakeQueryBuilder(store, table, "select").select(columns),
        insert: (payload: Row) => new FakeQueryBuilder(store, table, "insert", payload),
        update: (payload: Row) => new FakeQueryBuilder(store, table, "update", payload),
      };
    },
    rpc(fnName: string, args: Record<string, unknown>): Promise<QueryResult> {
      if (fnName === "create_organization_with_owner") {
        const org: Row = {
          id: randomUUID(),
          name: args.p_name,
          monthly_budget_usd: "500.00",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        store.organizations.push(org);
        store.organization_members.push({
          id: randomUUID(),
          organization_id: org.id,
          user_id: args.p_owner_user_id,
          role: "owner",
          created_at: new Date().toISOString(),
        });
        return Promise.resolve({ data: org, error: null });
      }

      if (fnName === "get_organization_usage_summary") {
        const orgId = args.p_organization_id;
        const start = args.p_start as string | null;
        const end = args.p_end as string | null;
        const matched = store.token_logs.filter((row) => {
          if (row.organization_id !== orgId) return false;
          if (start && (row.created_at as string) < start) return false;
          if (end && (row.created_at as string) > end) return false;
          return true;
        });
        const summaryRow: Row = {
          request_count: matched.length,
          total_prompt_tokens: sumColumn(matched, "prompt_tokens"),
          total_completion_tokens: sumColumn(matched, "completion_tokens"),
          total_tokens: sumColumn(matched, "total_tokens"),
          total_cost_usd: sumColumn(matched, "total_cost_usd").toFixed(8),
          requests_with_unknown_usage: matched.filter(
            (row) => row.total_tokens === null || row.total_tokens === undefined,
          ).length,
        };
        return Promise.resolve({ data: [summaryRow], error: null });
      }

      return Promise.resolve({ data: null, error: { message: `Unknown RPC: ${fnName}` } });
    },
    // Cast through unknown: this fake only implements the small subset of
    // the real SupabaseClient surface our repositories call.
  } as unknown as SupabaseAppClient;

  return { client, store };
}
