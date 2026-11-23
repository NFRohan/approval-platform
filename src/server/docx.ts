// =====================================================================
// Reading a Word document into a form.
//
// "Upon uploading of vetted NFA and Business Case by requestor, system
// should be able to pull all the necessary data from word file and
// populate in the portal template fields automatically. System should be
// able to recognise and populate multiple business cases from a single
// NFA."
//
// A .docx is a zip of XML; the body is paragraphs and tables in order.
// What an NFA says comes as "Label: value" lines and as two-column
// tables, and a heading "Business Case 1 …" starts a case of its own. So:
// read the blocks in order, gather label/value pairs, split them by
// business case, and match each label to the form's questions — exactly,
// by a known synonym, or by the words they share — converting each value
// to what its question takes.
// =====================================================================

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Extraction, Match, Pair } from '@/lib/docx-types';

export type { Extraction, Match, Pair };

export type Block =
  | { type: 'para'; text: string; heading: boolean }
  | { type: 'table'; rows: string[][] };

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

function paraText(xml: string): string {
  // Text runs, tabs and breaks, in order; a paragraph end inside a table
  // cell is a space.
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else out += m[0] === '<w:tab/>' ? '\t' : ' ';
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/** The body's top-level paragraphs and tables, in order. */
export function readBlocks(documentXml: string): Block[] {
  const body = documentXml.slice(documentXml.indexOf('<w:body'), documentXml.lastIndexOf('</w:body>'));
  const blocks: Block[] = [];
  let i = 0;
  while (i < body.length) {
    const p = body.indexOf('<w:p', i);
    const t = body.indexOf('<w:tbl>', i) >= 0 ? body.indexOf('<w:tbl>', i) : body.indexOf('<w:tbl ', i);
    const nextTable = t >= 0 && (p < 0 || t < p);
    if (p < 0 && t < 0) break;
    if (nextTable) {
      // Find the matching close, counting nested tables.
      let depth = 0, j = t;
      for (;;) {
        const open = body.indexOf('<w:tbl', j + 1);
        const close = body.indexOf('</w:tbl>', j + 1);
        if (close < 0) { j = body.length; break; }
        if (open >= 0 && open < close && /^<w:tbl[ >]/.test(body.slice(open, open + 7))) { depth++; j = open; continue; }
        if (depth === 0) { j = close + 8; break; }
        depth--; j = close;
      }
      const xml = body.slice(t, j);
      const rows = [...xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((c) => paraText(c[0])));
      blocks.push({ type: 'table', rows: rows.filter((r) => r.some((c) => c)) });
      i = j;
    } else {
      // <w:pPr> etc. also start with "<w:p"; only a paragraph is "<w:p>" or "<w:p ".
      const tag = body.slice(p, p + 5);
      if (tag !== '<w:p>' && tag !== '<w:p ') { i = p + 4; continue; }
      const end = body.indexOf('</w:p>', p);
      if (end < 0) break;
      const xml = body.slice(p, end + 6);
      const text = paraText(xml);
      const heading = /<w:pStyle w:val="(Heading\d|Title|Subtitle)"/i.test(xml);
      if (text) blocks.push({ type: 'para', text, heading });
      i = end + 6;
    }
  }
  return blocks;
}

export function readDocx(bytes: Uint8Array): Block[] {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('That is not a Word document (.docx).');
  return readBlocks(strFromU8(doc));
}

// ---------------------------------------------------------------------
// Label/value pairs, by business case.
// ---------------------------------------------------------------------
export type Section = { title: string | null; pairs: Pair[] };

const CASE = /^business\s+case\b\s*(?:#|no\.?)?\s*([0-9]+|[A-Z])?\b[\s:–—-]*(.*)$/i;

export function sections(blocks: Block[]): Section[] {
  const out: Section[] = [{ title: null, pairs: [] }];
  const cur = () => out[out.length - 1];
  for (const b of blocks) {
    if (b.type === 'para') {
      const m = CASE.exec(b.text);
      // A business case starts at a heading, or at a line that numbers
      // it — "Business Case 2: …". A plain "Business case: …" is a field.
      if (m && (b.heading || m[1]) && b.text.length < 120) {
        out.push({ title: b.text.replace(/\s+/g, ' ').trim(), pairs: [] });
        continue;
      }
      const kv = /^([^:]{2,60}):\s*(.+)$/.exec(b.text);
      if (kv && !b.heading) cur().pairs.push({ label: kv[1].trim(), value: kv[2].trim() });
      continue;
    }
    const rows = b.rows;
    if (!rows.length) continue;
    const head = rows[0].map((c) => c.toLowerCase());
    // A wallet table: one row a wallet, with its budget.
    if (head.length >= 2 && /wallet/.test(head[0]) && /budget|amount|bdt/.test(head.slice(1).join(' '))) {
      const wallets = rows.slice(1).filter((r) => r[0] && r[1]);
      cur().pairs.push({ label: 'Wallet', value: wallets.map((r) => r[0]).join(', ') });
      cur().pairs.push({ label: 'Wallet-wise budget', value: wallets.map((r) => `${r[0]}: ${r[1]}`).join('\n') });
      continue;
    }
    // A table of questions and answers.
    for (const r of rows) {
      const cells = r.filter((c) => c !== '');
      if (cells.length >= 2 && cells[0].length <= 60) cur().pairs.push({ label: cells[0].replace(/:$/, ''), value: cells.slice(1).join(' ') });
    }
  }
  return out.filter((s, i) => i === 0 || s.pairs.length > 0);
}

// ---------------------------------------------------------------------
// Matching labels to the form's questions.
// ---------------------------------------------------------------------
export type FormField = { id: string; label: string; kind: string; options?: string[] };

const norm = (s: string) => s.toLowerCase().replace(/centre/g, 'center').replace(/[^a-z0-9]/g, '');
const words = (s: string) => new Set(s.toLowerCase().replace(/centre/g, 'center').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !['the', 'of', 'and', 'no', 'number'].includes(w)));

// Labels NFAs use for the same thing.
const SYNONYMS: Record<string, string[]> = {
  campaignname: ['nameofcampaign', 'campaigntitle', 'campaign'],
  beneficiarycount: ['numberofbeneficiaries', 'beneficiaries', 'targetbeneficiaries', 'kpibeneficiarycount'],
  transactioncount: ['numberoftransactions', 'transactions', 'targettransactions', 'txncount'],
  transactionvolume: ['volume', 'txnvolume', 'transactionvalue', 'targetvolume'],
  bkashcost: ['costtobkash', 'bkashcontribution', 'bkashshare'],
  totalcost: ['totalbudget', 'budget', 'campaignbudget', 'totalcampaigncost'],
  costcenter: ['costcentercode', 'cc'],
  glcode: ['gl', 'generalledger', 'glaccount', 'generalledgercode'],
  startdate: ['campaignstartdate', 'from', 'launchdate', 'start'],
  enddate: ['campaignenddate', 'to', 'end', 'closingdate'],
  campaignbeneficiary: ['beneficiary', 'beneficiarytype', 'targetsegment'],
  walletwisebudget: ['budgetbywallet', 'walletbudget'],
  audience: ['targetaudience', 'segment', 'campaigntype'],
  modality: ['mechanic', 'campaignmechanic', 'offertype', 'campaignmodality'],
};

function score(label: string, field: string): number {
  const a = norm(label), b = norm(field);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if ((SYNONYMS[b] ?? []).includes(a)) return 0.95;
  if (a.length > 4 && b.length > 4 && (a.includes(b) || b.includes(a))) return 0.85;
  const wa = words(label), wb = words(field);
  const both = [...wa].filter((w) => wb.has(w)).length;
  const j = both / (new Set([...wa, ...wb]).size || 1);
  return j >= 0.5 ? 0.6 + j * 0.2 : 0;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** 01/12/2026, 1 December 2026, December 1, 2026, 2026-12-01 → 2026-12-01. */
export function toIsoDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) >= 0)
    return `${m[3]}-${String(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) >= 0)
    return `${m[3]}-${String(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** "BDT 1,200,000.50", "1.2 million", "12 lakh", "2 crore" → a number. */
export function toNumber(v: string): number | null {
  const s = v.toLowerCase().replace(/,/g, '');
  const m = /(-?\d+(?:\.\d+)?)\s*(million|mn|m\b|lakh|lac|crore|cr\b|k\b|thousand)?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { million: 1e6, mn: 1e6, m: 1e6, lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7, k: 1e3, thousand: 1e3 }[m[2]?.trim() as string] ?? 1;
  return Math.round(n * mult * 100) / 100;
}

function convert(value: string, field: FormField): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (field.kind) {
    case 'date': return toIsoDate(v);
    case 'number': case 'money': { const n = toNumber(v); return n === null ? null : String(n); }
    case 'select': case 'dept': {
      const opts = field.options ?? [];
      const hit = opts.find((o) => o.toLowerCase() === v.toLowerCase())
        ?? opts.find((o) => v.toLowerCase().startsWith(o.toLowerCase()) || o.toLowerCase().startsWith(v.toLowerCase()));
      return hit ?? (opts.length ? null : v);
    }
    case 'multi_select': {
      const parts = v.split(/[,;/\n]|\band\b/).map((p) => p.trim()).filter(Boolean);
      const opts = field.options ?? [];
      const mapped = parts.map((p) => opts.find((o) => o.toLowerCase() === p.toLowerCase()) ?? p.replace(/\s*wallet$/i, ''));
      return JSON.stringify([...new Set(mapped)]);
    }
    default: return v;
  }
}

export function matchPairs(pairs: Pair[], fields: FormField[]): { matches: Match[]; unmatched: Pair[] } {
  const usable = fields.filter((f) => !['section_header', 'file', 'signature', 'reviewer'].includes(f.kind) && !f.kind.startsWith('gen_'));
  const taken = new Map<string, Match>();
  const unmatched: Pair[] = [];
  for (const p of pairs) {
    let best: { f: FormField; s: number } | null = null;
    for (const f of usable) {
      const s = score(p.label, f.label);
      if (s > (best?.s ?? 0.59)) best = { f, s };
    }
    const value = best ? convert(p.value, best.f) : null;
    if (!best || value === null) { unmatched.push(p); continue; }
    const prev = taken.get(best.f.id);
    if (!prev || prev.confidence < best.s) {
      taken.set(best.f.id, { fieldId: best.f.id, fieldLabel: best.f.label, kind: best.f.kind, value, from: p.label, confidence: Math.round(best.s * 100) / 100 });
    }
  }
  return { matches: [...taken.values()], unmatched };
}


/** Everything a document says that the form asks, per business case. */
export function extract(bytes: Uint8Array, fields: FormField[]): Extraction {
  const blocks = readDocx(bytes);
  const secs = sections(blocks);
  const common = matchPairs(secs[0].pairs, fields);
  const cases = secs.slice(1).map((s) => ({ title: s.title ?? 'Business case', ...matchPairs(s.pairs, fields) }));
  return {
    common: common.matches,
    cases: cases.map((c) => ({ title: c.title, matches: c.matches })),
    unmatched: [...common.unmatched, ...cases.flatMap((c) => c.unmatched)],
    blocks: blocks.length,
  };
}

// ---------------------------------------------------------------------
// A sample NFA, so the feature can be shown without one to hand.
// ---------------------------------------------------------------------
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
const para = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const kv = (label: string, value: string) =>
  `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(label)}: </w:t></w:r><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p>`;
const cell = (text: string, bold = false, w = 4500) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
const table = (rows: string[][], header = false) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:color="BFBFBF"/>`).join('')}</w:tblBorders></w:tblPr>`
  + rows.map((r, i) => `<w:tr>${r.map((c) => cell(c, header && i === 0)).join('')}</w:tr>`).join('') + '</w:tbl>';

export function sampleNfaDocx(today = new Date()): Uint8Array {
  const d = (days: number) => {
    const x = new Date(today.getTime() + days * 86_400_000);
    return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;
  };
  const body = [
    para('Note for Approval — Winter Wallet Campaigns', 'Title'),
    para('Prepared by Campaign & Promotion for Business Finance vetting. Two business cases are proposed under one NFA.'),
    kv('Cost Centre', 'CC-4120'),
    kv('GL Code', '623045'),
    kv('Product', 'Send Money and Payment'),
    para('Business Case 1: Winter Cashback for Customers', 'Heading1'),
    kv('Name of Campaign', 'Winter Cashback 2026'),
    kv('Target Audience', 'Customer'),
    kv('Mechanic', 'Cashback'),
    kv('Campaign Start Date', d(14)),
    kv('Campaign End Date', d(58)),
    para('KPI section', 'Heading2'),
    table([
      ['Number of Beneficiaries', '45,000'],
      ['Number of Transactions', '180,000'],
      ['Transaction Volume', 'BDT 9.5 crore'],
      ['bKash Cost', 'BDT 3,400,000'],
      ['Total Budget', 'BDT 3,800,000'],
    ]),
    para('Reporting section', 'Heading2'),
    table([['Wallet', 'Budget (BDT)'], ['Customer', '3,000,000'], ['Agent', '800,000']], true),
    kv('Beneficiary Type', 'Customers'),
    para('Business Case 2: Agent Cash-in Incentive', 'Heading1'),
    kv('Name of Campaign', 'Winter Agent Cash-in Boost'),
    kv('Target Audience', 'Agent'),
    kv('Mechanic', 'Bonus'),
    kv('Campaign Start Date', d(21)),
    kv('Campaign End Date', d(51)),
    para('KPI section', 'Heading2'),
    table([
      ['Number of Beneficiaries', '6,000'],
      ['Number of Transactions', '75,000'],
      ['Transaction Volume', 'BDT 42 crore'],
      ['bKash Cost', 'BDT 1,050,000'],
      ['Total Budget', 'BDT 1,200,000'],
    ]),
    para('Reporting section', 'Heading2'),
    table([['Wallet', 'Budget (BDT)'], ['Agent', '1,200,000']], true),
    kv('Beneficiary Type', 'Agents'),
  ].join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:color w:val="4F46E5"/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="52525B"/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
  });
}
