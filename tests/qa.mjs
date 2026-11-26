// =====================================================================
// npm run qa — every check this project has, in one run, one report.
//
//   npm run qa                 static checks, offline suites, every DB
//                              suite on PGlite, a fresh build, every
//                              browser walk (3 at a time)
//   npm run qa -- --sweep      ...and the screen-by-screen UI sweep
//   npm run qa -- --neon       ...and the suites that run against Neon
//                              (render, db:test, journey, auth) — they
//                              read and write the shared database
//   npm run qa -- --only=qa_   only walks whose name contains "qa_"
//   npm run qa -- --no-build   reuse dist/ as it is
//   npm run qa -- --jobs=4     walks at a time
//
// Writes tests/qa-report/index.html (open it in a browser) and
// report.json; a failing walk check leaves a screenshot of the page in
// tests/qa-report/shots. Exits 1 if anything failed. Nothing here
// touches Neon unless --neon is given.
// =====================================================================

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WALKS = path.join(ROOT, 'tests', 'walks');
const OUT = path.join(ROOT, 'tests', 'qa-report');
const SHOTS = path.join(OUT, 'shots');

const args = new Set(process.argv.slice(2));
const opt = (name) => [...args].find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const JOBS = Number(opt('jobs') ?? 3);
const ONLY = opt('only');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** Run a command; resolve with its exit code and output. Never rejects. */
function run(cmd, cmdArgs, { cwd = ROOT, env = {}, timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    // npm and npx are .cmd scripts on Windows and need a shell; node itself
    // must not go through one (its path has a space in it there).
    const shell = process.platform === 'win32' && (cmd === npm || cmd === npx);
    const child = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, shell });
    const timer = setTimeout(() => { out += `\n[qa] timed out after ${timeoutMs / 1000}s\n`; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, ms: Date.now() - t0 }); });
  });
}

/** Pull pass/fail checks out of a suite's output, whatever dialect it prints. */
function checksOf(out) {
  const checks = [];
  let lastFail = null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    let m;
    if ((m = line.match(/^\s*(PASS|pass:?)\s+(.*)$/))) checks.push({ ok: true, label: m[2].trim() });
    else if ((m = line.match(/^\s*(FAIL|FAIL:)\s+(.*)$/))) {
      const [label, detail] = m[2].split(/\s+—\s+/, 2);
      lastFail = { ok: false, label: label.trim(), detail: detail?.trim() };
      checks.push(lastFail);
    } else if ((m = line.match(/^SHOT\s+(.*)$/)) && lastFail) {
      lastFail.shot = path.relative(OUT, m[1].trim()).replace(/\\/g, '/');
    }
  }
  return checks;
}

