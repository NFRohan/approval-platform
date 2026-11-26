// ================================================================ QA: every export
// Report exports (Excel, CSV, PDF) with their content, the formula guard in
// server and browser CSVs, empty exports, who may export; tracker Excel,
// My Submissions Excel and CSV, approval history CSV, the ServiceDesk sample
// export, movement orders CSV.
const zlib = await import('node:zlib');
const { unzipSync, strFromU8 } = req('fflate');

async function grab(href) {
  const r = await page.evaluate(async (h) => {
    const res = await fetch(h);
    const b = new Uint8Array(await res.arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return { status: res.status, type: res.headers.get('content-type'), disp: res.headers.get('content-disposition'), b64: btoa(s) };
  }, href);
  return { ...r, buf: Buffer.from(r.b64, 'base64') };
}
function pdfParts(buf) {
  const s = buf.toString('latin1');
  let raw = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    if (s.slice(m.index - 3, m.index) === 'end') continue;
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    try { raw += zlib.inflateSync(buf.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1') + '\n'; }
    catch { raw += buf.subarray(start, end).toString('latin1') + '\n'; }
    re.lastIndex = end + 9;
  }
  raw += s;
  const decoded = [];
  raw.replace(/<([0-9A-Fa-f\s]{2,})>/g, (_, h) => {
    const clean = h.replace(/\s/g, '');
    if (clean.length % 2) return '';
    const b = Buffer.from(clean, 'hex');
    decoded.push(b[0] === 0xfe && b[1] === 0xff ? Buffer.from(b.subarray(2)).swap16().toString('utf16le') : b.toString('latin1'));
    return '';
  });
  return { text: decoded.join(' '), pages: (raw.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length };
}
const xlsxOf = (buf) => { try { return unzipSync(new Uint8Array(buf)); } catch { return null; } };
const sheetText = (zip, n = 1) => zip?.[`xl/worksheets/sheet${n}.xml`] ? strFromU8(zip[`xl/worksheets/sheet${n}.xml`]) : '';
const brief = (g) => JSON.stringify({ status: g.status, type: g.type, disp: g.disp, size: g.buf.length, head: g.buf.subarray(0, 40).toString('latin1') });
const blank = async () => { await page.goto('about:blank'); await settle(800); };
// A CSV line split into cells (quotes understood).
function cells(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const csvRows = (txt) => txt.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length).map(cells);
const unguarded = (table) => table.slice(1).flat().filter((c) => /^[=+\-@]/.test(c) && !/^-?\d[\d,.]*$/.test(c));
async function saveFrom(click) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }).catch(() => null), click()]);
  if (!dl) return null;
  return { name: dl.suggestedFilename(), buf: await readFile(await dl.path()) };
}

// ---------------------------------------------------------------- formula-shaped text in the data
// Comments typed by an approver, as anybody could type them.
await blank();
const samSteps = await rows(`select ar.id, s.ref_number from public.approval_requests ar join public.form_submissions s on s.id = ar.submission_id
  where ar.approver_user_id = 'EMP-1134' and ar.status = 'approved' and ar.tenant_id = $1 order by ar.acted_at desc limit 4`, [tenant]);
ok('(Sam has approved steps to work with)', samSteps.length === 4, String(samSteps.length));
const EVIL = ['=2+3', '+SUM(A1:A2)', '@cmd', '-2+3'];
for (let i = 0; i < samSteps.length; i++) await db.query(`update public.approval_requests set comment = $2 where id = $1`, [samSteps[i].id, EVIL[i]]);

// ---------------------------------------------------------------- report exports
await page.goto(`${BASE}/reports?as=EMP-0445`);
await settle(3000);
await page.getByText('All requests', { exact: true }).first().click();
await settle(4000);
const firstRef = (await page.locator('[data-testid="report-table"] tbody tr').first().innerText().catch(() => '')).match(/AMS-\d{4}-\d{5}/)?.[0];
const shownCount = Number((/([\d,]+) rows?/.exec(await page.locator('[data-testid="row-count"]').innerText().catch(() => ''))?.[1] ?? '-1').replace(/,/g, ''));
const heads = (await page.locator('[data-testid="report-table"] thead th').allInnerTexts()).map((h) => h.trim()).filter(Boolean);
ok('(the All requests report is on screen)', !!firstRef && shownCount > 0 && heads.length > 2, `${firstRef} ${shownCount} ${heads.join('|')}`);

