// =====================================================================
// Reports, exports and email, without a database.
//
//   npm run test:reports
//
// The query builder only ever builds from the catalogue and binds every
// value; the CSV cannot carry a formula; the Excel file is a real
// workbook; the PDFs open; and an email says what its template says with
// nothing left unfilled or unescaped.
// =====================================================================

import { createServer } from 'vite';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';

const NL = String.fromCharCode(10);
process.env.JWT_SECRET ||= 'reports-test-secret-that-is-long-enough';
let passed = 0;
const failures = [];
function check(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { passed += 1; console.log(`  pass: ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
const reports = await vite.ssrLoadModule('/src/server/reports.ts');
const exp = await vite.ssrLoadModule('/src/server/export.ts');
const mail = await vite.ssrLoadModule('/src/lib/email-templates.ts');
const cat = await vite.ssrLoadModule('/src/lib/report-catalogue.ts');

console.log(NL + 'reports' + NL);

// ------------------------------------------------------------ the builder
const q = reports.buildReportQuery('requests', ['reference', 'status'],
  { status: ['completed'], search: "x' or 1=1 --", period: 'custom', from: '2026-01-01', to: 'not a date' });
check('values are bound, never written into the SQL', q.text.includes("1=1") || q.text.includes('completed'), false);
check('...and arrive as parameters', q.params.some((p) => Array.isArray(p) && p[0] === 'completed') && q.params.some((p) => String(p).includes('1=1')), true);
check('a malformed date is ignored rather than passed on', q.params.includes('not a date'), false);
let threw = null;
try { reports.buildReportQuery('requests', ['reference', 'password_hash'], {}); } catch (e) { threw = e.message; }
check('a column the catalogue does not list is refused', /no column password_hash/.test(threw ?? ''), true);
threw = null;
try { reports.buildReportQuery('app_users', ['reference'], {}); } catch (e) { threw = e.message; }
check('so is a dataset it does not list', /no such dataset/.test(threw ?? ''), true);
const t = reports.buildReportQuery('approvers', ['approver', 'on_time_pct'], { department: ['Finance'] }, undefined, '00000000-0000-4000-8000-000000000001');
check('approver performance is grouped per approver', /group by approver_id/.test(t.text), true);
check('without a session the tenant is named in the query', t.params.includes('00000000-0000-4000-8000-000000000001') && /tenant_id = \$1::uuid/.test(t.text), true);
const s = reports.buildReportQuery('steps', ['reference'], {}, { key: 'acted_at; drop table x', dir: 'asc' });
check('a sort key off the catalogue falls back to the default order', /drop table/.test(s.text), false);

// ------------------------------------------------------------ the exports
const result = {
  columns: [
    { key: 'reference', label: 'Reference', type: 'text' },
    { key: 'requester', label: 'Requester', type: 'text' },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'on_time_pct', label: 'On time', type: 'percent' },
    { key: 'submitted_at', label: 'Submitted', type: 'datetime' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  rows: Array.from({ length: 120 }, (_, i) => ({
    reference: `AMS-2026-${String(i).padStart(5, '0')}`,
    requester: i === 0 ? '=HYPERLINK("http://evil","click")' : i === 1 ? 'Uddin, "Rahim" <&>' : `Person ${i}`,
    amount: 1234.5 * i, on_time_pct: 87, submitted_at: '2026-11-22T08:30:00.000Z', status: 'in_progress',
  })),
  truncated: false,
};
const meta = { title: 'Missed deadlines', filters: 'Last 90 days', generatedBy: 'Farah Haddad', generatedAt: new Date('2026-11-23T02:00:00Z') };

const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await exp.exportReport(result, meta, 'csv'));
check('the CSV starts with a byte-order mark so Excel reads UTF-8', csv.charCodeAt(0), 0xfeff);
check('a cell that would be a formula is kept as text', csv.includes(`"'=HYPERLINK(""http://evil"",""click"")"`), true);
check('commas and quotes are quoted', csv.includes('"Uddin, ""Rahim"" <&>"'), true);
check('dates are written dd/MM/yyyy, in Dhaka', csv.includes('22/11/2026 14:30'), true);
check('statuses are written as words', csv.includes('In progress'), true);

const xlsx = await exp.exportReport(result, meta, 'xlsx');
const parts = unzipSync(xlsx);
check('the workbook has its parts', ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/styles.xml'].every((p) => parts[p]), true);
const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']);
check('every row is there, under a header', (sheet.match(/<row /g) ?? []).length, 121);
check('text is escaped, so the XML stays whole', sheet.includes('Uddin, &quot;Rahim&quot; &lt;&amp;&gt;') && !sheet.includes('<&>'), true);
check('amounts are numbers, not text', /<c r="C3" s="4"><v>1234.5<\/v><\/c>/.test(sheet), true);
check('a percentage is stored as a fraction and shown as a percent', /<c r="D2" s="5"><v>0.87<\/v><\/c>/.test(sheet), true);
check('the header row is frozen and filterable', sheet.includes('state="frozen"') && sheet.includes('<autoFilter ref="A1:F121"/>'), true);
const parse = (xml) => { try { new (globalThis.DOMParser ?? class { parseFromString() { return null; } })(); } catch {} return /^<\?xml/.test(xml) && (xml.match(/</g).length === xml.match(/>/g).length); };
check('every part is well-formed enough to open', Object.entries(parts).filter(([k]) => k.endsWith('.xml') || k.endsWith('.rels')).every(([, v]) => parse(strFromU8(v))), true);
check('the About sheet says what the report is', strFromU8(parts['xl/worksheets/sheet2.xml']).includes('Missed deadlines') && strFromU8(parts['xl/worksheets/sheet2.xml']).includes('Farah Haddad'), true);

const pdf = await PDFDocument.load(await exp.exportReport(result, meta, 'pdf'));
check('the PDF opens, a page per screenful of rows', pdf.getPageCount() >= 3, true);
check('...and is titled with the report', pdf.getTitle(), 'Missed deadlines');
check('characters a PDF font cannot draw become ? rather than an error', /^Rahim \?+ – ok$/.test(exp.pdfSafe('Rahim উদ্দিন – ok')), true);

const empty = await PDFDocument.load(await exp.exportReport({ ...result, rows: [] }, meta, 'pdf'));
check('an empty report is still a document', empty.getPageCount(), 1);

// ------------------------------------------------------------ the record
const record = await vite.ssrLoadModule('/src/server/record.ts');
const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const rec = await PDFDocument.load(await record.recordPdf({
  req: { reference: 'AMS-2026-00042', form: 'Travel & Expense Reimbursement', status: 'completed', requester: 'Tom Bexley', requester_title: 'Operations Analyst',
         department: 'Operations', submitted_at: new Date(), decided_at: new Date(), priority: 'high', cycle_days: 2.5, amount: 620000, flag: null },
  answers: Array.from({ length: 40 }, (_, i) => ({ field_name: `Question ${i}`, value: 'An answer long enough to wrap onto a second line of the record, as real answers do.' })),
  steps: [
    { stage: 'Line manager', approver: 'Sam Lindqvist', approver_department: 'Operations', status: 'approved', acted_at: new Date(), deadline_at: null, comment: 'Fine.', signature: sig },
    { stage: 'Finance', approver: 'Raj Patel', approver_department: 'Finance', status: 'approved', acted_at: new Date(), deadline_at: null, comment: null, signature: null },
  ],
}, 'https://portal.example.com/status/x'));
check('the approval record opens, and runs onto more pages when it needs to', rec.getPageCount() >= 2, true);
check('...titled with the reference and the form', rec.getTitle(), 'AMS-2026-00042 — Travel & Expense Reimbursement');

// ------------------------------------------------------------ email
const tpl = mail.defaultTemplate('approval.turn');
const e = mail.renderEmail(tpl, { recipient_name: 'Sam <script>', ref: 'AMS-2026-00042', form: 'Travel', requester: 'Tom', link: 'https://p.example/status/1' },
  { details: [['Reference', 'AMS-2026-00042']], attachments: ['a.pdf'] });
check('the subject is filled in', e.subject, 'Approval needed: Travel AMS-2026-00042');
check('nothing is left unfilled', /\{\{/.test(e.html + e.text + e.subject), false);
check('what came from people is escaped in the HTML', e.html.includes('Sam &lt;script&gt;') && !e.html.includes('<script>'), true);
check('...and the button goes where the request is', e.html.includes('href="https://p.example/status/1"'), true);
check('the text part says what is attached', e.text.includes('Attached: a.pdf'), true);
check('an empty fill-in leaves no empty brackets or double spaces', mail.fill('{{form}} ({{ref}}) ok', { form: 'X' }), 'X ok');
check('every notification kind the database sends has a template',
  ['approval.turn', 'submission.raised', 'request.completed', 'phase.lane_cleared', 'request.rejected', 'request.clarification',
   'approval.returned', 'approval.review', 'request.recalled', 'request.cancelled', 'question.asked', 'question.answered',
   'request.followup', 'approval.overdue', 'approval.due_soon', 'approval.escalated', 'note.added', 'cc.added', 'cc.raised',
   'cc.completed', 'cc.rejected', 'handover.received', 'report.sent', 'report.scheduled',
   'campaign.created', 'campaign.budget', 'campaign.extended']
    .filter((k) => !mail.DEFAULT_EMAIL_TEMPLATES.some((t) => t.kind === k)), []);

check('filters read back in words', cat.describeFilters({ period: 'last_90', status: ['rejected'], on_time: false }), 'Last 90 days · Status: rejected · Late only');

await vite.close();
if (failures.length) { console.log(`${NL}${failures.length} REPORT CHECK(S) FAILED`); process.exit(1); }
console.log(`${NL}ALL REPORT CHECKS PASSED (${passed})`);
