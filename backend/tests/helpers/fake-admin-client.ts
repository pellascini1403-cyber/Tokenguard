import { randomUUID } from "node:crypto";
import type { SupabaseAppClient } from "../../src/modules/auth/supabase-client.js";

type Row = Record<string, unknown>;

export interface FakeStore {
  organizations: Row[];
  organization_members: Row[];
  token_guard_keys: Row[];
}

type TableName = keyof FakeStore;

interface PostgrestLikeError {
  message: string;
  code?: string;
}

type QueryResult = { data: unknown; error: PostgrestLikeError | null };

function matchesFilters(row: Row, filters: Array<{ col: string; value: unknown }>): boolean {
  return filters.every(({ col, value }) => row[col] === value);
}

/**
 * A narrow, hand-rolled fake of the exact supabase-js query-builder chain
 * our repositories use (from/select/insert/update/eq/is/single/
 * maybeSingle), backed by an in-memory array per table. It is not a
 * general-purpose Postgrest emulator — only what this codebase calls.
 */
class FakeQueryBuilder implements PromiseLike<QueryResult> {
  private filters: Array<{ col: string; value: unknown }> = [];
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
    this.filters.push({ col, value });
    return this;
  }

  is(col: string, value: unknown): this {
    this.filters.push({ col, value });
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

  private execute(): QueryResult {
    const rows = this.store[this.table];

    if (this.op === "select") {
      const matched = rows.filter((row) => matchesFilters(row, this.filters));
      const projected =
        this.table === "organization_members" && this.selectColumns === "organizations(*)"
          ? matched.map((row) => ({
              organizations: this.store.organizations.find((o) => o.id === row.organization_id),
            }))
          : matched;

      if (this.singleMode === "single") {
        return projected.length === 1
          ? { data: projected[0], error: null }
          : { data: null, error: { message: "no rows found" } };
      }
      if (this.singleMode === "maybeSingle") {
        return { data: projected[0] ?? null, error: null };
      }
      return { data: projected, error: null };
    }

    if (this.op === "insert") {
      const payload = this.payload ?? {};
      if (
        typeof payload.key_prefix === "string" &&
        rows.some((row) => row.key_prefix === payload.key_prefix)
      ) {
        return { data: null, error: { message: "duplicate key value", code: "23505" } };
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

export function createFakeAdminClient(seed?: Partial<FakeStore>): {
  client: SupabaseAppClient;
  store: FakeStore;
} {
  const store: FakeStore = {
    organizations: seed?.organizations ?? [],
    organization_members: seed?.organization_members ?? [],
    token_guard_keys: seed?.token_guard_keys ?? [],
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
      return Promise.resolve({ data: null, error: { message: `Unknown RPC: ${fnName}` } });
    },
    // Cast through unknown: this fake only implements the small subset of
    // the real SupabaseClient surface our repositories call.
  } as unknown as SupabaseAppClient;

  return { client, store };
}
