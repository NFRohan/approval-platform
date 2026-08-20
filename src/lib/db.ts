// =====================================================================
// Client shim.
//
// Presents the surface the 156 call sites already use — from().select()
// .eq(), .single(), .rpc() — but routes everything through one server
// function instead of straight to the database from the browser. That is
// deliberate: it swaps the backend without touching 22 files of screens.
//
// Differences from what it replaces, both intentional:
//
//   * Errors are returned as { data, error }, never thrown. That is what
//     every call site already expects.
//   * Selects have a row ceiling. Every screen read unbounded before,
//     which was fine at demo scale and would not have stayed fine.
//
// The chain is lazy: nothing is sent until the query is awaited.
// =====================================================================

import { runData, type DataRequest, type DataResponse } from '@/lib/data-fn';

type Row = Record<string, unknown>;
type Filter = { col: string; op: string; val: unknown };

export type Result<T = unknown> = {
  data: T;
  error: { message: string; status?: number } | null;
  count?: number | null;
  truncated?: boolean;
};

class Query implements PromiseLike<Result<Row[] | Row | null>> {
  private body: {
    table: string;
    op: 'select' | 'insert' | 'update' | 'delete';
    columns?: string | null;
    filters: Filter[];
    order?: { col: string; asc: boolean } | null;
    limit?: number | null;
    rows?: Row | Row[];
    patch?: Row;
    countOnly?: boolean;
  };

  private wantSingle = false;
  private allowNone = false;

  constructor(table: string) {
    this.body = { table, op: 'select', filters: [] };
  }

  // ---- shape -------------------------------------------------------
  select(columns: string = '*', opts?: { count?: string; head?: boolean }) {
    this.body.columns = columns;
    // `{ count: 'exact', head: true }` asks for the number, not the rows.
    if (opts?.head || opts?.count) this.body.countOnly = true;
    return this;
  }

  insert(rows: Row | Row[]) { this.body.op = 'insert'; this.body.rows = rows; return this; }
  update(patch: Row)        { this.body.op = 'update'; this.body.patch = patch; return this; }
  delete()                  { this.body.op = 'delete'; return this; }

  // ---- filters -----------------------------------------------------
  private push(col: string, op: string, val: unknown) {
    this.body.filters.push({ col, op, val });
    return this;
  }

  eq(col: string, val: unknown)   { return this.push(col, 'eq', val); }
  neq(col: string, val: unknown)  { return this.push(col, 'neq', val); }
  gt(col: string, val: unknown)   { return this.push(col, 'gt', val); }
  gte(col: string, val: unknown)  { return this.push(col, 'gte', val); }
  lt(col: string, val: unknown)   { return this.push(col, 'lt', val); }
  lte(col: string, val: unknown)  { return this.push(col, 'lte', val); }
  like(col: string, val: unknown) { return this.push(col, 'like', val); }
  ilike(col: string, val: unknown){ return this.push(col, 'ilike', val); }
  in(col: string, vals: unknown[]){ return this.push(col, 'in', vals); }
  is(col: string, val: unknown)   { return this.push(col, 'is', val); }

  /**
   * `.not(col, 'in', '(a,b,c)')` — the only negation the screens use,
   * and it arrives with the list as a PostgREST-shaped string.
   */
  not(col: string, op: string, val: unknown) {
    if (op !== 'in') throw new Error(`not(${op}) is not supported`);
    const list = typeof val === 'string'
      ? val.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
      : (val as unknown[]);
    return this.push(col, 'notin', list);
  }

  match(obj: Row) {
    Object.entries(obj || {}).forEach(([col, val]) => this.eq(col, val));
    return this;
  }

  order(col: string, opts: { ascending?: boolean } = {}) {
    this.body.order = { col, asc: opts.ascending !== false };
    return this;
  }

  limit(n: number) { this.body.limit = n; return this; }

  // A second row is fetched deliberately: `single()` must be able to
  // tell "one" from "more than one" rather than silently taking the
  // first of many.
  single()      { this.wantSingle = true; this.allowNone = false; this.body.limit = 2; return this; }
  maybeSingle() { this.wantSingle = true; this.allowNone = true;  this.body.limit = 2; return this; }

  // ---- run ---------------------------------------------------------
  async run(): Promise<Result<Row[] | Row | null>> {
    const request = { kind: 'query', ...this.body } as DataRequest;
    let res: DataResponse;
    try {
      res = await runData({ data: request });
    } catch (err) {
      // A transport failure is still an error the call site can show,
      // not an exception it never expected.
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
    }

    if (res.error) return { data: null, error: res.error, count: null };

    if (this.body.countOnly) {
      return { data: null, count: res.count ?? 0, error: null };
    }

    const rows = (res.data as Row[]) ?? [];

    if (this.wantSingle) {
      if (rows.length > 1) {
        return { data: null, error: { message: 'expected a single row', status: 409 } };
      }
      if (!rows.length && !this.allowNone) {
        return { data: null, error: { message: 'no rows found', status: 404 } };
      }
      return { data: rows[0] ?? null, error: null };
    }

    return { data: rows, error: null, truncated: res.truncated };
  }

  then<R1 = Result<Row[] | Row | null>, R2 = never>(
    onfulfilled?: ((value: Result<Row[] | Row | null>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------
// Polling stand-in for realtime.
//
// There is no change feed behind this database, so "subscribe" becomes a
// timer that tells the view to re-fetch. Two screens use it, and both
// respond to any event by re-reading, so the payload is never inspected.
// ---------------------------------------------------------------------
const POLL_MS = Number(import.meta.env?.VITE_POLL_MS || 5000);

/** Nothing changes while nobody is looking. */
export const isHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * One tick: call each DISTINCT handler once, and nothing while hidden.
 *
 * Real change events name the table that changed, so watching two tables
 * means two subscriptions. A timer cannot tell them apart, and every
 * handler here means the same thing — "re-fetch" — so calling all of
 * them would re-fetch once per table watched, forever.
 */
export function fanOut(handlers: Array<(p: unknown) => void>, name: string, hidden: boolean): number {
  if (hidden) return 0;
  const seen = new Set<(p: unknown) => void>();
  for (const h of handlers || []) {
    if (seen.has(h)) continue;
    seen.add(h);
    try { h({ table: name }); } catch { /* the subscriber's problem */ }
  }
  return seen.size;
}

class Channel {
  private handlers: Array<(p: unknown) => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private name: string) {}

  on(_event: string, filterOrCb: unknown, cb?: (p: unknown) => void) {
    const handler = typeof filterOrCb === 'function' ? filterOrCb : cb;
    if (handler) this.handlers.push(handler as (p: unknown) => void);
    return this;
  }

  subscribe() {
    if (this.timer) return this;
    this.timer = setInterval(() => fanOut(this.handlers, this.name, isHidden()), POLL_MS);
    return this;
  }

  unsubscribe() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Result<unknown>> {
  try {
    const res = await runData({ data: { kind: 'rpc', fn, args } });
    return res.error ? { data: null, error: res.error } : { data: res.data, error: null };
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

export const db = {
  from: (table: string) => new Query(table),
  rpc,
  channel: (name: string) => new Channel(name),
  removeChannel: (ch: { unsubscribe?: () => void } | null | undefined) => { ch?.unsubscribe?.(); },
};

export default db;
