// =====================================================================
// A list on screen, as an Excel workbook.
//
// "Per-ticket dashboard ... with export to Excel." The lists people keep
// of their own requests and decisions download as CSV in the browser;
// this makes the same rows a real .xlsx with the report exporter, so a
// list and a report come out alike. Only what the person already sees
// is sent, and only a signed-in person may ask.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { resolveContext } from '@/server/db';
import { toXlsx } from '@/server/export';

type Column = { key: string; label: string; type?: 'text' | 'date' | 'datetime' | 'number' | 'money' };

export const exportSheet = createServerFn({ method: 'POST' })
  .inputValidator((input: { title: string; columns: Column[]; rows: Record<string, string | number | null>[] }) => {
    if (!Array.isArray(input?.columns) || !input.columns.length || input.columns.length > 40) throw new Error('columns, please');
    if (!Array.isArray(input.rows) || input.rows.length > 5000) throw new Error('at most 5,000 rows');
    return input;
  })
  .handler(async ({ data }): Promise<{ ok: true; base64: string } | { ok: false; error: string }> => {
    let ctx;
    try { ctx = await resolveContext(); } catch { return { ok: false, error: 'Sign in again.' }; }
    const columns = data.columns.map((c) => ({ key: String(c.key), label: String(c.label).slice(0, 80), type: c.type ?? 'text' }));
    const rows = data.rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, r[c.key] ?? null])));
    const bytes = toXlsx({ columns, rows, truncated: false }, {
      title: String(data.title ?? 'Export').slice(0, 120), filters: 'As shown on screen',
      generatedBy: ctx.employeeId ?? 'you', generatedAt: new Date(),
    });
    return { ok: true, base64: Buffer.from(bytes).toString('base64') };
  });

/** In the browser: ask for the workbook and save it. */
export async function downloadSheet(filename: string, title: string, columns: Column[], rows: Record<string, string | number | null>[]) {
  const r = await exportSheet({ data: { title, columns, rows } });
  if (!r.ok) throw new Error(r.error);
  const bin = atob(r.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
