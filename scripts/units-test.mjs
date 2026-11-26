// =====================================================================
// npm run test:units — the small pieces of logic that broke this week,
// checked on their own, offline: formulas (no eval, under the content
// security policy), field limits, dd/MM/yyyy entry and display, and the
// spreadsheet-formula guard on CSV exports.
// =====================================================================

import { createServer } from 'vite';

const NL = '\n';
let passed = 0;
const failures = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  pass: ${label}`); }
  else { failures.push(label); console.log(`  FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
const { evaluateFormula } = await vite.ssrLoadModule('/src/lib/formula.ts');
const { validateField } = await vite.ssrLoadModule('/src/lib/validateField.ts');
const { parseDate, isoToDmy, withSlashes } = await vite.ssrLoadModule('/src/components/DateInput.tsx');
const { fmtDate } = await vite.ssrLoadModule('/src/lib/dates.ts');
const { escapeCsvCell } = await vite.ssrLoadModule('/src/lib/csv.ts');

// ---------------------------------------------------------------- formulas
console.log(NL + 'formulas');
const F = [
  { id: 'u', label: 'Units', kind: 'number' },
  { id: 'c', label: 'Unit cost', kind: 'money' },
  { id: 't', label: 'Line total', kind: 'calculation', formula: '{Units} * {Unit cost}' },
  { id: 'v', label: 'With VAT', kind: 'calculation', formula: 'ROUND({Line total} * 1.15)' },
  { id: 'x', label: 'Loop', kind: 'calculation', formula: '{Loop} + 1' },
];
const V = { u: '2', c: '30,000' };
check('a product of two answers (30,000 read as a number)', evaluateFormula('{Units} * {Unit cost}', F, V), 60000);
check('a calculation built on another calculation', evaluateFormula(F[3].formula, F, V, 'v'), 69000);
check('precedence: 2 + 3 * 4', evaluateFormula('2 + 3 * 4', F, {}), 14);
check('brackets: (2 + 3) * 4', evaluateFormula('(2 + 3) * 4', F, {}), 20);
check('MAX and MIN', evaluateFormula('MAX(1, 7, 3) - MIN(4, 2)', F, {}), 5);
check('a system figure ({ALLOWANCE})', evaluateFormula('{ALLOWANCE} / 2', F, {}), 10000);
check('a formula naming itself is 0, not a hang', evaluateFormula('{Loop} + 1', F, {}, 'x'), 1);
check('code is not run: alert(1)', evaluateFormula('alert(1)', F, {}), null);
check('code is not run: constructor tricks', evaluateFormula('[].constructor.constructor("return 1")()', F, {}), null);
check('dividing by zero is no answer', evaluateFormula('1 / 0', F, {}) === null || !Number.isFinite(evaluateFormula('1 / 0', F, {})), true);

// ---------------------------------------------------------------- field limits
console.log(NL + 'field limits');
const units = { label: 'Units', kind: 'number', required: true, validation: { min: 1, max: 10 } };
check('12 where at most 10 is allowed', validateField(units, '12'), 'Units must be at most 10');
check('0 where at least 1 is needed', validateField(units, '0'), 'Units must be at least 1');
check('5 is fine', validateField(units, '5'), null);
check('empty and required', validateField(units, ''), 'Units is required');
check('a word in a number field', validateField(units, 'ten'), 'Units must be a number');
const name = { label: 'Name', kind: 'text', required: false, validation: { minLength: 3, maxLength: 5 } };
check('too short', validateField(name, 'ab'), 'Name must be at least 3 characters');
check('too long', validateField(name, 'abcdef'), 'Name must be at most 5 characters');
check('not required and empty: no limits apply', validateField(name, ''), null);
check('a required checkbox left unticked is missing',
  validateField({ label: 'I confirm', kind: 'checkbox', required: true }, false), 'I confirm is required');

// ---------------------------------------------------------------- dates, dd/MM/yyyy
console.log(NL + 'dates');
check('typing 02112026 reads 02/11/2026', withSlashes('02112026'), '02/11/2026');
check('typing 0211 reads 02/11', withSlashes('0211'), '02/11');
check('slashes typed by hand are kept', withSlashes('2/11/2026'), '2/11/2026');
check('dd/MM/yyyy to ISO', parseDate('02/11/2026'), '2026-11-02');
check('a pasted ISO date is understood', parseDate('2026-11-02'), '2026-11-02');
check('31/02 is not a date', parseDate('31/02/2026'), null);
check('ISO to dd/MM/yyyy', isoToDmy('2026-12-15'), '15/12/2026');
check('display is dd/MM/yyyy', fmtDate('2026-12-15'), '15/12/2026');

// ---------------------------------------------------------------- CSV
console.log(NL + 'CSV');
check('a cell that would be a spreadsheet formula stays text', escapeCsvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
check('...and one starting with @', escapeCsvCell('@SUM(A1)'), "'@SUM(A1)");
check('a negative number is left alone', escapeCsvCell(-5), '-5');
check('commas are quoted', escapeCsvCell('a,b'), '"a,b"');

await vite.close();
if (failures.length) { console.log(`${NL}${failures.length} UNIT CHECK(S) FAILED`); process.exit(1); }
console.log(`${NL}ALL UNIT CHECKS PASSED (${passed})`);