const hrefOf = (id) => page.locator(`[data-testid="${id}"]`).getAttribute('href');
let g = await grab(await hrefOf('export-xlsx'));
let zip = xlsxOf(g.buf);
let sheet = sheetText(zip);
ok('the report exports to a real Excel workbook', g.status === 200 && g.buf.subarray(0, 2).toString('latin1') === 'PK' && !!zip?.['xl/workbook.xml']
  && /spreadsheetml/.test(g.type ?? '') && /all-requests-\d{4}-\d{2}-\d{2}\.xlsx"/.test(g.disp ?? ''), brief(g));
ok('...its header row the columns on screen', heads.every((h) => sheet.includes(`>${h.replace(/&/g, '&amp;')}<`)), heads.filter((h) => !sheet.includes(h)).join(', '));
ok('...its rows the requests on screen', sheet.includes(firstRef) && (sheet.match(/<row /g) ?? []).length === shownCount + 1,
  `rows ${(sheet.match(/<row /g) ?? []).length - 1} vs ${shownCount}`);
ok('...and an About sheet naming the report and who made it', /All requests/.test(sheetText(zip, 2)) && /Farah Haddad/.test(sheetText(zip, 2)), sheetText(zip, 2).slice(0, 300));

g = await grab(await hrefOf('export-csv'));
let table = csvRows(g.buf.toString('utf8'));
ok('the report exports to CSV (UTF-8 with a byte-order mark)', g.status === 200 && g.buf[0] === 0xef && g.buf[1] === 0xbb && /text\/csv/.test(g.type ?? '') && /\.csv"/.test(g.disp ?? ''), brief(g));
ok('...a header row of the columns on screen', JSON.stringify(table[0]) === JSON.stringify(heads), `${JSON.stringify(table[0])} vs ${JSON.stringify(heads)}`);
ok('...and a line per request', table.length === shownCount + 1 && table.slice(1).some((r) => r[0] === firstRef), `${table.length - 1} vs ${shownCount}`);
ok('...every line as wide as the header', table.every((r) => r.length === table[0].length), table.find((r) => r.length !== table[0].length)?.join('|'));

g = await grab(await hrefOf('export-pdf'));
let pdf = pdfParts(g.buf);
ok('the report exports to PDF', g.status === 200 && g.buf.subarray(0, 4).toString('latin1') === '%PDF' && /application\/pdf/.test(g.type ?? '') && /\.pdf"/.test(g.disp ?? ''), brief(g));
ok('...titled, with who made it and the requests', pdf.text.includes('All requests') && pdf.text.includes('Farah Haddad') && pdf.text.includes(firstRef), pdf.text.slice(0, 400));
ok('...across as many pages as it needs', shownCount < 30 || pdf.pages > 1, `${pdf.pages} pages for ${shownCount} rows`);
await blank();
ok('each report export is on the trail', (await one(`select count(*)::int n from public.activity_log where tenant_id = $1 and action = 'report_exported'`, [tenant])).n === 3);

// The formula guard, from the server.
const evilRef = samSteps[0]?.ref_number;
await page.goto(`${BASE}/reports?as=EMP-0445`);
await settle(2500);
const steps = (q, fmt) => `/exports/report/adhoc?format=${fmt}&d=steps&c=reference,approver,comment&f=${encodeURIComponent(JSON.stringify({ period: 'all', search: q }))}`;
let guardRows = [];
for (const s of samSteps) {
  g = await grab(steps(s.ref_number, 'csv'));
  guardRows = guardRows.concat(csvRows(g.buf.toString('utf8')).slice(1).filter((r) => r[1] === 'Sam Lindqvist'));
}
const comments = guardRows.map((r) => r[2]);
ok('server CSV: comments starting = + @ - are quote-prefixed',
  EVIL.every((e) => comments.includes(`'${e}`)) && !comments.some((c) => EVIL.includes(c)), JSON.stringify(comments));
g = await grab(steps(evilRef, 'xlsx'));
sheet = sheetText(xlsxOf(g.buf));
ok('...and in Excel they are text cells, never formulas', sheet.includes('=2+3') && !/<f>/.test(sheet) && /t="inlineStr"><is><t[^>]*>=2\+3</.test(sheet), sheet.slice(0, 200));

// Nothing matches: still a file.
const none = (fmt) => `/exports/report/adhoc?format=${fmt}&d=requests&c=reference,form,status&f=${encodeURIComponent(JSON.stringify({ period: 'all', search: 'zz-no-such-request' }))}`;
g = await grab(none('csv'));
table = csvRows(g.buf.toString('utf8'));
ok('an export with no rows is a CSV of just its header', g.status === 200 && table.length === 1 && table[0].join(',') === 'Reference,Form,Status', JSON.stringify(table));
g = await grab(none('xlsx'));
zip = xlsxOf(g.buf);
ok('...an Excel workbook with just its header', g.status === 200 && !!zip && (sheetText(zip).match(/<row /g) ?? []).length === 1, brief(g));
g = await grab(none('pdf'));
pdf = pdfParts(g.buf);
ok('...and a one-page PDF', g.status === 200 && g.buf.subarray(0, 4).toString('latin1') === '%PDF' && pdf.pages === 1 && /%%EOF\s*$/.test(g.buf.toString('latin1')), `${brief(g)} pages ${pdf.pages}`);
g = await grab(none('docx'));
ok('an unknown export format is refused', g.status === 400, brief(g));
g = await grab('/exports/report/00000000-0000-4000-8000-000000000000?format=csv');
ok('an export of no such report is a 404', g.status === 404, brief(g));

// The biggest export: every step ever, as Excel and PDF.
const big = (fmt) => `/exports/report/adhoc?format=${fmt}&d=steps&c=reference,form,approver,status,opened_at,acted_at,comment&f=${encodeURIComponent(JSON.stringify({ period: 'all' }))}`;
await blank();
const allSteps = (await one(`select count(*)::int n from public.report_steps where tenant_id = $1`, [tenant]).catch(() => ({ n: -1 }))).n;
await page.goto(`${BASE}/reports?as=EMP-0445`);
await settle(2500);
g = await grab(big('xlsx'));
zip = xlsxOf(g.buf);
const bigRows = (sheetText(zip).match(/<row /g) ?? []).length - 1;
ok(`the largest export (every approval step) is a complete workbook`, g.status === 200 && !!zip && bigRows > 100 && (allSteps < 0 || bigRows === Math.min(allSteps, 5000)), `${bigRows} rows vs ${allSteps}`);
g = await grab(big('pdf'));
pdf = pdfParts(g.buf);
ok('...and a many-page PDF', g.status === 200 && g.buf.subarray(0, 4).toString('latin1') === '%PDF' && pdf.pages > 3, `${pdf.pages} pages, ${g.buf.length} bytes`);

// Somebody who cannot read reports cannot export one.
await page.goto(`${BASE}/?as=EMP-2847`);
await settle(2500);
g = await grab(none('csv'));
ok('somebody without reports cannot export one', g.status === 403, brief(g));

// ---------------------------------------------------------------- the tracker's Excel
await page.goto(`${BASE}/trackers?as=EMP-0445`);
await settle(4000);
const trRef = (await page.locator('[data-testid="tracker-rows"] tbody tr').first().innerText().catch(() => '')).match(/AMS-\d{4}-\d{5}/)?.[0];
const trCount = await page.locator('[data-testid="tracker-rows"] tbody tr').count();
let f = await saveFrom(() => page.getByRole('button', { name: /Excel/ }).first().click());
zip = f && xlsxOf(f.buf);
sheet = sheetText(zip);
ok('the tracker downloads as a real .xlsx', !!f && /^main-tracker-\d{4}-\d{2}-\d{2}\.xlsx$/.test(f.name) && f.buf.subarray(0, 2).toString('latin1') === 'PK' && !!zip?.['xl/workbook.xml'], f?.name);
ok('...with its columns and its rows', /Reference/.test(sheet) && /Raised by/.test(sheet) && !!trRef && sheet.includes(trRef)
  && (sheet.match(/<row /g) ?? []).length - 1 >= trCount, `${trRef} ${(sheet.match(/<row /g) ?? []).length - 1} vs ${trCount} on screen`);

// ---------------------------------------------------------------- My Submissions
await page.goto(`${BASE}/submissions?as=EMP-2847`);
await settle(3500);
const mine = await rows(`select ref_number from public.form_submissions where tenant_id = $1 and submitted_by = 'EMP-2847' and ref_number is not null`, [tenant]).catch(() => []);
f = await saveFrom(() => page.getByRole('button', { name: /Export Excel/ }).click());
zip = f && xlsxOf(f.buf);
sheet = sheetText(zip);
ok('My Submissions exports to a real .xlsx', !!f && /^my-submissions-\d{4}-\d{2}-\d{2}\.xlsx$/.test(f.name) && !!zip?.['xl/workbook.xml'], f?.name);
const sheetRefs = new Set(sheet.match(/AMS-\d{4}-\d{5}/g) ?? []);
ok('...with Tom\'s requests in it', sheetRefs.size > 0 && [...sheetRefs].every((r) => mine.some((m) => m.ref_number === r)), [...sheetRefs].slice(0, 5).join(','));
f = await saveFrom(() => page.getByRole('button', { name: /Export CSV/ }).click());
table = f ? csvRows(f.buf.toString('utf8')) : [];
ok('...and to CSV, with a header row', !!f && /^my-submissions-\d{4}-\d{2}-\d{2}\.csv$/.test(f.name) && table[0]?.join(',') === 'Reference,Form Name,Raised by,Status,Priority,Submitted', `${f?.name} ${table[0]?.join(',')}`);
ok('...the same requests as the Excel', table.length - 1 === sheetRefs.size || table.length - 1 === (sheet.match(/<row /g) ?? []).length - 1,
  `${table.length - 1} csv vs ${(sheet.match(/<row /g) ?? []).length - 1} xlsx`);
ok('...each raised by Tom, dated dd/MM/yyyy', table.length > 1 && table.slice(1).every((r) => r[2] === 'Tom Bexley' && /^(\d{2}\/\d{2}\/\d{4})?$/.test(r[5])),
  table.slice(1, 3).map((r) => r.join('|')).join(' / '));
// Narrowed on screen, narrowed in the file.
const oneRef = table[1]?.[0];
await page.locator('input[aria-label="Search submissions"]').fill(oneRef ?? '');
await settle(800);
f = await saveFrom(() => page.getByRole('button', { name: /Export CSV/ }).click());
table = f ? csvRows(f.buf.toString('utf8')) : [];
ok('...and a search narrows the export to what is shown', table.length === 2 && table[1][0] === oneRef, JSON.stringify(table.slice(0, 3)));
// The browser's own guard.
await blank();
await db.query(`update public.employees set name = '=HYPERLINK("http://x.test","Tom")' where employee_id = 'EMP-2847' and tenant_id = $1`, [tenant]);
await page.goto(`${BASE}/submissions?as=EMP-2847`);
await settle(3500);
f = await saveFrom(() => page.getByRole('button', { name: /Export CSV/ }).click());
table = f ? csvRows(f.buf.toString('utf8')) : [];
ok('browser CSV: a name starting = is quote-prefixed', table.length > 1 && table.slice(1).every((r) => r[2] === `'=HYPERLINK("http://x.test","Tom")`) && unguarded(table).length === 0,
  table.slice(1, 2).map((r) => r.join('|')).join(''));
f = await saveFrom(() => page.getByRole('button', { name: /Export Excel/ }).click());
sheet = sheetText(f && xlsxOf(f.buf));
ok('...and in the Excel it is text, not a formula', sheet.includes('=HYPERLINK(') && !/<f>/.test(sheet));
await blank();
await db.query(`update public.employees set name = 'Tom Bexley' where employee_id = 'EMP-2847' and tenant_id = $1`, [tenant]);

// ---------------------------------------------------------------- approval history
await page.goto(`${BASE}/approvals/history?as=EMP-1134`);
await settle(4000);
f = await saveFrom(() => page.getByRole('button', { name: /Export CSV/ }).click());
table = f ? csvRows(f.buf.toString('utf8')) : [];
await blank();
const samActed = (await one(`select count(*)::int n from public.approval_requests where approver_user_id = 'EMP-1134' and tenant_id = $1
                               and status in ('approved', 'rejected', 'clarification')`, [tenant])).n;
ok('the approval history exports to CSV, with a header row', !!f && /^approval-history-\d{4}-\d{2}-\d{2}\.csv$/.test(f.name) && table[0]?.join(',') === 'Form Name,Submitter,Status,Acted At,Comment,Reference',
  `${f?.name} ${table[0]?.join(',')}`);
ok('...a line for each decision Sam made', table.length - 1 === samActed, `${table.length - 1} vs ${samActed}`);
const histComments = table.slice(1).map((r) => r[4]);
ok('browser CSV: comments starting = + @ - are quote-prefixed',
  EVIL.every((e) => histComments.includes(`'${e}`)) && unguarded(table).length === 0, JSON.stringify(histComments.filter(Boolean).slice(0, 8)));
ok('...and it is dated as the screen dates things (dd/MM/yyyy)', table.length > 1 && table.slice(1).every((r) => !r[3] || /^\d{2}\/\d{2}\/\d{4}/.test(r[3])),
  table.slice(1, 3).map((r) => r[3]).join(' / '));
ok('...and says which request each decision was on (reference)', table.length > 1 && table.slice(1).every((r) => r.some((c) => /^AMS-\d{4}-\d{5}$/.test(c))),
  `columns: ${table[0]?.join(',')}`);

// ---------------------------------------------------------------- the ServiceDesk sample export
await page.goto(`${BASE}/admin/integrations?as=EMP-0445`);
await settle(3500);
await page.getByRole('tab', { name: 'Migration' }).click();
await settle(1500);
f = await saveFrom(() => page.getByRole('button', { name: /A sample export/ }).click());
table = f ? csvRows(f.buf.toString('utf8')) : [];
ok('the ServiceDesk sample export downloads as CSV with its header', !!f && f.name === 'servicedesk-requests-export.csv'
  && table[0]?.slice(0, 3).join(',') === 'Request ID,Subject,Description' && table.length === 25, `${f?.name} ${table.length} ${table[0]?.join(',')}`);
ok('...every line as wide as the header', table.length > 1 && table.every((r) => r.length === table[0].length));
ok('...no cell that a spreadsheet would run', unguarded(table).length === 0, unguarded(table).slice(0, 3).join(' | '));
// The sample reads back in.
await page.locator('input[aria-label="ManageEngine export"]').setInputFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: f?.buf ?? Buffer.from('') });
await settle(2000);
ok('...and the sample reads straight back into the importer', /24/.test(await text()) && !/has no .* column/.test(await text()));

// ---------------------------------------------------------------- movement orders
await page.goto(`${BASE}/movement-orders?as=EMP-0445`);
await settle(3500);
const moBtn = page.getByRole('button', { name: /Export CSV/ });
if (await moBtn.count()) {
  f = await saveFrom(() => moBtn.first().click());
  table = f ? csvRows(f.buf.toString('utf8')) : [];
  ok('movement orders export to CSV with a header row', !!f && /^movement-orders-\d{4}-\d{2}-\d{2}\.csv$/.test(f.name) && table[0]?.includes('Quantity') && table.length > 1,
    `${f?.name} ${table[0]?.join(',')}`);
  ok('...no cell that a spreadsheet would run', unguarded(table).length === 0, unguarded(table).slice(0, 3).join(' | '));
} else {
  console.log('  note: movement orders page offers no export for this persona');
}

// The refusals this walk asks for on purpose (400, 403, 404) are logged by the browser; nothing else may be.
const unexpected = pageErrors.filter((e) => !/Failed to load resource: the server responded with a status of (400|403|404)/.test(e));
ok('no page errors (besides the refusals asked for)', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA EXPORT CHECKS PASSED');
process.exit(failures ? 1 : 0);
