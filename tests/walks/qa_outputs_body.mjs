// ================================================================ QA: documents, downloads, PDFs
// Files on a request: uploaded on the form and on the status page, versioned,
// described, tagged, found by tag, downloaded byte for byte, every download
// logged, refused to somebody not on the request and served to somebody copied.
// The generated PDFs (approval record, payment top sheet), the clearance
// certificate, and the audit trail export.
const zlib = await import('node:zlib');
const { unzipSync, strFromU8 } = req('fflate');

// A file fetched from inside the page, so the session cookie and persona go with it.
async function grab(href) {
  const r = await page.evaluate(async (h) => {
    const res = await fetch(h);
    const b = new Uint8Array(await res.arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return { status: res.status, type: res.headers.get('content-type'), disp: res.headers.get('content-disposition'),
             nosniff: res.headers.get('x-content-type-options'), b64: btoa(s) };
  }, href);
  return { ...r, buf: Buffer.from(r.b64, 'base64') };
}
// Every string drawn in a PDF: content streams inflated, hex strings decoded.
function pdfText(buf) {
  const s = buf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    if (s.slice(m.index - 3, m.index) === 'end') continue;
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const raw = buf.subarray(start, end);
    try { out += zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1') + '\n'; }
    catch { out += raw.toString('latin1') + '\n'; }
    re.lastIndex = end + 9;
  }
  out += s;
  const decoded = [];
  out.replace(/<([0-9A-Fa-f\s]{2,})>/g, (_, h) => {
    const clean = h.replace(/\s/g, '');
    if (clean.length % 2) return '';
    const b = Buffer.from(clean, 'hex');
    decoded.push(b[0] === 0xfe && b[1] === 0xff ? Buffer.from(b.subarray(2)).swap16().toString('utf16le') : b.toString('latin1'));
    return '';
  });
  out.replace(/\(((?:\\.|[^\\)])*)\)/g, (_, t) => { decoded.push(t); return ''; });
  return decoded.join(' ');
}
const isPdf = (g) => g.status === 200 && g.buf.subarray(0, 4).toString('latin1') === '%PDF' && /application\/pdf/.test(g.type ?? '');
const brief = (g) => JSON.stringify({ status: g.status, type: g.type, disp: g.disp, size: g.buf.length, head: g.buf.subarray(0, 40).toString('latin1') });
const blank = async () => { await page.goto('about:blank'); await settle(800); };

// ---------------------------------------------------------------- a file on a form
const capex = await formId('Capital Expenditure Request');
const quoteV1 = Buffer.concat([Buffer.from('%PDF-1.4\n% quotation v1\n'), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37 + 11) % 256))]);
await page.goto(`${BASE}/forms/${capex}?as=EMP-2847`);
await settle(3000);
for (let i = 0; i < 4 && !(await page.getByText('Project', { exact: true }).count()); i++) {
  await page.getByRole('button', { name: /^Next/ }).first().click().catch(() => {});
  await settle(900);
}
await (await field('Project')).locator('input').fill('QA warehouse racking');
await (await field('Classification')).locator('select').selectOption('Budgetary');
await (await field('Amount')).locator('input').fill('85000');
await (await field('Justification')).locator('textarea').fill('Racking for the new bay; three quotes compared.');
await (await field('Quotation')).locator('input[type="file"]').setInputFiles({ name: 'acme-quotation.pdf', mimeType: 'application/pdf', buffer: quoteV1 });
await settle(500);
ok('a file chosen on a form field shows its name before submitting', (await text()).includes('acme-quotation.pdf'));
for (let i = 0; i < 5 && !(await page.getByRole('button', { name: /Confirm & Submit/ }).count()); i++) {
  await page.getByRole('button', { name: /Next|Continue/ }).first().click().catch(() => {});
  await settle(900);
}
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 }).catch(() => {});
await settle(3000);
const sub = page.url().includes('/status/') ? page.url().split('/status/')[1].split('?')[0] : null;
ok('the capex request with a quotation is submitted', !!sub, page.url());
const ref = sub ? (await one(`select ref_number from public.form_submissions where id = $1`, [sub]))?.ref_number : null;

