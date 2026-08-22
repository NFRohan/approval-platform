// =====================================================================
// Render smoke test.
//
//   npm run test:render
//
// Loads every route module through Vite's SSR pipeline and renders its
// component once. Effects do not run, so this proves nothing about data
// — it proves the module loads and the component renders at all.
//
// `vite build` cannot tell you that. It compiles code that throws the
// moment it renders, and after a cutover that touches 22 files the
// failure mode is a blank screen rather than an error.
// =====================================================================

import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import React from 'react';

// A real DOM rather than a hand-written stub. Component libraries touch
// the document at import time — sonner injects a stylesheet the moment it
// loads — and every stub grows until it is a bad DOM implementation.
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.test/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator ??= dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.matchMedia = dom.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
globalThis.localStorage = dom.window.localStorage;
globalThis.self ??= dom.window;          // some bundles assume a worker-ish global
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

// One module, one graph — see scripts/harness.tsx.
const { renderPath } = await server.ssrLoadModule('/scripts/harness.tsx');

// Real ids for the routes that take a parameter. Inventing a uuid would
// exercise the not-found path instead of the screen, and the detail
// screens are the ones most likely to break in a cutover.
const { getPool } = await server.ssrLoadModule('/src/server/db.ts');
const pool = getPool();
const pick = async (sql) => (await pool.query(sql)).rows[0]?.id ?? null;

// ---------------------------------------------------------------------
// Every persona the switcher offers must be a real employee.
//
// These two drifted apart once already: the schema port renumbered every
// employee, and the hardcoded persona list kept the old identifiers. No
// persona matched anybody and every queue came back empty — while the
// build, the type checker and every suite stayed green, because nothing
// compared the two.
// ---------------------------------------------------------------------
const { USERS } = await server.ssrLoadModule('/src/contexts/CurrentUserContext.tsx');
const { rows: known } = await pool.query(
  `select distinct employee_id from public.employees`);
const knownIds = new Set(known.map((r) => r.employee_id));
const strangers = USERS.filter((u) => !knownIds.has(u.employee_id));
if (strangers.length) {
  console.log(`
  PERSONAS THAT MATCH NO EMPLOYEE:
`);
  for (const u of strangers) console.log(`    ${u.employee_id}  ${u.name}`);
  console.log('');
  process.exit(1);
}
console.log(`  ${USERS.length} personas, all of them real employees`);


// Ids come from any real evaluation rather than one named in the
// environment. Sign-in replaced DEMO_TENANT_SLUG, so a test that still
// read it silently found nothing and quietly rendered four routes fewer
// while still printing that everything passed.
const submissionId = await pick(
  `select s.id from public.form_submissions s
     join public.tenants t on t.id = s.tenant_id
    where t.kind = 'demo' order by s.submitted_at desc limit 1`);
const formId = await pick(
  `select f.id from public.form_templates f
     join public.tenants t on t.id = f.tenant_id
    where t.kind = 'demo' and f.status = 'published' limit 1`);
const noticeId = await pick(
  `select n.id from public.notices n
     join public.tenants t on t.id = n.tenant_id
    where t.kind = 'demo' limit 1`);

// A missing id is a broken fixture, not a reason to test less. The
// detail screens are the ones most likely to break, so skipping them is
// the worst possible thing to do quietly.
const missing = Object.entries({ submissionId, formId, noticeId })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.log(`\n  NO FIXTURE FOR: ${missing.join(', ')}`);
  console.log('  Mint an evaluation first: node --env-file=.env scripts/dev-tenant.mjs\n');
  process.exit(1);
}

const PATHS = [
  '/', '/login', '/staff', '/activity', '/approvals', '/approvals/delegate', '/approvals/history',
  '/builder', '/builder/approvers', '/builder/notifications',
  '/forms', '/maintenance', '/movement-orders',
  '/notices', '/notices/new', '/stationery', '/submissions',
  `/forms/${formId}`,
  `/status/${submissionId}`,
  `/certificate/${submissionId}`,
  `/notices/${noticeId}`,
];

let failed = 0;
for (const path of PATHS) {
  try {
    await renderPath(path);
    console.log('  pass: ', path);
  } catch (err) {
    failed += 1;
    console.log('  FAIL: ', path, '-', String(err.message).split(String.fromCharCode(10))[0]);
  }
}

await pool.end();
await server.close();

if (failed) {
  console.log(`\n${failed} route(s) cannot render\n`);
  process.exit(1);
}
console.log(`\nALL ${PATHS.length} ROUTES RENDER\n`);
