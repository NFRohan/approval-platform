# Deploying

What this actually needs, and the two things about it that are not obvious.

---

## What runs where

| | |
|---|---|
| Static assets | `dist/client`, served by Vercel's CDN |
| The application | One Node function, `api/index.mjs` |
| Health check | A second function, `api/health.mjs` |
| Database | Neon Postgres, `ap-southeast-1` |
| Function region | `sin1`, pinned in `vercel.json` |

### The adapter, and why it is written out

This version of TanStack Start ships **no deployment adapters**.
`vite build` emits `dist/client` plus a `dist/server/server.js` that exports a
plain web-standard `{ fetch }` handler, and it is the host's job to call it.
Vercel's own TanStack Start preset expects a `.vercel/output` tree that this
version never produces — so relying on framework detection served a 404 on
every route while reporting a successful build.

`vercel.json` therefore sets `"framework": null` and wires it explicitly:
static from `dist/client`, everything else rewritten to `api/index.mjs`, which
converts Vercel's `(req, res)` into a `Request`, hands it to the built server,
and **streams** the `Response` back. Buffering would throw away the streamed
HTML the server goes to the trouble of producing.

### Region

The database is in `ap-southeast-1`. A function in Vercel's default region
adds a cross-region round trip to every query, and a single screen makes
several. `"regions": ["sin1"]` is not a micro-optimisation here.

---

## Environment

Set these on the Vercel project, all environments:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The Neon **pooled** string — the host with `-pooler` in it |
| `JWT_SECRET` | 32+ random characters. The server refuses to issue a session without it |

**`DIRECT_URL` is deliberately not set in production.** It is the unpooled
endpoint, used only by migrations and the test suites. A serverless function
opens a connection per invocation, which is exactly what a pooler is for.

There is no `DEMO_TENANT_SLUG` any more. Before sign-in existed, the server
acted as one tenant named in configuration; now the signed session names it.

Rotating `JWT_SECRET` invalidates every session immediately, which is the
fastest way to sign everybody out.

---

## First deployment

```bash
npm i -g vercel && vercel login
vercel link --project approval-platform

# schema, policies, provisioning, stock, the chain engine, then the seed
npm run db:apply

# the account that issues evaluations
node --env-file=.env scripts/staff-account.mjs

vercel --prod
```

Then confirm it is actually wired up rather than merely built:

```bash
curl -s https://<your-deployment>/api/health
```

```json
{ "ok": true, "database": true, "tenant": true, "account": true, "region": "sin1" }
```

**A 200 on the pages proves nothing on its own.** Every screen fetches its data
after the page loads, so a deployment that builds, serves HTML and cannot reach
Neon looks completely healthy to `curl`. The health check asks the three
questions that separate those cases — does the database answer, is there a live
evaluation, and does it have an account somebody could sign in as. It reports
booleans only: no connection string, and no driver error text, because those
name hosts and roles.

---

## Issuing an evaluation

Sign in as the staff account and open `/staff`, or from a terminal:

```bash
node --env-file=.env scripts/dev-tenant.mjs --name "Northwind Group" --user northwind.eval --days 30
```

Either way the password is **generated, shown once, and stored hashed**. There
is no way to recover it — reset it instead, which is one button in the console.

Each evaluation is a full clone of the template tenant, so every screen has
data from the first sign-in. They expire on their own. **Extend rather than
reissue**: extending keeps everything the prospect has already entered, and
issuing a new one starts them from the template again.

---

## Migrations

```bash
npm run db:apply     # re-runnable, over DIRECT_URL
npm run db:test      # 75 checks; refuses a pooled endpoint
```

The files are numbered in dependency order and the seed is **last**, because it
calls the chain engine to build its own approval chains. It cannot run before
those functions exist — which it did for a while, working only because the
functions happened to survive from a previous apply.

`db:test` refuses a pooled connection string on purpose. The suites carry
fixture ids in session-level settings, and a transaction pooler hands one
server connection to several clients: a setting left by one suite arrived in
the next one's and silently disabled the policies consulting it.

---

## Before a walkthrough

```bash
node --env-file=.env scripts/dev-tenant.mjs --fresh
```

Walking a demo changes it — approvals get approved, requests get raised. This
discards the evaluation and clones a new one, so the next walkthrough starts
where the last one did. It prints a new password.
