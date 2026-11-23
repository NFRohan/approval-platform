// =====================================================================
// The payment top sheet.
//
// "Payment Top sheet format — PO row needs to be wrap texted." The page
// finance attaches to a payment: who asked, what for, the purchase order
// lines with their descriptions wrapped in full rather than cut off, the
// total in figures and in words (lakh and crore, as Bangladesh writes
// them), and every approval with its date and signature.
// =====================================================================

import type pg from 'pg';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { formatValue } from '@/lib/report-catalogue';
import { BRAND, INK, MUTED, RULE, ZEBRA, drawMark, fitText, pdfSafe } from './export';

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function under100(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
}
function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? under100(r) : ''].filter(Boolean).join(' ');
}

/** 12,34,56,789.50 → "Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine Taka and Fifty Paisa only". */
export function takaInWords(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '';
  const whole = Math.floor(amount);
  const paisa = Math.round((amount - whole) * 100);
  const parts: string[] = [];
  let n = whole;
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${crore >= 1000 ? takaInWords(crore).replace(/ Taka.*$/, '') : under1000(crore)} Crore`);
  if (lakh) parts.push(`${under100(lakh)} Lakh`);
  if (thousand) parts.push(`${under100(thousand)} Thousand`);
  if (n) parts.push(under1000(n));
  const words = parts.join(' ') || 'Zero';
  return `${words} Taka${paisa ? ` and ${under100(paisa)} Paisa` : ''} only`;
}

/** Lines of text no wider than `width`, breaking long words if it must. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of pdfSafe(text).split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width) {
        // A word longer than the column — a PO reference, a URL — is broken.
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = w; } else line = next;
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

export type PoLine = { po: string; description: string; amount: number | null };

/** "PO-1 | description | 1,000" per line; anything less, as best it can. */
export function parsePoLines(text: string | null | undefined): PoLine[] {
  return (text ?? '').split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const cells = l.split('|').map((c) => c.trim());
    const amt = cells.length > 1 ? Number(cells[cells.length - 1].replace(/[^0-9.]/g, '')) : NaN;
    if (cells.length >= 3) return { po: cells[0], description: cells.slice(1, -1).join(' | '), amount: Number.isFinite(amt) ? amt : null };
    if (cells.length === 2) return { po: '', description: cells[0], amount: Number.isFinite(amt) ? amt : null };
    return { po: '', description: cells[0], amount: null };
  });
}

export async function loadTopSheet(client: pg.PoolClient, submissionId: string) {
  const { rows: [req] } = await client.query(
    `select r.*, e.designation as requester_title from public.report_requests r
       left join public.employees e on e.employee_id = r.requester_id and e.tenant_id = r.tenant_id
      where r.id = $1`, [submissionId]);
  if (!req) return null;
  const { rows: answers } = await client.query(
    'select field_name, value from public.submission_values where submission_id = $1', [submissionId]);
  const a = Object.fromEntries(answers.map((r) => [r.field_name, r.value as string]));
  const { rows: steps } = await client.query(
    `select rs.stage, rs.approver, rs.status, rs.acted_at, ar.signature, e.designation
       from public.report_steps rs
       join public.approval_requests ar on ar.id = rs.id
       left join public.employees e on e.employee_id = rs.approver_id and e.tenant_id = rs.tenant_id
      where rs.subject_id = $1 and rs.status in ('approved', 'pending', 'rejected')
      order by ar.step_index, ar.lane, ar.lane_step`, [submissionId]);
  const { rows: [t] } = await client.query('select name from public.tenants where id = $1', [req.tenant_id]);
  return { req, a, steps, org: t?.name as string | undefined };
}

export async function topSheetPdf(data: NonNullable<Awaited<ReturnType<typeof loadTopSheet>>>): Promise<Uint8Array> {
  const { req, a, steps } = data;
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`Payment top sheet ${req.reference}`));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 42;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  // ------------------------------------------------------------- header
  drawMark(page, M, y - 22, 22);
  page.drawText('PAYMENT TOP SHEET', { x: M + 32, y: y - 9, size: 12, font: bold, color: INK });
  page.drawText(fitText(data.org && !/^(template|local qa)$/i.test(data.org) ? data.org : 'Admin Services Portal', font, 8.5, 260),
    { x: M + 32, y: y - 21, size: 8.5, font, color: MUTED });
  const right = (text: string, yy: number, f: PDFFont, size: number, color = INK) =>
    page.drawText(text, { x: W - M - f.widthOfTextAtSize(text, size), y: yy, size, font: f, color });
  right(pdfSafe(req.reference ?? ''), y - 9, bold, 11, BRAND);
  right(`Date: ${formatValue(new Date().toISOString(), 'date')}`, y - 21, font, 8.5, MUTED);
  y -= 44;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: INK });
  y -= 18;

  // ------------------------------------------------------------- particulars
  const payee = a['Vendor'] ?? a['Payee'] ?? a['Counterparty'] ?? a['Supplier'] ?? a['Project'] ?? '—';
  const facts: [string, string][] = [
    ['Payee / purpose', payee],
    ['Request', req.form],
    ['Requested by', [req.requester, req.requester_title].filter(Boolean).join(', ')],
    ['Department', req.department ?? '—'],
    ['Cost center', a['Cost center'] ?? '—'],
    ['GL code', a['GL code'] ?? '—'],
    ['Classification', a['Classification'] ?? '—'],
    ['Submitted', formatValue(req.submitted_at, 'date')],
  ];
  const colW = (W - 2 * M) / 2;
  facts.forEach(([k, v], i) => {
    const x = M + (i % 2) * colW;
    page.drawText(pdfSafe(k), { x, y, size: 7.5, font, color: MUTED });
    page.drawText(fitText(v, bold, 9.5, colW - 14), { x, y: y - 11, size: 9.5, font: bold, color: INK });
    if (i % 2 === 1) y -= 26;
  });
  y -= 10;

  // ------------------------------------------------------------- PO lines
  let lines = parsePoLines(a['PO lines']);
  const total = Number(req.amount ?? 0) || lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  if (!lines.length) {
    lines = [{ po: '', description: a['Justification'] ?? a['Purpose'] ?? a['Business case'] ?? a['Description'] ?? req.form, amount: total || null }];
  }
  const cols = [{ h: 'SL', w: 26 }, { h: 'PO number', w: 92 }, { h: 'Description', w: W - 2 * M - 26 - 92 - 100 }, { h: 'Amount (BDT)', w: 100 }];
  const size = 9, lh = 12;
  const header = () => {
    page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 18, color: BRAND });
    let x = M;
    cols.forEach((c, i) => {
      const tx = i === 3 ? x + c.w - 6 - bold.widthOfTextAtSize(c.h, 8.5) : x + 6;
      page.drawText(c.h, { x: tx, y, size: 8.5, font: bold, color: rgb(1, 1, 1) });
      x += c.w;
    });
    y -= 20;
  };
  header();
  lines.forEach((l, i) => {
    // The description wraps in full: the point of the format.
    const desc = wrapText(l.description, font, size, cols[2].w - 12);
    const po = wrapText(l.po || '—', font, size, cols[1].w - 12);
    const h = Math.max(desc.length, po.length) * lh + 8;
    if (y - h < M + 170) { page = doc.addPage([W, H]); y = H - M; header(); }
    if (i % 2 === 1) page.drawRectangle({ x: M, y: y - h + lh - 2, width: W - 2 * M, height: h, color: ZEBRA });
    page.drawText(String(i + 1), { x: M + 6, y, size, font, color: INK });
    po.forEach((t, j) => page.drawText(t, { x: M + cols[0].w + 6, y: y - j * lh, size, font, color: INK }));
    desc.forEach((t, j) => page.drawText(t, { x: M + cols[0].w + cols[1].w + 6, y: y - j * lh, size, font, color: INK }));
    if (l.amount !== null) {
      const s = formatValue(l.amount, 'money');
      page.drawText(s, { x: W - M - 6 - font.widthOfTextAtSize(s, size), y, size, font, color: INK });
    }
    y -= h;
    page.drawLine({ start: { x: M, y: y + lh - 4 }, end: { x: W - M, y: y + lh - 4 }, thickness: 0.4, color: RULE });
  });
  y -= 4;
  page.drawText('Total', { x: M + cols[0].w + cols[1].w + 6, y, size: 10, font: bold, color: INK });
  const tot = formatValue(total, 'money');
  page.drawText(tot, { x: W - M - 6 - bold.widthOfTextAtSize(tot, 10), y, size: 10, font: bold, color: INK });
  y -= 18;
  const words = wrapText(`In words: ${takaInWords(total)}`, font, 9, W - 2 * M);
  words.forEach((t) => { page.drawText(t, { x: M, y, size: 9, font, color: INK }); y -= 12; });
  y -= 14;

  // ------------------------------------------------------------- approvals
  page.drawText('APPROVALS', { x: M, y, size: 8.5, font: bold, color: MUTED });
  y -= 8;
  const images = new Map<string, PDFImage>();
  for (const s of steps) {
    if (s.signature?.startsWith('data:image/png;base64,') && !images.has(s.signature)) {
      try { images.set(s.signature, await doc.embedPng(Buffer.from(s.signature.split(',')[1], 'base64'))); } catch { /* unreadable */ }
    }
  }
  const perRow = 4, boxW = (W - 2 * M - (perRow - 1) * 8) / perRow, boxH = 78;
  steps.forEach((s, i) => {
    if (i % perRow === 0) {
      if (y - boxH < M + 10) { page = doc.addPage([W, H]); y = H - M; }
      y -= boxH + (i ? 8 : 0);
    }
    const x = M + (i % perRow) * (boxW + 8);
    page.drawRectangle({ x, y, width: boxW, height: boxH, borderColor: RULE, borderWidth: 0.8 });
    const sig = s.signature ? images.get(s.signature) : undefined;
    if (sig) {
      const k = Math.min((boxW - 16) / sig.width, 26 / sig.height);
      page.drawImage(sig, { x: x + 8, y: y + 40, width: sig.width * k, height: sig.height * k });
    } else if (s.status === 'approved') {
      page.drawText('Approved in the system', { x: x + 8, y: y + 50, size: 7, font, color: rgb(0.08, 0.5, 0.24) });
    } else {
      page.drawText(s.status === 'rejected' ? 'Rejected' : 'Awaiting approval', { x: x + 8, y: y + 50, size: 7, font, color: MUTED });
    }
    page.drawLine({ start: { x: x + 8, y: y + 36 }, end: { x: x + boxW - 8, y: y + 36 }, thickness: 0.5, color: MUTED });
    page.drawText(fitText(s.approver ?? '—', bold, 8, boxW - 16), { x: x + 8, y: y + 25, size: 8, font: bold, color: INK });
    page.drawText(fitText(s.designation ?? s.stage ?? '', font, 7, boxW - 16), { x: x + 8, y: y + 15, size: 7, font, color: MUTED });
    page.drawText(s.acted_at ? formatValue(new Date(s.acted_at).toISOString(), 'date') : '', { x: x + 8, y: y + 5, size: 7, font, color: MUTED });
  });

  doc.getPages().forEach((p, i, all) => {
    const t = `${req.reference ?? ''} · page ${i + 1} of ${all.length}`;
    p.drawText(pdfSafe(t), { x: W - M - font.widthOfTextAtSize(pdfSafe(t), 7), y: M - 18, size: 7, font, color: MUTED });
  });
  return doc.save();
}