const v1 = await one(`select id, file_name, content_type, size_bytes, data, version, uploaded_by from public.attachments
                       where submission_id = $1 and field_name = 'Quotation'`, [sub]);
ok('the form field\'s file is stored against its question, byte for byte',
  v1 && v1.file_name === 'acme-quotation.pdf' && v1.version === 1 && v1.uploaded_by === 'EMP-2847'
  && Number(v1.size_bytes) === quoteV1.length && Buffer.compare(Buffer.from(v1.data), quoteV1) === 0,
  JSON.stringify(v1 && { ...v1, data: undefined }));
ok('...with its content type kept', v1?.content_type === 'application/pdf', v1?.content_type);

// The status page lists it and downloads it.
await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
await page.locator(`a[href^="/files/${v1?.id}"]`).first().waitFor({ timeout: 10000 }).catch(() => {});
let t = await text();
ok('the status page lists the form\'s file under Documents', /Documents/i.test(t) && t.includes('acme-quotation.pdf') && /Version 1/.test(t),
  t.slice(Math.max(0, t.search(/Documents/i) - 20), t.search(/Documents/i) + 300));
const linkV1 = page.locator(`a[href^="/files/${v1?.id}"]`);
ok('...as a download link to /files/<id>', (await linkV1.count()) >= 1, String(await linkV1.count()));
let g = await grab(`/files/${v1?.id}`);
ok('downloading returns exactly the bytes uploaded', g.status === 200 && Buffer.compare(g.buf, quoteV1) === 0, brief(g));
ok('...as an attachment with its file name, not sniffed',
  /^attachment;/.test(g.disp ?? '') && g.disp.includes('acme-quotation.pdf') && g.nosniff === 'nosniff' && g.type === 'application/pdf', brief(g));
await blank();
ok('...and the download is logged against the requester',
  (await rows(`select 1 from public.attachment_access where attachment_id = $1 and actor_id = 'EMP-2847'`, [v1?.id])).length === 1);

// The link's own address (with its ?by=) downloads the same file. Clicking it
// cannot be walked here: a download="" link bypasses the harness's routing.
await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
const linkHref = await page.locator(`a[href^="/files/${v1?.id}"]`).first().getAttribute('href');
g = await grab(linkHref);
ok("the document link's own address serves the same file, offered for saving under its name",
  /download/.test(await page.locator(`a[href^="/files/${v1?.id}"]`).first().evaluate((a) => a.hasAttribute('download') ? 'download' : ''))
  && g.status === 200 && Buffer.compare(g.buf, quoteV1) === 0, `${linkHref} ${brief(g)}`);

// ---------------------------------------------------------------- a revision, described and tagged
const quoteV2 = Buffer.concat([Buffer.from('%PDF-1.4\n% quotation v2 revised\n'), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 13 + 7) % 256))]);
await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
await page.locator('input[aria-label="Document file"]').setInputFiles({ name: 'acme-quotation-revised.pdf', mimeType: 'application/pdf', buffer: quoteV2 });
await page.locator('input[aria-label="New document description"]').fill('Revised quotation after negotiation');
await page.locator('input[aria-label="New document tags"]').fill('Quotation, Vendor-ACME ,quotation');
await page.getByRole('button', { name: /^Attach$/ }).click();
await settle(2500);
await blank();
const vers = await rows(`select id, file_name, version, superseded_at is not null as old, description, tags, data
                           from public.attachments where submission_id = $1 and field_name = 'Quotation' order by version`, [sub]);
ok('a revised file becomes version 2, version 1 kept and marked superseded',
  vers.length === 2 && vers[0].old && !vers[1].old && vers[1].version === 2 && vers[0].file_name === 'acme-quotation.pdf',
  JSON.stringify(vers.map((v) => [v.file_name, v.version, v.old])));
