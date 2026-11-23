// =====================================================================
// A report as a file: CSV, Excel or PDF.
//
// Excel is written by hand — a workbook is a zip of a few XML parts — so
// the header can be styled, the pane frozen and the columns filterable
// without a spreadsheet library's weight in the server bundle. The PDF
// is a paginated table with the report's name, its filters and who made
// it on every page. All three take their values from formatValue(), so
// they agree with each other and with the screen.
// =====================================================================

import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatValue, type ColumnType } from '@/lib/report-catalogue';
import type { ReportResult } from './reports';

export type ExportMeta = { title: string; filters: string; generatedBy: string; generatedAt: Date };
export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export function fileName(title: string, format: ExportFormat, at = new Date()): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
  return `${slug}-${at.toISOString().slice(0, 10)}.${format}`;
}

export async function exportReport(result: ReportResult, meta: ExportMeta, format: ExportFormat): Promise<Uint8Array> {
  if (format === 'csv') return strToU8(toCsv(result));
  if (format === 'xlsx') return toXlsx(result, meta);
  return toPdf(result, meta);
}

// ---------------------------------------------------------------------
// CSV. A cell starting with = + - @ (or a tab or carriage return) is a
// formula to a spreadsheet; it is prefixed with a quote so it stays text.
// ---------------------------------------------------------------------
export function csvCell(value: string): string {
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(result: ReportResult): string {
  const head = result.columns.map((c) => csvCell(c.label)).join(',');
  const body = result.rows.map((r) => result.columns.map((c) => csvCell(formatValue(r[c.key], c.type))).join(','));
  // A byte-order mark, so Excel opens it as UTF-8.
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------
// Excel.
// ---------------------------------------------------------------------
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!))
  // Control characters are not allowed in XML at all.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colName(i: number): string {
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Style ids, matching styles.xml below: 1 header, 2 integer, 3 decimal,
// 4 money, 5 percent, 6 text, 7 title, 8 muted.
function cellXml(ref: string, v: unknown, type: ColumnType): string {
  if (v === null || v === undefined || v === '') return `<c r="${ref}" s="6"/>`;
  if (type === 'number' || type === 'money' || type === 'percent') {
    const n = Number(v);
    if (Number.isFinite(n)) {
      const style = type === 'money' ? 4 : type === 'percent' ? 5 : Number.isInteger(n) ? 2 : 3;
      return `<c r="${ref}" s="${style}"><v>${type === 'percent' ? n / 100 : n}</v></c>`;
    }
  }
  return `<c r="${ref}" s="6" t="inlineStr"><is><t xml:space="preserve">${xml(formatValue(v, type))}</t></is></c>`;
}

function textRow(r: number, values: string[], style: number): string {
  return `<row r="${r}">` + values.map((v, i) =>
    `<c r="${colName(i)}${r}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('') + '</row>';
}

export function toXlsx(result: ReportResult, meta: ExportMeta): Uint8Array {
  const cols = result.columns;
  const widths = cols.map((c) => {
    const longest = result.rows.slice(0, 500).reduce((m, r) => Math.max(m, formatValue(r[c.key], c.type).length), c.label.length);
    return Math.min(60, Math.max(10, longest + 2));
  });
  const last = colName(cols.length - 1);
  const rows: string[] = [textRow(1, cols.map((c) => c.label), 1)];
  result.rows.forEach((r, i) => {
    const n = i + 2;
    rows.push(`<row r="${n}">` + cols.map((c, j) => cellXml(`${colName(j)}${n}`, r[c.key], c.type)).join('') + '</row>');
  });

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A1:${last}${Math.max(1, result.rows.length + 1)}"/>
</worksheet>`;

  const about = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="90" customWidth="1"/></cols>
<sheetData>
${textRow(1, [meta.title], 7)}
${textRow(3, ['Filters', meta.filters], 8)}
${textRow(4, ['Rows', String(result.rows.length) + (result.truncated ? ' (first rows only — narrow the filters for the rest)' : '')], 8)}
${textRow(5, ['Generated', formatValue(meta.generatedAt.toISOString(), 'datetime') + ' (Dhaka)'], 8)}
${textRow(6, ['By', meta.generatedBy], 8)}
</sheetData></worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0%"/></numFmts>
<fonts count="4">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  <font><b/><sz val="14"/><name val="Calibri"/></font>
  <font><sz val="11"/><color rgb="FF52525B"/><name val="Calibri"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

  const sheetName = xml(meta.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/><sheet name="About" sheetId="2" r:id="rId2"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheetName.replace(/'/g, "''")}'!$A$1:$${last}$${Math.max(1, result.rows.length + 1)}</definedName></definedNames>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/worksheets/sheet2.xml': strToU8(about),
    'xl/styles.xml': strToU8(styles),
  });
}

// ---------------------------------------------------------------------
// PDF.
// ---------------------------------------------------------------------
/** The standard fonts speak WinAnsi only; anything else becomes a question mark rather than an error. */
export function pdfSafe(s: string): string {
  return s.replace(/[^\x20-\x7E -ÿ–—‘’“”•…€]/g, '?');
}

export function fitText(text: string, font: PDFFont, size: number, width: number): string {
  let t = pdfSafe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > width) t = t.slice(0, -1);
  return t + '…';
}

