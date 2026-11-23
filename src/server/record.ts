// =====================================================================
// The approval record: a request as a PDF.
//
// "Mail with PDF copy on approval." What was asked, every answer, and
// every step — who decided, when, what they said, and the signature they
// drew where the step required one. Attached to the requester's email
// when a request completes, and downloadable from its status page.
//
// Read through withContext like everything else, so a record can only be
// made of a request the person asking can see.
// =====================================================================

import type pg from 'pg';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { formatValue } from '@/lib/report-catalogue';
import { BRAND, INK, MUTED, RULE, ZEBRA, drawMark, fitText, pdfSafe } from './export';

type Step = {
  stage: string; approver: string | null; approver_department: string | null; status: string;
  acted_at: Date | null; deadline_at: Date | null; comment: string | null; signature: string | null;
};

export async function loadRecord(client: pg.PoolClient, submissionId: string) {
  const { rows: [req] } = await client.query(
    `select r.*, e.designation as requester_title
       from public.report_requests r
       left join public.employees e on e.employee_id = r.requester_id and e.tenant_id = r.tenant_id
      where r.id = $1`, [submissionId]);
  if (!req) return null;
  const { rows: answers } = await client.query(
    `select v.field_name, v.value
       from public.submission_values v
       join public.form_submissions s on s.id = v.submission_id
       left join public.form_fields f on f.form_template_id = s.form_template_id and f.field_name = v.field_name
      where v.submission_id = $1 and coalesce(v.value, '') <> ''
        and coalesce(f.field_type, '') not in ('file', 'signature', 'section_header')
      order by f.order_index nulls last, v.field_name`, [submissionId]);
  const { rows: steps } = await client.query(
    `select rs.stage, rs.approver, rs.approver_department, rs.status, rs.acted_at, rs.deadline_at, rs.comment, ar.signature
       from public.report_steps rs
       join public.approval_requests ar on ar.id = rs.id
      where rs.subject_id = $1 and rs.status <> 'skipped'
      order by ar.step_index, ar.lane, ar.lane_step`, [submissionId]);
  return { req, answers: answers as { field_name: string; value: string }[], steps: steps as Step[] };
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = pdfSafe(text).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const DECISION: Record<string, { word: string; color: ReturnType<typeof rgb> }> = {
  approved: { word: 'Approved', color: rgb(0.08, 0.5, 0.24) },
  rejected: { word: 'Rejected', color: rgb(0.73, 0.11, 0.11) },
  pending: { word: 'Waiting', color: rgb(0.71, 0.33, 0.04) },
  clarification: { word: 'Clarification asked', color: rgb(0.71, 0.33, 0.04) },
  waiting: { word: 'Not yet asked', color: MUTED },
};

export async function recordPdf(data: NonNullable<Awaited<ReturnType<typeof loadRecord>>>, link: string | null): Promise<Uint8Array> {
  const { req, answers, steps } = data;
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${req.reference} — ${req.form}`));
  doc.setCreator('Admin Services Portal');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 44;
  let page: PDFPage = doc.addPage([W, H]);
  const pages = [page];
  let y = H - M;

  const ensure = (h: number) => {
    if (y - h < M + 20) { page = doc.addPage([W, H]); pages.push(page); y = H - M; }
  };
  const heading = (text: string) => {
    ensure(34);
    y -= 14;
    page.drawText(pdfSafe(text.toUpperCase()), { x: M, y, size: 8.5, font: bold, color: MUTED });
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: RULE });
    y -= 14;
  };

  // ------------------------------------------------------------- header
  drawMark(page, M, y - 22, 22);
  page.drawText('Approval record', { x: M + 32, y: y - 9, size: 9, font, color: MUTED });
  page.drawText(fitText(`${req.form}`, bold, 16, W - 2 * M - 160), { x: M + 32, y: y - 26, size: 16, font: bold, color: INK });
  const ref = pdfSafe(req.reference ?? '');
  page.drawText(ref, { x: W - M - bold.widthOfTextAtSize(ref, 12), y: y - 10, size: 12, font: bold, color: BRAND });
  const status = formatValue(req.status, 'status');
  const sw = bold.widthOfTextAtSize(status, 9) + 14;
  const done = req.status === 'completed';
  page.drawRectangle({ x: W - M - sw, y: y - 30, width: sw, height: 15,
    color: done ? rgb(0.94, 0.99, 0.95) : req.status === 'rejected' ? rgb(1, 0.95, 0.95) : rgb(0.96, 0.96, 0.97) });
  page.drawText(status, { x: W - M - sw + 7, y: y - 26, size: 9, font: bold,
    color: done ? rgb(0.08, 0.5, 0.24) : req.status === 'rejected' ? rgb(0.73, 0.11, 0.11) : INK });
  y -= 52;

  // ------------------------------------------------------------ summary
  const facts: [string, string][] = [
    ['Requested by', [req.requester, req.requester_title].filter(Boolean).join(', ')],
    ['Department', req.department ?? '—'],
    ['Submitted', formatValue(req.submitted_at, 'datetime')],
    ['Decided', req.decided_at ? formatValue(req.decided_at, 'datetime') : '—'],
    ['Priority', String(req.priority ?? 'normal').replace(/^./, (c: string) => c.toUpperCase())],
    ['Cycle time', req.cycle_days != null ? `${Number(req.cycle_days)} days` : '—'],
  ];
  if (req.amount != null && Number(req.amount) > 0) facts.push(['Amount', `BDT ${formatValue(req.amount, 'money')}`]);
  if (req.flag) facts.push(['Route', String(req.flag)]);
  const colW = (W - 2 * M) / 2;
  facts.forEach(([k, v], i) => {
    const x = M + (i % 2) * colW;
    if (i % 2 === 0 && i > 0) y -= 26;
    page.drawText(pdfSafe(k), { x, y, size: 8, font, color: MUTED });
    page.drawText(fitText(v || '—', bold, 10, colW - 12), { x, y: y - 12, size: 10, font: bold, color: INK });
  });
  y -= 30;

  // ------------------------------------------------------------ answers
  heading('What was asked');
  const keyW = 170;
  answers.forEach((a, i) => {
    const lines = wrap(formatValue(a.value, /^\d{4}-\d{2}-\d{2}$/.test(a.value) ? 'date' : 'text'), font, 9.5, W - 2 * M - keyW - 8);
    const h = Math.max(1, lines.length) * 12 + 8;
    ensure(h);
    if (i % 2 === 0) page.drawRectangle({ x: M, y: y - h + 12, width: W - 2 * M, height: h, color: ZEBRA });
    page.drawText(fitText(a.field_name, font, 9, keyW - 8), { x: M + 6, y, size: 9, font, color: MUTED });
    lines.forEach((l, j) => page.drawText(l, { x: M + keyW, y: y - j * 12, size: 9.5, font, color: INK }));
    y -= h;
  });
  if (!answers.length) { page.drawText('No answers recorded.', { x: M, y, size: 9, font, color: MUTED }); y -= 14; }

  // -------------------------------------------------------------- trail
  heading('Approvals');
  const images = new Map<string, PDFImage>();
  for (const s of steps) {
    if (s.signature && /^data:image\/png;base64,/.test(s.signature) && !images.has(s.signature)) {
      try { images.set(s.signature, await doc.embedPng(Buffer.from(s.signature.split(',')[1], 'base64'))); } catch { /* unreadable */ }
    }
  }
  steps.forEach((s, i) => {
    const sig = s.signature ? images.get(s.signature) : undefined;
    const commentLines = s.comment ? wrap(`"${s.comment}"`, font, 8.5, W - 2 * M - 220) : [];
    const h = Math.max(34, 26 + commentLines.length * 11, sig ? 46 : 0);
    ensure(h + 6);
    const d = DECISION[s.status] ?? { word: s.status, color: MUTED };
    page.drawCircle({ x: M + 6, y: y - 3, size: 4.5, color: d.color });
    if (i < steps.length - 1) page.drawLine({ start: { x: M + 6, y: y - 9 }, end: { x: M + 6, y: y - h + 2 }, thickness: 0.8, color: RULE });
    page.drawText(fitText(s.approver ?? 'Unassigned', bold, 10, 200), { x: M + 18, y: y - 6, size: 10, font: bold, color: INK });
    page.drawText(fitText([s.stage, s.approver_department].filter(Boolean).join(' · '), font, 8, 200), { x: M + 18, y: y - 18, size: 8, font, color: MUTED });
    page.drawText(d.word, { x: M + 230, y: y - 6, size: 9.5, font: bold, color: d.color });
    const when = s.acted_at ? formatValue(s.acted_at.toISOString(), 'datetime')
      : s.deadline_at ? `due ${formatValue(s.deadline_at.toISOString(), 'datetime')}` : '';
    page.drawText(pdfSafe(when), { x: M + 230, y: y - 18, size: 8, font, color: MUTED });
    commentLines.forEach((l, j) => page.drawText(l, { x: M + 230, y: y - 30 - j * 11, size: 8.5, font, color: INK }));
    if (sig) {
      const scale = Math.min(110 / sig.width, 36 / sig.height);
      page.drawImage(sig, { x: W - M - sig.width * scale, y: y - 4 - sig.height * scale, width: sig.width * scale, height: sig.height * scale });
      page.drawText('signed', { x: W - M - font.widthOfTextAtSize('signed', 7), y: y - 8 - sig.height * scale - 6, size: 7, font, color: MUTED });
    }
    y -= h + 6;
  });

  const foot = pdfSafe(`Generated ${formatValue(new Date().toISOString(), 'datetime')} (Dhaka)` + (link ? ` · ${link}` : ''));
  pages.forEach((p, i) => {
    p.drawText(fitText(foot, font, 7, W - 2 * M - 60), { x: M, y: M - 16, size: 7, font, color: MUTED });
    const n = `${i + 1} / ${pages.length}`;
    p.drawText(n, { x: W - M - font.widthOfTextAtSize(n, 7), y: M - 16, size: 7, font, color: MUTED });
  });
  return doc.save();
}
