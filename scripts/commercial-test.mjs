// =====================================================================
// Word documents, top sheets and inbound mail, without a database.
//
//   npm run test:commercial
//
// The sample NFA's two business cases come out field by field; labels
// written the way NFAs write them find the form's questions; amounts in
// crore and lakh, dates in four formats; the top sheet's words for an
// amount; a PO description wrapped rather than cut; and both shapes of
// inbound mail understood.
// =====================================================================

import { createServer } from 'vite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { strToU8, zipSync } from 'fflate';

const NL = String.fromCharCode(10);
process.env.JWT_SECRET ||= 'commercial-test-secret-that-is-long-enough';
let passed = 0;
const failures = [];
function check(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { passed += 1; console.log(`  pass: ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
const docx = await vite.ssrLoadModule('/src/server/docx.ts');
const top = await vite.ssrLoadModule('/src/server/topsheet.ts');
const inbound = await vite.ssrLoadModule('/src/server/inbound.ts');

console.log(NL + 'commercial' + NL);

// ------------------------------------------------------------ the sample NFA
const FIELDS = [
  ['Campaign name', 'text'], ['Audience', 'select', ['Customer', 'Agent', 'Merchant', 'Distributor', 'Field force', 'Internal']],
  ['Modality', 'select', ['Cashback', 'Discount', 'Coupon', 'Bonus', 'Free transfer']], ['Start date', 'date'], ['End date', 'date'],
  ['KPI section', 'section_header'], ['Beneficiary count', 'number'], ['Transaction count', 'number'], ['Transaction volume', 'number'],
  ['bKash cost', 'number'], ['Total cost', 'money'], ['Wallet', 'multi_select', ['Customer', 'Agent', 'Merchant', 'Distributor']],
  ['Wallet-wise budget', 'textarea'], ['Cost center', 'text'], ['GL code', 'text'], ['Product', 'text'], ['Campaign beneficiary', 'text'],
].map(([label, kind, options], i) => ({ id: 'f' + i, label, kind, options }));
const val = (ms, label) => ms.find((m) => m.fieldLabel === label)?.value;

const x = docx.extract(docx.sampleNfaDocx(new Date('2026-11-23T00:00:00Z')), FIELDS);
check('the sample NFA holds two business cases', x.cases.map((c) => c.title),
  ['Business Case 1: Winter Cashback for Customers', 'Business Case 2: Agent Cash-in Incentive']);
check('what the whole NFA says is common to both', x.common.map((m) => [m.fieldLabel, m.value]),
  [['Cost center', 'CC-4120'], ['GL code', '623045'], ['Product', 'Send Money and Payment']]);
const c1 = x.cases[0].matches, c2 = x.cases[1].matches;
check('labels as NFAs write them find the questions', [val(c1, 'Campaign name'), val(c1, 'Audience'), val(c1, 'Modality')],
  ['Winter Cashback 2026', 'Customer', 'Cashback']);
check('dates written dd/MM/yyyy are read', [val(c1, 'Start date'), val(c1, 'End date')], ['2026-12-07', '2027-01-20']);
check('KPI tables are read, crore included', [val(c1, 'Beneficiary count'), val(c1, 'Transaction volume'), val(c1, 'Total cost')],
  ['45000', '95000000', '3800000']);
check('a wallet table becomes the wallets and their budgets', [val(c1, 'Wallet'), val(c1, 'Wallet-wise budget')],
  ['["Customer","Agent"]', 'Customer: 3,000,000' + NL + 'Agent: 800,000']);
check('the second case is its own', [val(c2, 'Campaign name'), val(c2, 'Audience'), val(c2, 'Total cost')],
  ['Winter Agent Cash-in Boost', 'Agent', '1200000']);
check('nothing in the sample went unread', x.unmatched, []);

// ------------------------------------------------------------ a document written differently
const W = (inner) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${inner}</w:body></w:document>`;
const P = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${t}</w:t></w:r></w:p>`;
const split = (a, b) => `<w:p><w:r><w:t xml:space="preserve">${a}</w:t></w:r><w:r><w:t>${b}</w:t></w:r></w:p>`;
const doc = zipSync({ 'word/document.xml': strToU8(W([
  P('Note for Approval', 'Title'),
  split('Campaign Title: ', 'Pohela Falgun &amp; Valentine'),
  P('Target Audience: Merchant'),
  P('Offer Type: Discount at checkout'),
  P('From: 14 February 2027'),
  P('To: February 28, 2027'),
  P('Total Budget: 12 lakh'),
  P('Cost Centre Code: CC-77'),
  P('Business case: a short paragraph that is a field, not a case.'),
  P('Approver remarks: none'),
].join(''))) });
const y = docx.extract(doc, FIELDS);
check('a document with no business cases fills one form', y.cases.length, 0);
check('text split across runs is one value, entities decoded', val(y.common, 'Campaign name'), 'Pohela Falgun & Valentine');
check('"Offer Type: Discount at checkout" chooses the Discount option', val(y.common, 'Modality'), 'Discount');
check('dates in words, either way round', [val(y.common, 'Start date'), val(y.common, 'End date')], ['2027-02-14', '2027-02-28']);
check('12 lakh is 1,200,000', val(y.common, 'Total cost'), '1200000');
check('"Cost Centre Code" is the cost center', val(y.common, 'Cost center'), 'CC-77');
check('what the form does not ask is reported, not lost', y.unmatched.map((u) => u.label), ['Business case', 'Approver remarks']);
let threw = null;
try { docx.readDocx(strToU8('not a zip')); } catch (e) { threw = e.message; }
check('a file that is not a Word document is refused', !!threw, true);

check('numbers as people write them', ['BDT 1,200,000.50', '2 crore', '3.5 million', '45k', 'n/a'].map(docx.toNumber),
  [1200000.5, 20000000, 3500000, 45000, null]);
check('dates as people write them', ['01/12/2026', '1st December 2026', 'Dec 1, 2026', '2026-12-01', 'soon'].map(docx.toIsoDate),
  ['2026-12-01', '2026-12-01', '2026-12-01', '2026-12-01', null]);

// ------------------------------------------------------------ the top sheet
check('an amount in words, lakh and crore', top.takaInWords(123456789.5),
  'Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine Taka and Fifty Paisa only');
check('...small amounts', [top.takaInWords(0), top.takaInWords(1005), top.takaInWords(100000)],
  ['Zero Taka only', 'One Thousand Five Taka only', 'One Lakh Taka only']);
check('PO lines, however many cells they have',
  top.parsePoLines('PO-1 | Laptops for the field team | 450,000' + NL + 'Furniture | 80000' + NL + 'Installation'),
  [{ po: 'PO-1', description: 'Laptops for the field team', amount: 450000 }, { po: '', description: 'Furniture', amount: 80000 },
   { po: '', description: 'Installation', amount: null }]);
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const long = 'Supply and installation of 120 ergonomic workstations with cable management, monitor arms and a three-year on-site warranty, delivered to the Gulshan and Motijheel offices in two batches';
const wrapped = top.wrapText(long, font, 9, 200);
check('a long PO description wraps onto lines, every word kept', wrapped.length > 3 && wrapped.join(' ') === long, true);
check('...and no line is wider than its column', wrapped.every((l) => font.widthOfTextAtSize(l, 9) <= 200), true);
check('a word longer than the column is broken, not dropped', top.wrapText('PO-2026-000000000000000000000000-ALPHA', font, 9, 60).join(''), 'PO-2026-000000000000000000000000-ALPHA');

const sheet = await PDFDocument.load(await top.topSheetPdf({
  req: { reference: 'AMS-2026-00099', form: 'Capital Expenditure Request', requester: 'Mei Sun', requester_title: 'Procurement Specialist',
         department: 'Operations', submitted_at: '2026-11-20T04:00:00Z', amount: 530000, tenant_id: 't' },
  a: { 'PO lines': `PO-77 | ${long} | 450,000${NL}PO-78 | Delivery | 80,000`, 'Cost center': 'CC-1', 'GL code': '6100', Classification: 'Budgetary', Project: 'Office refit' },
  steps: [{ stage: 'Line manager', approver: 'Sam Lindqvist', status: 'approved', acted_at: '2026-11-21T04:00:00Z', signature: null, designation: 'Line Manager' },
          { stage: 'Finance', approver: 'Raj Patel', status: 'pending', acted_at: null, signature: null, designation: 'Finance Controller' }],
  org: 'Acme',
}));
check('the top sheet opens', sheet.getPageCount(), 1);
check('...and is titled with its reference', sheet.getTitle(), 'Payment top sheet AMS-2026-00099');

// ------------------------------------------------------------ inbound mail
const plain = inbound.normaliseInbound({ from: 'Ayesha <a@gp.com>', subject: 'Hi', text: 'Body',
  attachments: [{ filename: 'brief/../x.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF').toString('base64') }] });
check('a plain message is understood, its attachment named safely', [plain.from, plain.subject, plain.attachments[0].filename, plain.attachments[0].content.toString()],
  ['Ayesha <a@gp.com>', 'Hi', 'brief_.._x.pdf', '%PDF']);
const pm = inbound.normaliseInbound({ From: 'b@robi.com.bd', Subject: 'S', HtmlBody: '<p>Hello <b>there</b></p>',
  Attachments: [{ Name: 'a.txt', ContentType: 'text/plain', Content: Buffer.from('x').toString('base64') }] });
check('Postmark\'s shape too, HTML read as text', [pm.from, pm.text.trim(), pm.attachments.length], ['b@robi.com.bd', 'Hello there', 1]);
check('a message with no sender is refused', inbound.normaliseInbound({ subject: 'x' }), null);

await vite.close();
if (failures.length) { console.log(`${NL}${failures.length} COMMERCIAL CHECK(S) FAILED`); process.exit(1); }
console.log(`${NL}ALL COMMERCIAL CHECKS PASSED (${passed})`);