ok('...its description saved', vers[1]?.description === 'Revised quotation after negotiation', vers[1]?.description);
ok('...its tags saved trimmed, lower case and once each', JSON.stringify(vers[1]?.tags) === JSON.stringify(['quotation', 'vendor-acme']), JSON.stringify(vers[1]?.tags));
ok('...and the earlier version\'s bytes are untouched', Buffer.compare(Buffer.from(vers[0]?.data ?? []), quoteV1) === 0);
ok('...and the revision is on the request\'s trail',
  (await rows(`select 1 from public.approval_events where subject_id = $1 and action = 'document_revised'`, [sub])).length === 1);
const v2id = vers[1]?.id;

await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
t = await text();
ok('the panel shows version 2 as current, version 1 under earlier versions, and the description',
  /Version 2/.test(t) && /Earlier versions:/.test(t) && t.includes('acme-quotation-revised.pdf') && t.includes('acme-quotation.pdf')
  && t.includes('Revised quotation after negotiation'), t.slice(t.search(/Documents/i), t.search(/Documents/i) + 400));
ok('...with its tags shown', t.includes('vendor-acme'));
g = await grab(`/files/${v2id}`);
ok('version 2 downloads as its own bytes', g.status === 200 && Buffer.compare(g.buf, quoteV2) === 0 && g.disp?.includes('acme-quotation-revised.pdf'), brief(g));
g = await grab(`/files/${vers[0]?.id}`);
ok('version 1 still downloads as the original', g.status === 200 && Buffer.compare(g.buf, quoteV1) === 0, brief(g));

// Describe / tag an attached document afterwards.
await page.getByRole('button', { name: 'Describe / tag' }).first().click();
await settle(400);
await page.locator('input[aria-label="Document description"]').fill('Final quotation, signed by ACME');
await page.locator('input[aria-label="Document tags"]').fill('quotation, vendor-acme, signed');
await page.getByRole('button', { name: /^Save$/ }).first().click();
await settle(2000);
await blank();
const meta = await one(`select description, tags from public.attachments where id = $1`, [v2id]);
ok('a document\'s description and tags are edited after the fact',
  meta?.description === 'Final quotation, signed by ACME' && JSON.stringify(meta?.tags) === JSON.stringify(['quotation', 'vendor-acme', 'signed']), JSON.stringify(meta));

// Found from the search box by its tag.
await page.goto(`${BASE}/?as=EMP-2847`);
await settle(3000);
await page.locator('input[placeholder^="Search submissions"]').fill('vendor-acme');
await settle(2500);
t = await text();
ok('the search box finds the document by tag', t.includes('acme-quotation-revised.pdf'), t.slice(0, 300));
await page.keyboard.press('Escape');

// Every download so far is in the access log.
await blank();
const accessTom = (await one(`select count(*)::int n from public.attachment_access x join public.attachments a on a.id = x.attachment_id
                               where a.submission_id = $1 and x.actor_id = 'EMP-2847'`, [sub])).n;
ok('every download is logged (4 by the requester so far)', accessTom === 4, String(accessTom));

// ---------------------------------------------------------------- who may download
// Mei Sun (Operations) has no part in Tom's capex request.
await page.goto(`${BASE}/submissions?as=EMP-3120`);
await settle(3000);
const meiInvolved = (await one(`select app.involved_in($1, 'EMP-3120') as ok`, [sub]))?.ok;
ok('(Mei is not on the request)', meiInvolved === false, String(meiInvolved));
g = await grab(`/files/${v2id}`);
ok('somebody not on the request is refused the file', g.status >= 400 && g.status < 500 && Buffer.compare(g.buf, quoteV2) !== 0, brief(g));
g = await grab(`/files/${vers[0]?.id}`);
ok('...and its earlier version', g.status >= 400 && g.status < 500 && Buffer.compare(g.buf, quoteV1) !== 0, brief(g));
g = await grab(`/records/${sub}`);
ok('...and the approval record PDF', g.status >= 400 && g.status < 500 && !g.buf.subarray(0, 4).equals(Buffer.from('%PDF')), brief(g));
g = await grab(`/topsheet/${sub}`);
ok('...and the payment top sheet PDF', g.status >= 400 && g.status < 500 && !g.buf.subarray(0, 4).equals(Buffer.from('%PDF')), brief(g));
await blank();
ok('...and a refused download is not logged as an access',
  (await rows(`select 1 from public.attachment_access where actor_id = 'EMP-3120' and attachment_id in ($1, $2)`, [v2id, vers[0]?.id])).length === 0);
