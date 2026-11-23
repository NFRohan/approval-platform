// =====================================================================
// A ManageEngine ServiceDesk Plus export, read into the rows
// public.import_legacy_tickets takes.
//
// "Export as CSV" from the Requests list names its columns after the
// list view, so several spellings of each are accepted. Dates come as
// the instance is set to show them — "12/03/2019 10:15", "Mar 12, 2019
// 10:15 AM", ISO, or milliseconds from the API — and local times are
// read as Dhaka's.
// =====================================================================

import { parseCsv } from './hr-file';
import type { LegacyRow } from './integrations-fn';

const COLUMNS: Record<keyof LegacyRow, string[]> = {
  ref: ['request id', 'requestid', 'id', 'request number', 'ticket id', 'ticket number', 'display id'],
  subject: ['subject', 'title', 'request title'],
  description: ['description', 'details', 'request details'],
  category: ['category', 'service category', 'request type'],
  requester: ['requester', 'requester name', 'requester email', 'requested by', 'created by'],
  technician: ['technician', 'assigned to', 'technician name'],
  status: ['request status', 'status'],
  priority: ['priority'],
  created: ['created time', 'created date', 'created on', 'created', 'requested time'],
  closed: ['completed time', 'closed time', 'resolved time', 'closed date', 'completed date', 'closed', 'resolved date'],
  resolution: ['resolution', 'solution', 'resolution details'],
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date as ServiceDesk writes one, to ISO 8601 — or null. */
export function legacyDate(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim();
  if (!v || v === '-' || v.toLowerCase() === 'n/a') return null;
  if (/^\d{12,14}$/.test(v)) return new Date(Number(v)).toISOString();
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) {
    const d = new Date(v.length === 10 ? `${v}T00:00:00+06:00` : /Z|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}+06:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const at = (y: number, mo: number, d: number, h = 0, mi = 0, ampm?: string) => {
    let hour = h;
    if (ampm) { const pm = ampm.toLowerCase() === 'pm'; if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12; }
    const date = new Date(Date.UTC(y, mo - 1, d, hour - 6, mi));
    return y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  // 2019-03-12 10:15[:00]
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v);
  if (m) return at(+m[1], +m[2], +m[3], +m[4], +m[5]);
  // 12/03/2019 [10:15 [AM]] — day first, as Bangladesh writes it
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?)?$/i.exec(v);
  if (m) return at(+m[3], +m[2], +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6]);
  // Mar 12, 2019 [10:15 AM]
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?)?$/i.exec(v);
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    return at(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6]);
  }
  return null;
}

export type LegacyParse = {
  rows: LegacyRow[];
  columns: Partial<Record<keyof LegacyRow, string>>;
  missing: string[];
  unreadableDates: number;
};

export function readLegacyFile(text: string): LegacyParse {
  const grid = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim() !== ''));
  if (grid.length === 0) return { rows: [], columns: {}, missing: ['Request ID', 'Subject'], unreadableDates: 0 };
  const header = grid[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const where: Partial<Record<keyof LegacyRow, number>> = {};
  const columns: Partial<Record<keyof LegacyRow, string>> = {};
  for (const key of Object.keys(COLUMNS) as (keyof LegacyRow)[]) {
    const i = header.findIndex((h) => COLUMNS[key].includes(h));
    if (i >= 0) { where[key] = i; columns[key] = grid[0][i].trim(); }
  }
  const missing = [where.ref === undefined ? 'Request ID' : null, where.subject === undefined ? 'Subject' : null,
    where.created === undefined ? 'Created Time' : null].filter(Boolean) as string[];
  let unreadableDates = 0;
  const rows = grid.slice(1).map((r) => {
    const get = (k: keyof LegacyRow) => (where[k] === undefined ? '' : (r[where[k]!] ?? '').trim());
    const created = legacyDate(get('created'));
    const closed = legacyDate(get('closed'));
    if ((get('created') && !created) || (get('closed') && !closed)) unreadableDates++;
    return {
      ref: get('ref'), subject: get('subject'), description: get('description'), category: get('category'),
      requester: get('requester'), technician: get('technician'), status: get('status'), priority: get('priority'),
      created: created ?? '', closed: closed ?? '', resolution: get('resolution'),
    } satisfies LegacyRow;
  });
  return { rows, columns, missing, unreadableDates };
}

const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const dhaka = (iso: string | undefined) => {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 6 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/** Rows back out as ServiceDesk's own export would have them. */
export function legacyCsv(rows: LegacyRow[]): string {
  const head = ['Request ID', 'Subject', 'Description', 'Category', 'Requester', 'Technician', 'Request Status', 'Priority',
    'Created Time', 'Completed Time', 'Resolution'];
  const lines = rows.map((r) => [r.ref, r.subject, r.description ?? '', r.category ?? '', r.requester ?? '', r.technician ?? '',
    r.status ?? '', r.priority ?? '', dhaka(r.created), dhaka(r.closed), r.resolution ?? ''].map((x) => q(String(x))).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
