// =====================================================================
// Turning a request from the browser into SQL.
//
// Two rules make a generic endpoint safe, and both are absolute:
// identifiers are only ever emitted after passing the whitelist, and
// values are only ever emitted as bind parameters.
// =====================================================================

import {
  resolveTable, resolveColumn, resolveWritable,
  OPERATORS, HttpError, type TableDef,
} from './tables';

const MAX_LIMIT = 2000;
const MAX_ROWS_PER_WRITE = 500;

type Table = TableDef & { name: string };

export type Filter = { col: string; op: string; val: unknown };

export type QueryBody = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  columns?: string | null;
  filters?: Filter[];
  order?: { col: string; asc?: boolean } | null;
  limit?: number | null;
  rows?: Record<string, unknown> | Record<string, unknown>[];
  patch?: Record<string, unknown>;
  /** Ask for a count instead of rows, as `{ count: 'exact', head: true }` does. */
  countOnly?: boolean;
};

export type Built = { text: string; params: unknown[]; limit?: number };

function quote(id: string): string {
  // Belt and braces. Everything here already came from the whitelist,
  // but an identifier that could not survive this must never be emitted.
  if (!/^[a-z_][a-z0-9_]*$/.test(id)) throw new HttpError(400, `bad identifier: ${id}`);
  return `"${id}"`;
}

function projection(table: Table, columns?: string | null): string {
  if (!columns || columns === '*') return table.readable.map(quote).join(', ');
  const wanted = String(columns).split(',').map((c) => c.trim()).filter(Boolean);
  if (!wanted.length) throw new HttpError(400, 'empty column list');
  return wanted.map((c) => quote(resolveColumn(table, c))).join(', ');
}

function whereClause(table: Table, filters: Filter[] | undefined, params: unknown[]): string {
  if (!filters?.length) return '';
  const parts: string[] = [];

  for (const f of filters) {
    const col = quote(resolveColumn(table, f.col));

    if (f.op === 'is') {
      if (f.val !== null && f.val !== 'null') {
        throw new HttpError(400, 'the `is` operator only supports null');
      }
      parts.push(`${col} is null`);
      continue;
    }

    if (f.op === 'in' || f.op === 'notin') {
      const list = Array.isArray(f.val) ? f.val : [f.val];
      // An empty IN list is not an error, it is an empty result — and
      // the inverse for NOT IN. Emitting `in ()` would be a syntax error.
      if (!list.length) { parts.push(f.op === 'in' ? 'false' : 'true'); continue; }
      const holes = list.map((v) => `$${params.push(v)}`);
      parts.push(`${col} ${f.op === 'in' ? 'in' : 'not in'} (${holes.join(', ')})`);
      continue;
    }

    const sqlOp = OPERATORS[f.op];
    if (!sqlOp) throw new HttpError(400, `unknown operator: ${f.op}`);
    parts.push(`${col} ${sqlOp} $${params.push(f.val)}`);
  }

  return ` where ${parts.join(' and ')}`;
}

function orderLimit(table: Table, body: QueryBody): { text: string; applied: number } {
  let text = '';
  if (body.order?.col) {
    const dir = body.order.asc === false ? 'desc' : 'asc';
    text += ` order by ${quote(resolveColumn(table, body.order.col))} ${dir}`;
  }
  // A ceiling, and also the default. Every screen in this application
  // read unbounded until now; one prospect generating data was all it
  // would have taken to stream a whole table into a browser.
  const n = Number(body.limit);
  const applied = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT) : MAX_LIMIT;
  text += ` limit ${applied}`;
  return { text, applied };
}

// jsonb columns need every value JSON-encoded, strings included: `Daily`
// is not valid JSON but `"Daily"` is. Declared per table rather than
// guessed, because guessing fails at insert time.
function normalise(table: Table, col: string, v: unknown): unknown {
  if (v === undefined) return null;
  if (table.json.includes(col)) return JSON.stringify(v ?? null);
  return v;
}

function rowsToColumnsAndValues(table: Table, rows: QueryBody['rows'], params: unknown[]) {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  if (!list.length) throw new HttpError(400, 'no rows supplied');
  if (list.length > MAX_ROWS_PER_WRITE) {
    throw new HttpError(413, `too many rows (max ${MAX_ROWS_PER_WRITE})`);
  }
  // Union of keys, so a ragged payload still produces one statement;
  // a key a row omits falls back to the column default.
  const keys = [...new Set(list.flatMap((r) => Object.keys(r)))];
  const cols = keys.map((k) => resolveWritable(table, k));
  const tuples = list.map((r) => {
    const holes = keys.map((k, i) =>
      (k in r ? `$${params.push(normalise(table, cols[i], r[k]))}` : 'default'));
    return `(${holes.join(', ')})`;
  });
  return { cols, tuples };
}

export function build(body: QueryBody): Built {
  const table = resolveTable(body.table);
  const params: unknown[] = [];

  // Rows come back from a write only when the caller asked for them.
  const proj = body.columns ? projection(table, body.columns) : null;
  const returning = proj ? ` returning ${proj}` : '';

  switch (body.op) {
    case 'select': {
      const where = whereClause(table, body.filters, params);
      if (body.countOnly) {
        // `{ count: 'exact', head: true }`: the caller wants the number,
        // not the rows, so no ordering and no limit are applied.
        return { text: `select count(*)::int as count from ${quote(table.name)}${where}`, params };
      }
      const tail = orderLimit(table, body);
      return {
        text: `select ${proj || projection(table, '*')} from ${quote(table.name)}${where}${tail.text}`,
        params,
        limit: tail.applied,
      };
    }

    case 'insert': {
      const { cols, tuples } = rowsToColumnsAndValues(table, body.rows, params);
      return {
        text: `insert into ${quote(table.name)} (${cols.map(quote).join(', ')}) `
            + `values ${tuples.join(', ')}${returning}`,
        params,
      };
    }

    case 'update': {
      if (!body.patch || !Object.keys(body.patch).length) {
        throw new HttpError(400, 'update requires a patch');
      }
      // An unfiltered UPDATE would rewrite the whole tenant. Row-level
      // security would still contain it to one tenant, but that is not
      // the intent of any call site here, so refuse it outright.
      if (!body.filters?.length) throw new HttpError(400, 'update requires at least one filter');
      const sets = Object.entries(body.patch).map(([k, v]) => {
        const col = resolveWritable(table, k);
        return `${quote(col)} = $${params.push(normalise(table, col, v))}`;
      });
      const where = whereClause(table, body.filters, params);
      return {
        text: `update ${quote(table.name)} set ${sets.join(', ')}${where}${returning}`,
        params,
      };
    }

    case 'delete': {
      if (!body.filters?.length) throw new HttpError(400, 'delete requires at least one filter');
      const where = whereClause(table, body.filters, params);
      return { text: `delete from ${quote(table.name)}${where}${returning}`, params };
    }

    default:
      throw new HttpError(400, `unknown op: ${(body as { op: string }).op}`);
  }
}