await page.goto(`${BASE}/status/${sub}?as=EMP-3120`);
await settle(3000);
t = await text();
ok('...and her status page shows neither the request nor its files', !t.includes('acme-quotation') && !t.includes(ref ?? '~none~'), t.slice(0, 200));

// The auditor sees every request, and may download.
await page.goto(`${BASE}/?as=EMP-0830`);
await settle(2500);
g = await grab(`/files/${v2id}`);
ok('the compliance auditor may download it', g.status === 200 && Buffer.compare(g.buf, quoteV2) === 0, brief(g));
await blank();
ok('...and that is logged against the auditor', (await rows(`select 1 from public.attachment_access where actor_id = 'EMP-0830' and attachment_id = $1`, [v2id])).length === 1);

// Tom copies Mei; now she may.
await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
await page.locator('select[aria-label="Copy somebody"]').selectOption('EMP-3120');
await page.locator('select[aria-label="Copy somebody"]').locator('xpath=..').getByRole('button', { name: /Copy/ }).click();
await settle(2000);
await blank();
ok('(Mei is now copied on it)', (await rows(`select 1 from public.submission_cc where submission_id = $1 and employee_id = 'EMP-3120'`, [sub])).length === 1);
await page.goto(`${BASE}/status/${sub}?as=EMP-3120`);
await settle(3000);
t = await text();
ok('a person copied sees the request\'s documents', t.includes('acme-quotation-revised.pdf'), t.slice(0, 200));
g = await grab(`/files/${v2id}`);
ok('...and downloads the file, byte for byte', g.status === 200 && Buffer.compare(g.buf, quoteV2) === 0, brief(g));
await blank();
ok('...logged against her', (await rows(`select 1 from public.attachment_access where actor_id = 'EMP-3120' and attachment_id = $1`, [v2id])).length === 1);

// ---------------------------------------------------------------- top sheet and approval record
await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
ok('a finance request offers its payment top sheet', (await page.locator(`a[href="/topsheet/${sub}"]`).count()) === 1);
g = await grab(`/topsheet/${sub}`);
let pt = pdfText(g.buf);
ok('the payment top sheet is a PDF', isPdf(g), brief(g));
ok('...named for its reference', (g.disp ?? '').includes(`top-sheet-${ref}.pdf`), g.disp);
ok('...headed PAYMENT TOP SHEET, with the reference, payee and amount',
  pt.includes('PAYMENT TOP SHEET') && pt.includes(ref) && pt.includes('QA warehouse racking') && /85,000/.test(pt), pt.slice(0, 600));
ok('...and the amount in words', /eighty[- ]five thousand/i.test(pt), (pt.match(/[A-Za-z -]*thousand[A-Za-z -]*/i) ?? [''])[0]);

const leave = await one(`select s.id, t.name, s.status from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
  where s.tenant_id = $1 and t.category not in ('Finance', 'Commercial') and s.submitted_by = 'EMP-2847' and s.status <> 'draft' limit 1`, [tenant]);
