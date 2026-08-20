// =====================================================================
// The Vercel entry point.
//
// This version of TanStack Start has no deployment adapters: `vite build`
// emits dist/client and a dist/server/server.js that exports a plain
// web-standard { fetch } handler, and it is up to the host to call it.
// Vercel's TanStack Start preset expects a .vercel/output tree that this
// version never produces, which is why detection alone served a 404.
//
// So the wiring is explicit and small: one Node function that converts
// Vercel's (req, res) into a Request, hands it to the built server, and
// writes the Response back. vercel.json routes everything that is not a
// static asset here.
//
// Importing the server statically matters — that is how Vercel's
// dependency tracing finds it and the packages it needs (pg above all)
// and includes them in the function.
// =====================================================================

import server from '../dist/server/server.js';

/** Vercel gives a Node stream; Request wants bytes. */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export default async function handler(req, res) {
  try {
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    const proto = req.headers['x-forwarded-proto'] ?? 'https';
    const url = `${proto}://${host}${req.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      // Node collapses repeats into an array; Headers wants them appended.
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else headers.set(key, value);
    }

    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const body = hasBody ? await readBody(req) : undefined;

    const response = await server.fetch(
      new Request(url, { method, headers, body, duplex: hasBody ? 'half' : undefined }),
    );

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      // set-cookie is the one header that legitimately repeats.
      if (key.toLowerCase() === 'set-cookie') res.appendHeader?.(key, value) ?? res.setHeader(key, value);
      else res.setHeader(key, value);
    });

    if (!response.body) {
      res.end();
      return;
    }

    // Streamed rather than buffered: the server streams its HTML, and
    // waiting for the whole document before sending a byte would throw
    // that away.
    for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error('[vercel] request failed', err);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Internal error');
  }
}
