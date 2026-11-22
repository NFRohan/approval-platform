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

**Parallel, by role, and on conditions.** A chain is phases run in order; a
phase can run several tracks at once, each its own sequence, and clears when
all of them do or when any N do. An exit clearance runs the leaver's division
(line manager → head of department → HR business partner → CXO) beside
Finance, Supply Chain, Administration and Technology, and HR settles only after
all five; a gift declaration needs any two of three compliance officers.
Approvers can be roles resolved from the org chart for each requester, and a
step can apply only when an answer says so — the CXO first on the exceptional
route. Nobody approves their own request, and the same person twice in a row
is one step. The review screen shows the requester the plan the chain will be
built from, by the same code.

**Chains that survive contact with reality.** A rejection stops the chain and
records who was never asked. A clarification request pauses it and resumes in
place. An approver can forward their step to somebody else — the trail keeps
who it was originally asked of — ask a reviewer to look before they decide,
return the request to anyone who already approved it, or ask another approver
on it a question. The requester can take a request back to edit, or cancel
it, until anybody has approved. An approved request can start its follow-up as
a preloaded draft. Everything that happens is kept in an append-only trail.

**A ticket, not just a route.** Every request has a reference that can be
read out (`AMS-2026-00042`), a priority that shortens every deadline on it,
people copied on it who hear when it is raised and decided, a notes thread
that tells everyone on it, links to other requests, and a copy action that
starts a new draft from it. Documents carry descriptions, tags and every
version, and opening one is logged. A step can require a drawn signature,
an exceptional route is flagged wherever the request appears, one
department clearing tells the others, and a leaver's work is handed to a
successor in one step. The route can be read as a timeline or as a process
map, and every date is written dd/MM/yyyy.

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

Four decisions shape the codebase.

**Nothing reaches the database from a browser.** Every query goes through one
server function and a whitelist that decides which tables and columns exist and
which of them may be written. The driver, the SQL builder and the connection
string appear only in the server bundle.

**Every table carries a tenant, and every child references its parent on
`(id, tenant_id)`.** A record cannot point across a tenant boundary even if a
query forgets to filter. Each evaluation is a full clone of a template tenant,
so several people can be shown the system at once without seeing each other.

**A signed session names the tenant, and nothing else does.** Before sign-in
existed that came from configuration; either way the browser has never been
allowed to choose, because that value is what every security policy reads. No
session is a 401 rather than a fallback.

**Row-level security is switched on and actually restricts.** Requests run as
an unprivileged role with the caller's identity set transaction-locally, so a
connection with no context reads nothing rather than everything.

---

## Running it

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, DIRECT_URL and JWT_SECRET

npm run db:apply              # 6 files, re-runnable, dependency-ordered
node --env-file=.env scripts/dev-tenant.mjs      # issue an evaluation
node --env-file=.env scripts/staff-account.mjs   # and the account that issues them

npm run dev
```

Both scripts print a password once. They are stored hashed and cannot be
recovered — reset one instead.

The template tenant deliberately has no account. Accounts belong to
evaluations, which are clones of it, and every policy requires a signed-in
member — so there is nothing to sign in to until an evaluation exists. That is
also how production works.

Walking the demo changes it. To start over:

```bash
node --env-file=.env scripts/dev-tenant.mjs --fresh
```

### Tests

```bash
npm test          # all six, cheapest first
```

| | |
|---|---|
| `typecheck` | TypeScript, no emit |
| `test:callsites` | Every query chain and function call in the source, pushed through the real query builder. Static — no database, no browser. |
| `test:auth` | 24 checks: passwords, sessions, and whether withdrawing an evaluation takes effect on the next request |
| `test:render` | All 21 routes rendered once, against real ids, and every persona checked against the employee table |
| `db:test` | 127 checks: tenant isolation, the security policies, provisioning, the approval chain, the workflow shapes — parallel tracks, quorum, conditions, roles, return, recall, questions, follow-ups — and the ticket: references, priority, signatures, notes, CC, links, copies, hand-over |
| `db:test:local` | The same suites against PGlite — real Postgres in WebAssembly, in-process, a fresh database per suite. No server, no credentials, and nothing touches the deployed database. Use this while changing SQL; it is not part of `npm test` |
| `test:journey` | One request walked from submitted to fully approved, as the people the switcher offers. The other five each test one layer; this one goes through them, which is where the worst faults turned out to live |

`db:test` and `test:journey` refuse a pooled connection string. The suites carry fixture ids in
session settings, and a transaction pooler hands one server connection to
several clients.

---

## What is not built

Stated plainly, because a demo that hides its edges wastes everyone's time.

- **Notifications are in-app only.** The chain writes them and the bell reads
  them; nothing sends mail or SMS, and the interface says so rather than
  implying a channel that does not exist.
- **Overdue reminders need a page load.** `remind_overdue()` writes one
  reminder per person per day, and the approvals screen asks for it — there is
  no scheduler behind a demo. In a real deployment it would be a timer.
- **Persona switching is not authentication.** Signing in identifies the
  evaluation; switching persona inside it is a demo feature, and deliberately
  unrestricted. One credential per prospect, not one per approval level.
- **Five of the ten specified admin modules are absent on purpose** — dispatch,
  event coordination, visitor management, air ticketing and standalone stock
  are each their own project.

Twenty-one findings from the August 2026 review are open on purpose —
none reachable by using the demo, all of them written down in
[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) with the five that stop
being theoretical the moment there is real data.

Sequencing is in [docs/SPRINT_PLAN.md](docs/SPRINT_PLAN.md), and deployment —
including the two non-obvious things about it — is in
[docs/DEPLOY.md](docs/DEPLOY.md).