if (leave) {
  await page.goto(`${BASE}/status/${leave.id}?as=EMP-2847`);
  await settle(3000);
  await page.locator(`a[href="/records/${leave.id}"]`).first().waitFor({ timeout: 10000 }).catch(() => {});
  ok(`a request that is not finance (${leave.name}, ${leave.status}) offers no top sheet, but does offer its record`,
    (await page.locator(`a[href="/topsheet/${leave.id}"]`).count()) === 0 && (await page.locator(`a[href="/records/${leave.id}"]`).count()) >= 1,
    `topsheet links ${await page.locator(`a[href="/topsheet/${leave.id}"]`).count()}, record links ${await page.locator(`a[href="/records/${leave.id}"]`).count()}; ${(await text()).slice(0, 200)}`);
}

// Approve the capex request to the end.
for (let i = 0; i < 8; i++) {
  await blank();
  const next = await one(`select approver_user_id from public.approval_requests where submission_id = $1 and status = 'pending'
                           order by step_index, lane, lane_step limit 1`, [sub]);
  if (!next) break;
  await approveAs(next.approver_user_id, sub);
}
await blank();
const fin = await one(`select status from public.form_submissions where id = $1`, [sub]);
ok('the capex request is approved to the end', fin?.status === 'completed', JSON.stringify(fin));
const approvers = (await rows(`select e.name from public.approval_requests ar join public.employees e on e.employee_id = ar.approver_user_id and e.tenant_id = ar.tenant_id
                                where ar.submission_id = $1 and ar.status = 'approved'`, [sub])).map((r) => r.name);

await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
t = await text();
ok('the completed request offers its approval record', /All approvals complete/.test(t) && (await page.locator(`a[href="/records/${sub}"]`).count()) >= 1, t.slice(0, 200));
g = await grab(`/records/${sub}`);
pt = pdfText(g.buf);
ok('the approval record is a PDF', isPdf(g), brief(g));
ok('...named for its reference', (g.disp ?? '').includes(`${ref}.pdf`), g.disp);
ok('...carrying the reference, the form, the answers', pt.includes(ref) && pt.includes('Capital Expenditure Request') && pt.includes('QA warehouse racking'), pt.slice(0, 600));
ok('...and every approver who approved it', approvers.length > 0 && approvers.every((n) => pt.includes(n)),
  approvers.filter((n) => !pt.includes(n)).join(', ') + ' missing of ' + approvers.join(', '));
// (The record leaves file questions out by design — src/server/record.ts — so documents are not checked for here.)
g = await grab(`/topsheet/${sub}`);
pt = pdfText(g.buf);
ok('the top sheet of the completed request carries its approvals', isPdf(g) && approvers.every((n) => pt.includes(n)),
  approvers.filter((n) => !pt.includes(n)).join(', '));
g = await grab(`/records/00000000-0000-4000-8000-000000000000`);
ok('a record for no such request is a 404, not an empty PDF', g.status === 404, brief(g));
g = await grab(`/files/00000000-0000-4000-8000-000000000000`);
ok('a file that does not exist is a 404', g.status === 404, brief(g));
g = await grab(`/files/not-a-uuid`);
ok('a malformed file id is a 404', g.status === 404, brief(g));

// Once closed, no more documents may be attached.
// A completed request still takes a supplemental document from somebody on it (by design: only cancelled closes it).
ok('a completed request still takes a supplemental document from the requester', (await page.locator('input[aria-label="Document file"]').count()) === 1);

// ---------------------------------------------------------------- the clearance certificate
await page.goto(`${BASE}/certificate/${sub}?as=EMP-2847`);
await settle(3000);
t = await text();
ok('a completed request that is not a clearance has no certificate', /No clearance certificate for this request/.test(t), t.slice(0, 200));

await blank();
const exitSub = await subOf('Employee Exit Clearance', 'EMP-2847');
const exitRef = (await one(`select ref_number from public.form_submissions where id = $1`, [exitSub])).ref_number;

