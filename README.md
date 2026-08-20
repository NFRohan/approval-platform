# Approval Platform

An internal approvals and administration system: staff raise requests, and
those requests walk up a chain of command until somebody with the authority
signs them off.

Five things go through that chain — form submissions, notices, stationery
requests, maintenance requests and movement orders — and there is one engine
behind all of them.

This is a working demo, not a product. It exists to be walked through.

---

## What it does

**Forms.** A drag-and-drop builder produces templates: fields, validation,
calculated values, and the approval rules that go with them. Published
templates are what people fill in.

**Approvals that respect order.** A request is created with every step it will
need, but only the lowest unfinished one is live. An approver sees a request
when it is their turn and not before — a CFO cannot sign off before the line
manager has looked.

**Escalation by amount.** Money forms route by threshold, cumulatively. A claim
of 620,000 is not "a CFO claim": it climbs the Finance Controller, then the
Head of Finance, then the CFO, each in turn.

**Chains that survive contact with reality.** A rejection stops the chain and
records who was never asked. A clarification request pauses it and resumes in
place. An approver can forward their step to somebody else — the trail keeps
who it was originally asked of — or insert a reviewer to be asked after them.

**The rest of the admin surface.** Notices with comments, stationery and
business cards, maintenance requests across three approval tiers, movement
orders with stock reservation and transfer between venues, delegation of
approval authority for a date range, and an activity trail that cannot be
rewritten.

---

## How it is built

| | |
|---|---|
| Framework | TanStack Start, React 19, TypeScript |
| UI | shadcn/ui, Tailwind 4 |
| Database | Postgres (Neon) |
| Hosting | Vercel |

Three decisions shape the codebase.

**Nothing reaches the database from a browser.** Every query goes through one
server function and a whitelist that decides which tables and columns exist and
which of them may be written. The driver, the SQL builder and the connection
string appear only in the server bundle.

**Every table carries a tenant, and every child references its parent on
`(id, tenant_id)`.** A record cannot point across a tenant boundary even if a
query forgets to filter. Each evaluation is a full clone of a template tenant,
so several people can be shown the system at once without seeing each other.

**Row-level security is switched on and actually restricts.** Requests run as
an unprivileged role with the caller's identity set transaction-locally, so a
connection with no context reads nothing rather than everything.

---

## Running it

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and JWT_SECRET

npm run db:apply              # 6 files, re-runnable
node --env-file=.env scripts/dev-tenant.mjs
                              # mint an evaluation; put its slug in DEMO_TENANT_SLUG

npm run dev
```

The template tenant deliberately has no account — accounts belong to
evaluations, which are clones of it — so local development needs a real
evaluation. That is also how production works.

Walking the demo changes it. To start over:

```bash
node --env-file=.env scripts/dev-tenant.mjs --fresh
```

### Tests

```bash
npm test          # all four, cheapest first
```

| | |
|---|---|
| `typecheck` | TypeScript, no emit |
| `test:callsites` | Every query chain and function call in the source, pushed through the real query builder. Static — no database, no browser. |
| `test:render` | All 19 routes rendered once, against real ids |
| `db:test` | 69 checks: tenant isolation, the security policies, provisioning, and the approval chain |

`db:test` refuses a pooled connection string. The suites carry fixture ids in
session settings, and a transaction pooler hands one server connection to
several clients.

---

## What is not built

Stated plainly, because a demo that hides its edges wastes everyone's time.

- **No sign-in.** Identity is a persona switcher. Anyone who can reach the
  application can act as anyone in it.
- **Notifications are not delivered.** The rules exist and the chain knows who
  to tell; nothing sends mail or SMS.
- **SLA deadlines are shown, not enforced.** They are stored and coloured when
  overdue, and no process acts on them.
- **Five of the ten specified admin modules are absent on purpose** — dispatch,
  event coordination, visitor management, air ticketing and standalone stock
  are each their own project.

Sequencing for the rest is in [docs/SPRINT_PLAN.md](docs/SPRINT_PLAN.md).
