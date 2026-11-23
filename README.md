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

**Who somebody is, and what they may do.** A session names an employee, and
every function that acts takes the actor from it — not from what the browser
says. What people may do comes from roles they hold: designing workflows,
changing only a workflow's task settings, managing or approving accounts,
managing or approving roles, keeping the org chart, reading audit trails.
Accounts and roles are registered or changed by one person and approved by
another, never by their subject; a profile change waits the same way. The
password policy is 12 characters with upper, lower, a number and a special
character, 90-day expiry, no reuse of the last five, and a lock after ten
wrong attempts. Two-step sign-in uses any authenticator app, and an
organisation can require it of whoever administers. Five minutes without
activity signs out. People come from an HR master file or from LDAP / Active
Directory, nightly and on demand, with a history of every sync; directory
accounts sign in with their directory password. A form can be offered to
some departments only.

An evaluation's own login still acts as any of its people, so one
credential can show the difference between them — but switching is a
request to the server, checked and written to the activity log, and the
persona carries that person's permissions and nothing more.

**Reports, analytics and email.** An analytics dashboard shows volume,
completions, cycle time, the share of approvals decided on time and what is
overdue now, against the previous period, with weekly trends, the busiest
forms and departments, who is slowest to respond and where work is waiting —
filterable by period, department and form, every chart readable as a table.
Reports are templates of columns and filters over requests, approval steps
and approvers' performance: seven standard ones answer the tracking questions
(open approvals, missed deadlines, upcoming, rejected, approver KPIs), and
administrators build more. Each exports to Excel, PDF or CSV, can be emailed
now or on a weekly or monthly schedule, and anybody who reads reports can ask
for a column change that an administrator approves. Every notification is
also an email, in the organisation's own wording per kind, and every email is
kept with what became of it; a completed request's email carries its
approval record as a PDF. A daily round reminds approvers before a deadline,
every day after it, and escalates to their manager two working days past it.

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

npm run db:apply              # 8 files, re-runnable, dependency-ordered
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

In an evaluation, the cast hold these roles: Farah Haddad is the System
administrator, Priya Raman approves accounts (HR administrator), Nadia Okonjo
designs workflows, Raj Patel may change only task settings, Alex Mercer
approves roles (Security officer) and Lena Ortiz reads the audit trails.
Everybody else raises and approves requests.

### A directory

To sign people in with LDAP or Active Directory and sync them from it, set
`LDAP_URL`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_BASE_DN` and
`LDAP_TENANT` (the organisation's slug); the attribute names and filters have
defaults for OpenLDAP and are listed in `src/server/ldap.ts` with the Active
Directory equivalents. The nightly sync is `/cron/directory-sync`, called by
Vercel Cron with `CRON_SECRET`. `MFA_KEY` seals two-step secrets at rest and
falls back to `JWT_SECRET`.

### Email

Set `SMTP_URL` (`smtp://user:pass@host:587`, or `smtps://` for 465) and
`MAIL_FROM` to deliver email; `APP_URL` is where links in emails point. With
no `SMTP_URL`, every email is still written in full and kept in the email log
as *captured*, so it can be read exactly as it would have been sent. The
daily round — reminders, escalation, scheduled reports, delivery — is
`/cron/daily`, called by Vercel Cron at 08:00 Dhaka.

Walking the demo changes it. To start over:

```bash
node --env-file=.env scripts/dev-tenant.mjs --fresh
```

### Tests

```bash
npm test          # all eight, cheapest first
```

| | |
|---|---|
| `typecheck` | TypeScript, no emit |
| `test:callsites` | Every query chain and function call in the source, pushed through the real query builder. Static — no database, no browser. |
| `test:identity` | 35 checks with no database: two-step codes against the RFC 6238 vectors, sealing their secrets, the password policy and a generator that always meets it, the idle timeout and the 12-hour limit, reading the HR file |
| `test:reports` | 35 checks with no database: the report query builder builds only from its catalogue and binds every value, the CSV cannot carry a formula, the Excel file is a real workbook, the PDFs open, and emails fill and escape their templates |
| `test:auth` | 24 checks: passwords, sessions, and whether withdrawing an evaluation takes effect on the next request |
| `test:render` | All 30 routes rendered once, against real ids, and every persona checked against the employee table |
| `db:test` | 162 checks: tenant isolation, the security policies, provisioning, the approval chain, the workflow shapes — parallel tracks, quorum, conditions, roles, return, recall, questions, follow-ups — the ticket: references, priority, signatures, notes, CC, links, copies, hand-over — and identity: the session decides who acts, permissions from roles, maker-checker on accounts and roles, the HR import, two-step for administrators, form audiences — and reports: months of history, the report views and who may read them, column changes approved by somebody else, every notification queued as an email, scheduled reports, reminders and escalation |
| `db:test:local` | The same suites against PGlite — real Postgres in WebAssembly, in-process, a fresh database per suite. No server, no credentials, and nothing touches the deployed database. Use this while changing SQL; it is not part of `npm test` |
| `test:ldap` | 13 checks against a real OpenLDAP in Docker: signing in with a directory password (and not with an empty one, a wildcard or an injected filter), failing closed, and reading people with their managers resolved. Needs Docker; not part of `npm test` |
| `test:journey` | One request walked from submitted to fully approved, as the people the switcher offers. The other five each test one layer; this one goes through them, which is where the worst faults turned out to live |

`db:test` and `test:journey` refuse a pooled connection string. The suites carry fixture ids in
session settings, and a transaction pooler hands one server connection to
several clients.

---

## What is not built

Stated plainly, because a demo that hides its edges wastes everyone's time.

- **Email, not SMS.** Notifications go to the bell and by email; there is no
  SMS or push channel. The demo deployment has no mail server, so its emails
  are captured in the log rather than delivered.
- **The daily round is daily.** Vercel's free tier runs a cron job once a
  day, so reminders and escalation are a day apart at best; the SOW's 12-hour
  reminder for Commercial reviews needs a scheduler that runs more often.
- **An evaluation's login can be anybody in it.** That is what lets one
  credential demonstrate every role. It is switched off per organisation
  (`persona_switching`), and a person's own account never switches.
- **The directory is one per deployment.** LDAP settings come from the
  environment, for the one organisation named by `LDAP_TENANT`.
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