const results = [];
function record(phase, name, r) {
  const checks = checksOf(r.out);
  const failed = checks.filter((c) => !c.ok).length;
  // A suite that failed without naming a check (a crash, a timeout) still fails.
  const crashed = r.code !== 0 && failed === 0;
  results.push({ phase, name, code: r.code, ms: r.ms, checks, crashed, tail: crashed ? r.out.split(/\r?\n/).slice(-25).join('\n') : undefined });
  const mark = r.code === 0 ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${phase.padEnd(8)} ${name.padEnd(34)} ${String(checks.filter((c) => c.ok).length).padStart(4)} passed ${String(failed).padStart(3)} failed  ${(r.ms / 1000).toFixed(0)}s${crashed ? '  (crashed — see report)' : ''}`);
}

const started = Date.now();
console.log(`QA run — ${new Date().toISOString()}`);

// 1. Static and offline suites -----------------------------------------
if (!ONLY) {
  record('static', 'typecheck', await run(npx, ['tsc', '--noEmit', '-p', '.']));
  for (const s of ['test:callsites', 'test:units', 'test:identity', 'test:reports', 'test:commercial', 'test:integration']) {
    record('offline', s, await run(npm, ['run', '-s', s]));
  }
  // 2. Every database suite, on PGlite ----------------------------------
  record('database', 'db:test:local', await run(npm, ['run', '-s', 'db:test:local'], { timeoutMs: 30 * 60_000 }));
}

// 3. A fresh build for the walks -----------------------------------------
if (!args.has('--no-build')) {
  const b = await run(npm, ['run', '-s', 'build']);
  record('build', 'vite build', b);
  if (b.code !== 0) { finish(); }
}

// 4. Every browser walk, a few at a time ---------------------------------
// e2e4 needs Docker (OpenLDAP); idle needs its own session length; e2e12
// is a screenshot only; the sweep runs with --sweep.
const SKIP = /^(e2e4|e2e4r|e2e12|idle.*|sweep|dbg.*)$/;
const walks = readdirSync(WALKS)
  .filter((f) => f.endsWith('_body.mjs'))
  .map((f) => f.replace(/_body\.mjs$/, ''))
  .filter((n) => !SKIP.test(n) || (n === 'sweep' && args.has('--sweep')))
  .filter((n) => !ONLY || n.includes(ONLY))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

const head = readFileSync(path.join(WALKS, 'harness_head.mjs'), 'utf8');
async function walk(name) {
  const file = path.join(WALKS, `${name}.run.mjs`);
  writeFileSync(file, head + '\n' + readFileSync(path.join(WALKS, `${name}_body.mjs`), 'utf8'));
  const r = await run(process.execPath, [file], { cwd: WALKS, env: { QA_SHOTS: SHOTS, QA_WALK: name }, timeoutMs: 15 * 60_000 });
  record('walk', name, r);
}
const queue = [...walks];
await Promise.all(Array.from({ length: Math.max(1, Math.min(JOBS, os.cpus().length)) }, async () => {
  while (queue.length) await walk(queue.shift());
}));

// 5. Against Neon, only when asked ---------------------------------------
if (args.has('--neon')) {
  for (const s of ['test:render', 'db:test', 'test:journey', 'test:auth']) {
    record('neon', s, await run(npm, ['run', '-s', s], { timeoutMs: 30 * 60_000 }));
  }
}

finish();

// ---------------------------------------------------------------------
function finish() {
  const all = results.flatMap((r) => r.checks);
  const passed = all.filter((c) => c.ok).length;
  const failed = all.filter((c) => !c.ok).length;
  const crashed = results.filter((r) => r.crashed).length;
  const summary = { when: new Date().toISOString(), minutes: +((Date.now() - started) / 60000).toFixed(1), suites: results.length, passed, failed, crashed };
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ summary, results }, null, 1));
  writeFileSync(path.join(OUT, 'index.html'), html(summary, results));
  console.log(`\n${failed || crashed ? 'QA FAILED' : 'QA PASSED'}: ${passed} checks passed, ${failed} failed, ${crashed} suites crashed, in ${summary.minutes} min`);
  console.log(`Report: ${path.join(OUT, 'index.html')}`);
  process.exit(failed || crashed ? 1 : 0);
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function html(summary, results) {
  const bad = summary.failed + summary.crashed;
  const rows = [...results].sort((a, b) => (b.checks.some((c) => !c.ok) || b.crashed) - (a.checks.some((c) => !c.ok) || a.crashed));
  const suite = (r) => {
    const f = r.checks.filter((c) => !c.ok);
    const status = r.crashed ? 'crashed' : f.length ? `${f.length} failed` : 'passed';
    const cls = r.crashed || f.length ? 'bad' : 'good';
    return `<details ${cls === 'bad' ? 'open' : ''} class="${cls}"><summary><span class="pill ${cls}">${status}</span> <b>${esc(r.name)}</b> <span class="muted">${esc(r.phase)} · ${r.checks.length} checks · ${(r.ms / 1000).toFixed(0)} s</span></summary>
      ${r.crashed ? `<pre>${esc(r.tail)}</pre>` : ''}
      <ul>${[...f, ...r.checks.filter((c) => c.ok)].map((c) => `<li class="${c.ok ? 'p' : 'f'}">${c.ok ? '✓' : '✗'} ${esc(c.label)}${c.detail ? `<div class="detail">${esc(c.detail)}</div>` : ''}${c.shot ? `<div><a href="${esc(c.shot)}"><img src="${esc(c.shot)}" alt="the page when it failed"></a></div>` : ''}</li>`).join('')}</ul></details>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA report</title>
<style>
:root{--bg:#fafafa;--fg:#18181b;--muted:#71717a;--card:#fff;--line:#e4e4e7;--good:#15803d;--goodbg:#f0fdf4;--bad:#b91c1c;--badbg:#fef2f2}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--fg:#f4f4f5;--muted:#a1a1aa;--card:#18181b;--line:#27272a;--good:#4ade80;--goodbg:#052e16;--bad:#f87171;--badbg:#2a0a0a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted);font-weight:400}
.totals{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0 24px}.totals div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.totals b{display:block;font-size:22px}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:8px 0;padding:8px 14px}
summary{cursor:pointer}ul{list-style:none;padding:0;margin:8px 0 4px}li{padding:3px 0;border-top:1px solid var(--line)}
li.f{color:var(--bad)}li.p{color:var(--muted)}.detail{font-size:12.5px;color:var(--fg);opacity:.85;white-space:pre-wrap;word-break:break-word}
img{max-width:100%;border:1px solid var(--line);border-radius:6px;margin:6px 0}
.pill{font-size:12px;padding:1px 8px;border-radius:999px}.pill.good{background:var(--goodbg);color:var(--good)}.pill.bad{background:var(--badbg);color:var(--bad)}
pre{white-space:pre-wrap;font-size:12px;background:var(--bg);padding:8px;border-radius:6px;overflow-x:auto}
.verdict{font-weight:600;color:${bad ? 'var(--bad)' : 'var(--good)'}}
</style></head><body><main>
<h1>QA report <span class="muted">${esc(new Date(summary.when).toLocaleString())}</span></h1>
<div class="verdict">${bad ? 'Something failed — failures are listed first.' : 'Everything passed.'}</div>
<div class="totals"><div><b>${summary.passed}</b>checks passed</div><div><b>${summary.failed}</b>checks failed</div><div><b>${summary.crashed}</b>suites crashed</div><div><b>${summary.suites}</b>suites</div><div><b>${summary.minutes}</b>minutes</div></div>
${rows.map(suite).join('\n')}
</main></body></html>`;
}