export const BRAND = rgb(0.31, 0.27, 0.9);
export const INK = rgb(0.09, 0.09, 0.11);
export const MUTED = rgb(0.44, 0.44, 0.48);
export const RULE = rgb(0.89, 0.89, 0.91);
export const ZEBRA = rgb(0.98, 0.98, 0.98);

/** The check mark the portal uses, drawn. */
export function drawMark(page: PDFPage, x: number, y: number, size: number) {
  page.drawRectangle({ x, y, width: size, height: size, color: BRAND });
  const s = size / 100;
  page.drawLine({ start: { x: x + 28 * s, y: y + (100 - 52) * s }, end: { x: x + 44 * s, y: y + (100 - 68) * s }, thickness: 11 * s, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: x + 44 * s, y: y + (100 - 68) * s }, end: { x: x + 74 * s, y: y + (100 - 32) * s }, thickness: 11 * s, color: rgb(1, 1, 1) });
}

export async function toPdf(result: ReportResult, meta: ExportMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(meta.title));
  doc.setCreator('Admin Services Portal');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 842, H = 595, M = 36, size = 8, rowH = 15;
  const cols = result.columns;
  // Widths in proportion to what each column holds, within bounds.
  const want = cols.map((c) => {
    const sample = result.rows.slice(0, 200).map((r) => formatValue(r[c.key], c.type));
    const longest = Math.max(font.widthOfTextAtSize(pdfSafe(c.label), size), ...sample.map((v) => font.widthOfTextAtSize(pdfSafe(v), size)));
    return Math.min(180, Math.max(40, longest + 10));
  });
  const total = want.reduce((a, b) => a + b, 0);
  const widths = want.map((w) => (w / total) * (W - 2 * M));
  const numeric = (t: ColumnType) => t === 'number' || t === 'money' || t === 'percent';

  let page: PDFPage = doc.addPage([W, H]);
  let y = 0;
  const pages: PDFPage[] = [];

  const header = (first: boolean) => {
    pages.push(page);
    drawMark(page, M, H - M - 18, 18);
    page.drawText(fitText(meta.title, bold, 14, W - 2 * M - 30), { x: M + 26, y: H - M - 14, size: 14, font: bold, color: INK });
    page.drawText(fitText(meta.filters, font, 8, W - 2 * M - 30), { x: M + 26, y: H - M - 26, size: 8, font, color: MUTED });
    y = H - M - 48;
    if (first && result.truncated) {
      page.drawText('Only the first rows are shown. Narrow the filters to see the rest.', { x: M, y, size: 8, font, color: rgb(0.7, 0.33, 0.04) });
      y -= 14;
    }
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: rowH, color: BRAND });
    let x = M;
    cols.forEach((c, i) => {
      const label = fitText(c.label, bold, size, widths[i] - 8);
      const tx = numeric(c.type) ? x + widths[i] - 4 - bold.widthOfTextAtSize(label, size) : x + 4;
      page.drawText(label, { x: tx, y, size, font: bold, color: rgb(1, 1, 1) });
      x += widths[i];
    });
    y -= rowH;
  };

  header(true);
  if (!result.rows.length) {
    page.drawText('Nothing matches these filters.', { x: M, y: y - 6, size: 10, font, color: MUTED });
  }
  result.rows.forEach((r, i) => {
    if (y < M + 24) { page = doc.addPage([W, H]); header(false); }
    if (i % 2 === 1) page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: rowH, color: ZEBRA });
    let x = M;
    cols.forEach((c, j) => {
      const v = fitText(formatValue(r[c.key], c.type), font, size, widths[j] - 8);
      const tx = numeric(c.type) ? x + widths[j] - 4 - font.widthOfTextAtSize(v, size) : x + 4;
      page.drawText(v, { x: tx, y, size, font, color: INK });
      x += widths[j];
    });
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.4, color: RULE });
    y -= rowH;
  });

  const foot = `${result.rows.length} row${result.rows.length === 1 ? '' : 's'} · generated ${formatValue(meta.generatedAt.toISOString(), 'datetime')} (Dhaka) by ${meta.generatedBy}`;
  pages.forEach((p, i) => {
    p.drawText(fitText(foot, font, 7, W / 2), { x: M, y: M - 14, size: 7, font, color: MUTED });
    const n = `Page ${i + 1} of ${pages.length}`;
    p.drawText(n, { x: W - M - font.widthOfTextAtSize(n, 7), y: M - 14, size: 7, font, color: MUTED });
  });
  return doc.save();
}
