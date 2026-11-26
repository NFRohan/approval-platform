// =====================================================================
// The app on a server of our own: a VM, or a container under Kubernetes.
//
//   npm run build && node scripts/vm-server.mjs        (PORT, default 3000)
//
// On Vercel, three things happen for us: static files are served from
// dist/client, everything else goes to the handler in api/index.mjs, and
// vercel.json adds the security headers. Here this one process does all
// three, so it can stand alone (a container) or sit behind nginx (a VM,
// which may serve dist/client itself and proxy the rest here).
//
// /api/health answers the readiness and liveness probes.
// =====================================================================

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// LOG_FORMAT=json: every log line is one JSON object, for ELK (SOW §6).
if (process.env.LOG_FORMAT === 'json') {
  for (const level of ['log', 'info', 'warn', 'error']) {
    const write = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    console[level] = (...args) => write.write(JSON.stringify({
      ts: new Date().toISOString(), level: level === 'log' ? 'info' : level, service: 'ams',
      msg: args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    }) + '\n');
  }
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLIENT = join(ROOT, 'dist', 'client');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = (await import(new URL('../api/index.mjs', import.meta.url).href)).default;
const health = (await import(new URL('../api/health.mjs', import.meta.url).href)).default;

// The production headers, from the one place they are written down.
const HEADERS = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8')).headers?.[0]?.headers ?? [];

const TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.map': 'application/json',
};

/** A file under dist/client, if the path names one. Never outside it. */
async function staticFile(urlPath) {
  if (urlPath === '/' || !extname(urlPath)) return null;
  const path = normalize(join(CLIENT, decodeURIComponent(urlPath)));
  if (!path.startsWith(CLIENT)) return null;
  try {
    const s = await stat(path);
    return s.isFile() ? { path, size: s.size } : null;
  } catch {
    return null;
  }
}

// Prometheus metrics at /metrics (SOW §6 monitoring): requests by kind
// and status class, their durations, and the process. METRICS_TOKEN, if
// set, is required as a bearer token.
const started = Date.now();
const counts = new Map();      // `${kind}|${class}` -> n
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const hist = { buckets: BUCKETS.map(() => 0), sum: 0, n: 0 };
function observe(kind, status, seconds) {
  const key = `${kind}|${Math.floor(status / 100)}xx`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (kind === 'app') {
    hist.sum += seconds; hist.n += 1;
    BUCKETS.forEach((b, i) => { if (seconds <= b) hist.buckets[i] += 1; });
  }
}
function metrics() {
  const m = process.memoryUsage();
  const lines = [
    '# HELP ams_http_requests_total Requests answered, by kind (app, static, health) and status class.',
    '# TYPE ams_http_requests_total counter',
    ...[...counts].map(([k, n]) => { const [kind, cls] = k.split('|'); return `ams_http_requests_total{kind="${kind}",status="${cls}"} ${n}`; }),
    '# HELP ams_http_request_duration_seconds Time to answer an app request.',
    '# TYPE ams_http_request_duration_seconds histogram',
    ...BUCKETS.map((b, i) => `ams_http_request_duration_seconds_bucket{le="${b}"} ${hist.buckets[i]}`),
    `ams_http_request_duration_seconds_bucket{le="+Inf"} ${hist.n}`,
    `ams_http_request_duration_seconds_sum ${hist.sum.toFixed(3)}`,
    `ams_http_request_duration_seconds_count ${hist.n}`,
    '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${m.rss}`,
    '# TYPE nodejs_heap_used_bytes gauge', `nodejs_heap_used_bytes ${m.heapUsed}`,
    '# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`,
  ];
  return lines.join('\n') + '\n';
}

const server = http.createServer(async (req, res) => {
  for (const h of HEADERS) res.setHeader(h.key, h.value);
  const urlPath = (req.url ?? '/').split('?')[0];
  const t0 = process.hrtime.bigint();
  let kind = 'app';
  res.on('finish', () => observe(kind, res.statusCode, Number(process.hrtime.bigint() - t0) / 1e9));
  try {
    if (urlPath === '/metrics') {
      kind = 'metrics';
      const token = process.env.METRICS_TOKEN;
      if (token && req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; return res.end('not authorised'); }
      res.setHeader('content-type', 'text/plain; version=0.0.4');
      return res.end(metrics());
    }
    if (urlPath === '/api/health') { kind = 'health'; return await health(req, res); }
    const file = await staticFile(urlPath);
    if (file) {
      kind = 'static';
      res.statusCode = 200;
      res.setHeader('content-type', TYPES[extname(file.path)] ?? 'application/octet-stream');
      res.setHeader('content-length', String(file.size));
      // Hashed build assets never change; everything else is checked.
      res.setHeader('cache-control', urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file.path).pipe(res);
    }
    return await app(req, res);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Internal error');
  }
});

server.listen(PORT, HOST, () => console.log(`AMS listening on http://${HOST}:${PORT}`));

// A container is stopped with SIGTERM: finish what is in flight, then go.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
