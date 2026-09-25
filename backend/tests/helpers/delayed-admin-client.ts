import type { SupabaseAppClient } from "../../src/modules/auth/supabase-client.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return --
   This helper deliberately monkey-patches the fake admin client's
   untyped query-builder chain (see fake-admin-client.ts) to inject an
   artificial delay for one table's insert only — there is no way to do
   that through SupabaseAppClient's real types. */

/**
 * Wraps a fake admin client so that `token_logs` inserts don't resolve
 * until `gate` resolves — every other table/operation is untouched. Used
 * only to prove, at the full-proxy level, that the client response
 * genuinely does not wait for usage-log persistence: if it did, the
 * request would hang until the gate opens.
 */
export function withDelayedTokenLogsInsert(
  baseClient: SupabaseAppClient,
  gate: Promise<void>,
): SupabaseAppClient {
  const originalFrom = (baseClient as any).from.bind(baseClient);

  const wrappedFrom = (table: string) => {
    const builder = originalFrom(table);
    if (table !== "token_logs") {
      return builder;
    }

    const originalInsert = builder.insert.bind(builder);
    return {
      ...builder,
      insert(payload: any) {
        const instance = originalInsert(payload);
        const originalThen = instance.then.bind(instance);
        instance.then = (onFulfilled?: any, onRejected?: any) =>
          gate.then(() => originalThen(onFulfilled, onRejected));
        return instance;
      },
    };
  };

  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return wrappedFrom;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return */

/** A gate + opener pair: `gate` resolves only after `open()` is called. */
export function createGate(): { gate: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}