// A file named like a formula, on the clearance's handover question.
await page.goto(`${BASE}/status/${exitSub}?as=EMP-2847`);
await settle(3000);
const evilName = '=SUM(1+2)handover.pdf';
await page.locator('input[aria-label="Document file"]').setInputFiles({ name: evilName, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 handover') });
await page.locator('input[aria-label="New document description"]').fill('Handover note');
await page.locator('input[aria-label="New document tags"]').fill('handover');
await page.getByRole('button', { name: /^Attach$/ }).click();
await settle(2500);
await blank();
const evil = await one(`select id from public.attachments where submission_id = $1 and file_name = $2`, [exitSub, evilName]);
ok('a file is attached to the clearance\'s handover question', !!evil);
await page.goto(`${BASE}/status/${exitSub}?as=EMP-2847`);
await settle(2500);
g = await grab(`/files/${evil?.id}`);
ok('...and downloads', g.status === 200 && g.buf.toString('latin1') === '%PDF-1.4 handover', brief(g));

await page.goto(`${BASE}/certificate/${exitSub}?as=EMP-2847`);
await settle(3000);
t = await text();
ok('a clearance still in progress has no certificate yet', !/Company Clearance Certificate/.test(t) && !/has completed all required clearance formalities/.test(t),
  `status ${(await one(`select status from public.form_submissions where id = $1`, [exitSub]).catch(() => ({})))?.status}; page says: ` + t.slice(t.indexOf('Company Clearance'), t.indexOf('Company Clearance') + 250));

await blank();
await db.query(`update public.form_submissions set status = 'completed' where id = $1`, [exitSub]);
await page.goto(`${BASE}/status/${exitSub}?as=EMP-2847`);
await settle(3000);
t = await text();
ok('a completed clearance offers its certificate', /View certificate/.test(t));
await page.goto(`${BASE}/certificate/${exitSub}?as=EMP-2847`);
await settle(3000);
t = await text();
ok('the certificate names the clearance, its reference and the leaver',
  /Company Clearance Certificate/.test(t) && t.includes(exitRef) && t.includes('Tom Bexley'), t.slice(0, 400));
await shot('qa-outputs-certificate');
const stranger = (await one(`select e.employee_id from public.employees e
   where e.tenant_id = $1 and e.active and e.employee_id like 'EMP-%' and not app.involved_in($2, e.employee_id)
     and not exists (select 1 from public.notifications n where n.recipient_id = e.employee_id and n.entity_id = $2)
     and not exists (select 1 from public.approval_events v where v.actor_id = e.employee_id and v.subject_id = $2)
     and not exists (select 1 from public.departments d join public.employees tom on tom.employee_id = 'EMP-2847' and tom.tenant_id = d.tenant_id
                      where d.tenant_id = e.tenant_id and d.name = tom.department and d.head_employee_id = e.employee_id)
     and not exists (select 1 from public.roles r where r.tenant_id = e.tenant_id and r.id in (select app.held_roles(e.employee_id))
                      and ('reports.view' = any (r.permissions) or 'audit.view' = any (r.permissions)))
   order by e.employee_id limit 1`, [tenant, exitSub]).catch((err) => { console.log('  debug stranger', err.message); return null; }))?.employee_id;
if (stranger) {
  await page.goto(`${BASE}/certificate/${exitSub}?as=${stranger}`);
  await settle(3000);
  t = await text();
  ok(`somebody not on the clearance (${stranger}) cannot see its certificate`, !/Company Clearance Certificate/.test(t) && !t.includes(exitRef), t.slice(0, 200));
} else {
  console.log('  note: no uninvolved plain employee found for the certificate check');
}

// ---------------------------------------------------------------- the audit trail export
await page.goto(`${BASE}/admin/audit?as=EMP-0445`);
await settle(3500);
const auditXlsxHref = await page.locator('[data-testid="export-xlsx"]').getAttribute('href').catch(() => null);
ok('the Audit Centre offers an Excel export', !!auditXlsxHref, String(auditXlsxHref));
g = await grab(auditXlsxHref ?? '/exports/audit?format=xlsx');
let zip = null;
try { zip = unzipSync(new Uint8Array(g.buf)); } catch {}
ok('the audit Excel is a real workbook', g.status === 200 && g.buf.subarray(0, 2).toString('latin1') === 'PK' && !!zip?.['xl/worksheets/sheet1.xml']
  && /spreadsheetml/.test(g.type ?? '') && /\.xlsx"/.test(g.disp ?? ''), brief(g));
const auditSheet = zip?.['xl/worksheets/sheet1.xml'] ? strFromU8(zip['xl/worksheets/sheet1.xml']) : '';
ok('...holding the document downloads', /document_viewed/.test(auditSheet) && auditSheet.includes('acme-quotation-revised.pdf'));
g = await grab('/exports/audit?format=csv&q=' + encodeURIComponent('sum(1+2)handover'));
let csv = g.buf.toString('utf8').replace(/^﻿/, '');
let lines = csv.split(/\r?\n/).filter(Boolean);
ok('the audit CSV has a header row and the access', g.status === 200 && /text\/csv/.test(g.type ?? '') && /^When,Category,Severity,Source,Action/.test(lines[0] ?? '')
  && lines.some((l) => /document_viewed/.test(l)), csv.slice(0, 400));
ok('...a file name typed like a formula is written as text (quote-prefixed)',
  csv.includes(`'${evilName}`) && !lines.slice(1).some((l) => l.split(',').some((c) => c.replace(/^"/, '').startsWith('=SUM'))), lines.slice(0, 3).join(' / '));
g = await grab('/exports/audit?format=csv&q=' + encodeURIComponent('zz-no-such-entry-qa'));
csv = g.buf.toString('utf8').replace(/^﻿/, '');
ok('an audit export that matches nothing is still a CSV with its header', g.status === 200 && csv.split(/\r?\n/).filter(Boolean).length === 1 && /^When,/.test(csv), csv.slice(0, 200));
g = await grab('/exports/audit?format=xlsx&q=' + encodeURIComponent('zz-no-such-entry-qa'));
zip = null; try { zip = unzipSync(new Uint8Array(g.buf)); } catch {}
ok('...and an empty Excel is still a workbook', g.status === 200 && !!zip?.['xl/worksheets/sheet1.xml'], brief(g));
g = await grab('/exports/audit?format=exe');
ok('an unknown export format is refused', g.status === 400, brief(g));
await blank();
ok('downloading the audit trail is itself audited',
  (await one(`select count(*)::int n from public.activity_log where tenant_id = $1 and action = 'audit_exported'`, [tenant])).n >= 4);
await page.goto(`${BASE}/?as=EMP-2847`);
await settle(2500);
g = await grab('/exports/audit?format=csv');
ok('somebody without the audit permission cannot export the audit trail', g.status === 403 && !/^﻿?When,/.test(g.buf.toString('utf8')), brief(g));

// ---------------------------------------------------------------- the Word sample
g = await grab('/samples/campaign-nfa');
zip = null; try { zip = unzipSync(new Uint8Array(g.buf)); } catch {}
ok('the sample NFA downloads as a real Word document', g.status === 200 && g.buf.subarray(0, 2).toString('latin1') === 'PK'
  && !!zip?.['word/document.xml'] && /wordprocessingml/.test(g.type ?? '') && /\.docx"/.test(g.disp ?? ''), brief(g));
ok('...holding its business cases', /Winter Cashback 2026/.test(zip?.['word/document.xml'] ? strFromU8(zip['word/document.xml']) : ''));

// The refusals this walk asks for on purpose (400, 403, 404) are logged by the browser; nothing else may be.
const unexpected = pageErrors.filter((e) => !/Failed to load resource: the server responded with a status of (400|403|404)/.test(e));
ok('no page errors (besides the refusals asked for)', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA OUTPUT CHECKS PASSED');
process.exit(failures ? 1 : 0);
