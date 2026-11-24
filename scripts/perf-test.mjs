// =====================================================================
// Performance and capacity: npm run test:perf
//
// What the scope asks of the system: reports in 5 seconds, 10–20 lakh
// rows within 5 minutes, 5,000 requests a day, 2,000 users growing 30%
// a year, any activity answered in well under 20 seconds.
//
// A real Postgres (embedded-postgres: the server binaries, started in a
// temporary directory and removed after) with every migration and one
// evaluation, then PERF_ROWS requests (default 2,000,000) with a step
// and an amount each, spread over two years. Then:
//
//   1. Reports, analytics and the main tracker over all of them, each
//      run three times; the median is reported.
//   2. The production build, serving the Open API, under PERF_USERS
//      concurrent clients (default 25) for PERF_SECONDS (default 60):
//      listing, reading, raising (each raise builds its approval chain,
//      notifies and queues email) and approval queues.
//
// Writes docs/PERFORMANCE.md. Nothing here touches the Neon database.
// =====================================================================

import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const ROWS = Number(process.env.PERF_ROWS ?? 2_000_000);
const USERS = Number(process.env.PERF_USERS ?? 25);
const SECONDS = Number(process.env.PERF_SECONDS ?? 60);
const PORT = 54329;
const dir = path.join(os.tmpdir(), `ams-perf-${Date.now()}`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (n) => n.toLocaleString('en-IN');

const epg = new EmbeddedPostgres({
  databaseDir: dir, user: 'postgres', password: 'perf', port: PORT, persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'shared_buffers=512MB', '-c', 'work_mem=64MB', '-c', 'maintenance_work_mem=512MB',
                  '-c', 'max_connections=120', '-c', 'synchronous_commit=off', '-c', 'fsync=off'],
  onLog: (m) => { if (process.env.PERF_DEBUG) console.log('[pg]', String(m).trim()); }, onError: (m) => console.log('[pg!]', String(m).trim().slice(0, 400)),
});
let stopped = false;
async function stop() { if (stopped) return; stopped = true; try { await epg.stop(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} }
process.on('SIGINT', async () => { await stop(); process.exit(1); });

const out = { machine: `${os.cpus()[0]?.model?.trim()} · ${os.cpus().length} threads · ${Math.round(os.totalmem() / 2 ** 30)} GB RAM · ${os.platform()} ${os.release()}`, rows: ROWS, timings: [], load: null };

try {
  log('starting Postgres in', dir);
  await epg.initialise();
  await epg.start();
  await epg.createDatabase('ams');
  const url = `postgres://postgres:perf@127.0.0.1:${PORT}/ams`;
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.PGPOOL_MAX = '40';
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  db.on('error', (e) => log('database connection:', e.message));
  const q = (sql, params) => db.query(sql, params);

  log('applying migrations');
  for (const f of readdirSync('db').filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) await q(readFileSync(`db/${f}`, 'utf8'));

  const scrypt = promisify(scryptCb);
  const salt = randomBytes(16);
  const hash = ['scrypt', salt.toString('hex'), (await scrypt('perf-password-1', salt, 64)).toString('hex')].join('$');
  await q(`select set_config('app.is_staff', 'true', false)`);
  const { rows: [t] } = await q(`select * from app.provision_demo('Performance', 'perf.test', $1, interval '7 days')`, [hash]);
  await q(`select set_config('app.is_staff', 'false', false)`);
  const tenant = t.tenant_id;
  const { rows: [acct] } = await q(`select id from public.app_users where tenant_id = $1 limit 1`, [tenant]);

  // ------------------------------------------------------------- data
  log(`generating ${fmt(ROWS)} requests, a step and an amount each`);
  const t0 = process.hrtime.bigint();
  await q(`set session_replication_role = replica`);   // no triggers for the bulk load: no mail, no webhooks
  await q(`
    insert into public.form_submissions (id, tenant_id, form_template_id, submitted_by, status, submitted_at, ref_number, priority, closed_at)
    select gen_random_uuid(), $1, f.ids[1 + (i % cardinality(f.ids))], e.ids[1 + ((i * 7) % cardinality(e.ids))],
           case when i % 10 < 6 then 'completed' when i % 10 < 8 then 'in_progress' when i % 10 < 9 then 'rejected' else 'cancelled' end,
           now() - make_interval(days => i % 730, mins => i % 1440),
           'PERF-' || lpad(i::text, 8, '0'),
           case when i % 20 = 0 then 'urgent' when i % 7 = 0 then 'high' else 'normal' end,
           case when i % 10 < 6 or i % 10 = 8 then now() - make_interval(days => i % 730, mins => i % 1440) + make_interval(days => 1 + i % 9) end
      from generate_series(1, $2::int) i,
           (select array_agg(id order by name) ids from public.form_templates where tenant_id = $1 and status = 'published') f,
           (select array_agg(employee_id order by employee_id) ids from public.employees where tenant_id = $1 and active) e`, [tenant, ROWS]);
  await q(`
    insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index, lane, lane_step, status, deadline_at, opened_at, acted_at, created_at)
    select s.tenant_id, s.id, e.ids[1 + (abs(hashtext(s.id::text)) % cardinality(e.ids))], 0, 0, 0,
           case s.status when 'completed' then 'approved' when 'rejected' then 'rejected' when 'in_progress' then 'pending' else 'skipped' end,
           s.submitted_at + interval '3 days', s.submitted_at, s.closed_at, s.submitted_at
      from public.form_submissions s,
           (select array_agg(employee_id order by employee_id) ids from public.employees where tenant_id = $1 and active) e
     where s.tenant_id = $1 and s.ref_number like 'PERF-%'`, [tenant]);
  await q(`
    insert into public.submission_values (tenant_id, submission_id, field_name, value)
    select s.tenant_id, s.id, 'Amount', ((abs(hashtext(s.id::text)) % 5000000) + 1000)::text
      from public.form_submissions s where s.tenant_id = $1 and s.ref_number like 'PERF-%'`, [tenant]);
  await q(`set session_replication_role = origin`);
  await q(`analyze`);
  const { rows: [counts] } = await q(`select (select count(*) from public.form_submissions where tenant_id = $1)::int subs,
                                             (select count(*) from public.approval_requests where tenant_id = $1)::int steps,
                                             (select count(*) from public.submission_values where tenant_id = $1)::int vals`, [tenant]);
  out.load_seconds = Math.round(ms(t0) / 1000);
  out.counts = counts;
  log('loaded', counts, `in ${out.load_seconds} s`);

  // ------------------------------------------------------------- reports
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
  const dbm = await vite.ssrLoadModule('/src/server/db.ts');
  const reports = await vite.ssrLoadModule('/src/server/reports.ts');
  const exporter = await vite.ssrLoadModule('/src/server/export.ts');
  const cat = await vite.ssrLoadModule('/src/lib/report-catalogue.ts');
  const ctx = { tenantId: tenant, userId: acct.id, role: 'admin', employeeId: 'EMP-0445', mfa: true };
  const all = (d) => cat.columnsOf(d).map((c) => c.key);

  async function time(label, target, fn) {
    const runs = [];
    let detail = '';
    for (let i = 0; i < 3; i++) {
      const s = process.hrtime.bigint();
      detail = (await fn()) ?? '';
      runs.push(ms(s));
    }
    const m = median(runs);
    out.timings.push({ label, ms: Math.round(m), target, detail });
    log(`${label}: ${Math.round(m)} ms ${detail}`);
  }
  const report = (d, f, sort) => dbm.withContext(ctx, (c) => reports.runReport(c, d, all(d), f, sort, tenant));

  let biggest;
  await time('Requests report, all time, every column (first 5,000 rows)', 5000, async () => {
    biggest = await report('requests', { period: 'all' });
    return `${fmt(biggest.rows.length)} rows`;
  });
  await time('Requests report, rejected in the last 90 days, searched', 5000, async () =>
    `${fmt((await report('requests', { period: 'last_90', status: ['rejected'], search: 'Travel' })).rows.length)} rows`);
  await time('Approval steps report, this year, late only', 5000, async () =>
    `${fmt((await report('steps', { period: 'this_year', on_time: false })).rows.length)} rows`);
  await time(`Approver performance over all ${fmt(ROWS)} steps (aggregate)`, 5000, async () =>
    `${fmt((await report('approvers', { period: 'all' })).rows.length)} approvers`);
  await time('Analytics: the year\'s headline figures', 5000, () => dbm.withContext(ctx, async (c) => {
    const { rows: [k] } = await c.query(`
      select count(*)::int raised, count(*) filter (where status = 'completed')::int completed,
             round(avg(cycle_days) filter (where status = 'completed'), 1) avg_cycle,
             round((percentile_cont(0.5) within group (order by cycle_days) filter (where status = 'completed'))::numeric, 1) median_cycle
        from public.report_requests where submitted_at >= now() - interval '365 days'`);
    return `${fmt(k.raised)} requests`;
  }));
  await time('Analytics: requests per week, two years', 5000, () => dbm.withContext(ctx, async (c) =>
    `${(await c.query(`select date_trunc('week', submitted_at) w, count(*) from public.report_requests group by 1 order by 1`)).rows.length} weeks`));
  await time('Main tracker: open requests, most overdue first (first 1,000)', 5000, () => dbm.withContext(ctx, async (c) =>
    `${(await c.query(`select * from public.tracker_rows('{"statuses": ["submitted", "in_progress", "on_hold"]}')`)).rows.length} rows`));
  await time('Search by reference across every request', 5000, () => dbm.withContext(ctx, async (c) =>
    `${(await c.query(`select id from public.form_submissions where upper(ref_number) = upper($1)`, [`PERF-${String(Math.floor(ROWS / 2)).padStart(8, '0')}`])).rows.length} found`));
  const meta = { title: 'Requests', filters: 'All time', generatedBy: 'perf', generatedAt: new Date() };
  for (const format of ['xlsx', 'csv', 'pdf']) {
    await time(`Export 5,000 rows as ${format.toUpperCase()}`, 5000, async () =>
      `${fmt(Math.round((await exporter.exportReport(biggest, meta, format)).length / 1024))} KB`);
  }
  await vite.close();

  // ------------------------------------------------------------- load
  log(`load: ${USERS} clients for ${SECONDS} s through the Open API`);
  const kPrefix = 'perftest', kSecret = randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 40).padEnd(40, 'x');
  await q(`insert into public.api_keys (tenant_id, name, prefix, secret_hash, scopes, created_by) values ($1, 'Load test', $2, $3, $4, 'EMP-0445')`,
    [tenant, kPrefix, createHash('sha256').update(kSecret).digest('hex'), ['requests:read', 'requests:write']]);
  const KEY = `ams_${kPrefix}_${kSecret}`;
  const app = (await import(pathToFileURL(path.resolve('dist/server/server.js')).href)).default;
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await app.fetch(new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/v1/`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
                                      body: body ? JSON.stringify(body) : undefined });
    await r.arrayBuffer();
    return r.status;
  };
  const mix = [
    ['list requests', 45, () => call('GET', 'requests?limit=20')],
    ['read a request', 20, () => call('GET', `requests/PERF-${String(1 + Math.floor(Math.random() * ROWS)).padStart(8, '0')}`)],
    ['approval queue', 20, () => call('GET', 'approvals?limit=20')],
    ['raise and submit a request', 15, () => call('POST', 'requests', {
      form: 'Leave Application', on_behalf_of: 'EMP-2847', submit: true,
      answers: { 'Leave type': 'Annual', From: '2026-12-14', To: '2026-12-15', Reason: 'Load test' } })],
  ];
  const lat = Object.fromEntries(mix.map(([n]) => [n, []]));
  let errors = 0, done = 0;
  const end = Date.now() + SECONDS * 1000;
  const weights = mix.flatMap(([n, w, f]) => Array(w).fill([n, f]));
  await Promise.all(Array.from({ length: USERS }, async () => {
    while (Date.now() < end) {
      const [n, f] = weights[Math.floor(Math.random() * weights.length)];
      const s = process.hrtime.bigint();
      let status = 0;
      try { status = await f(); } catch { status = 0; }
      lat[n].push(ms(s));
      done++;
      if (status < 200 || status >= 300) errors++;
    }
  }));
  srv.close();
  const allLat = Object.values(lat).flat();
  out.load = {
    users: USERS, seconds: SECONDS, requests: done, errors, rps: Math.round((done / SECONDS) * 10) / 10,
    p50: Math.round(pct(allLat, 50)), p95: Math.round(pct(allLat, 95)), p99: Math.round(pct(allLat, 99)),
    by: mix.map(([n]) => ({ name: n, count: lat[n].length, p50: Math.round(pct(lat[n], 50)), p95: Math.round(pct(lat[n], 95)) })),
  };
  log('load', out.load);
  await db.end();
} finally {
  await stop();
}

// ------------------------------------------------------------- the record
const L = out.load;
const perDay = L ? Math.round(L.rps * 86400) : 0;
const md = `# Performance and capacity

Measured by \`npm run test:perf\` on ${new Date().toISOString().slice(0, 10)}, on one development machine:
${out.machine}. PostgreSQL ${'17'} (embedded), the production build, all in one process tree — the
application, the database and the load generator share the same CPU, so these are lower bounds for a
dedicated server.

## Data

${fmt(out.counts.subs)} requests, ${fmt(out.counts.steps)} approval steps and ${fmt(out.counts.vals)} answers in one
organisation, spread over two years, loaded in ${out.load_seconds} s.

## Reports and searches

The median of three runs each. Listing reports return the first 5,000 rows on screen and in exports;
the filters, sorting and aggregates run over every row.

| What | Time | Target | Result |
|---|---:|---:|---|
${out.timings.map((t) => `| ${t.label} | ${fmt(t.ms)} ms | ${fmt(t.target / 1000)} s | ${t.detail} |`).join('\n')}

## Load

${L.users} concurrent clients for ${L.seconds} s through the Open API — listing requests, reading one,
approval queues, and raising requests (each builds its approval chain, notifies and queues email).

| | |
|---|---|
| Calls | ${fmt(L.requests)} (${L.errors} failed) |
| Throughput | ${L.rps} calls a second — ${fmt(perDay)} a day at that rate |
| Latency | median ${fmt(L.p50)} ms · 95th percentile ${fmt(L.p95)} ms · 99th ${fmt(L.p99)} ms |

| Call | Count | Median | 95th percentile |
|---|---:|---:|---:|
${L.by.map((b) => `| ${b.name} | ${fmt(b.count)} | ${fmt(b.p50)} ms | ${fmt(b.p95)} ms |`).join('\n')}

The target load is 5,000 requests a day for 2,000 users, growing 30% a year: about 18,600 a day in
year five. At the throughput above one instance handles ${fmt(Math.round(perDay / 18600))} times year five's daily volume;
even if a whole day's requests came in one hour, that is ${fmt(Math.round(18600 / 3600 * 10) / 10)} a second.
`;
writeFileSync('docs/PERFORMANCE.md', md);
log('written docs/PERFORMANCE.md');
process.exit(0);
