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

**Commercial campaigns.** A campaign request goes to the Business Finance
reviewer the requester picks — anybody on leave is shown but cannot be
chosen — and the whole Business Finance team is copied. The NFA that follows
is in the prescribed format, a KPI section and a reporting section, and can
be filled from the vetted Word document: its labels are matched to the
form's questions however the document words them, amounts in lakh and crore
and dates in any common format are read, and an NFA with several business
cases becomes a linked draft for each. Once approved, an NFA is a tracked
campaign — status, KPI targets against actuals, budget used, run rate and
where that pace ends up — and its requester is told at 95% of budget and
again past 100%. Coupon campaigns keep each coupon's redemption and which
service took it. A live campaign is extended through the same approvals,
keeping its modality. A partner's email becomes a ticket for the telecom
team, and a reply quoting a ticket's reference — a UAT result — is added to
it. Finance requests print a payment top sheet with their PO lines wrapped in
full and the amount in words.

**The working calendar.** Deadlines count working days: not Friday or
Saturday, and not a holiday. Each organisation starts with the government's
gazetted holidays for 2026 and 2027 — the Eid and Puja breaks included, the
days that depend on the moon marked provisional — and adds office closures,
moves a holiday when the moon is sighted, or loads a year's list in one step.
A three-day approval asked for before Eid is due after it, on screen and in
the database alike.

**The org chart moves.** Divisions are renamed and merged in one step that
carries their people, the forms offered to them and the reports about them;
a division the HR file names for the first time is created. Forms are
classified (budgetary, non-budgetary and so on) and found by keyword.

**Other systems, the audit trail and the archive.** An open REST API lets the
ERP raise requests for an employee, follow them, add notes, cancel them and
approve or reject as the approver, and lets Tableau or Power BI pull any saved
report as JSON or CSV. Access is by API key, issued on the Integrations
screen, shown once and stored only as a hash; each key carries scopes, every
call is logged, and a revoked key stops at its next call. Webhooks post what
happens to a request to the other system within seconds, signed with
HMAC-SHA256, retried after one and five minutes, every delivery kept and
redeliverable; a built-in receiver at `/webhooks/echo` checks signatures for
trying it out. `/developers` documents every endpoint, generated from the
same catalogue as `/api/v1/openapi.json` (OpenAPI 3.1). The audit centre is
one trail over user, application, system and database activity — sign-ins
and failed ones, decisions, documents opened, email, mail received, API
calls, webhooks, errors, scheduled runs, schema changes, imports — filtered by
category, severity, period and search, exported to Excel or CSV, and watched:
activity by day, failed sign-ins, refused keys, work out of hours and by
whom. Retention follows the SOW: settled requests are archived after a year —
out of working lists, still searchable — logs are purged after ten years,
records kept for twelve and listed for disposal past that, by the daily round
or on demand. Closed tickets from ManageEngine ServiceDesk Plus come in from
its CSV export as archived records under their old references, matched to
the org chart. And ServiceDesk Plus is linked live: a ticket whose template
or category needs approval — an access request, a purchase — becomes a
request on the mapped form, raised as its requester and answered from the
ticket, whether ServiceDesk's webhook sends it or this side fetches it; each
decision is written back to the ticket as a note, and at the end the ticket
is resolved and closed, or closed as rejected with the reason.

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

npm run db:apply              # 9 files, re-runnable, dependency-ordered
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
as *captured*, so it can be read exactly as it would have been sent. For a
demonstration, `MAIL_REDIRECT_TO` delivers every email to one real inbox
instead — the demo's people have example.com addresses — each marked with
who it was for. The
daily round — reminders, escalation, scheduled reports, delivery — is
`/cron/daily`, called by Vercel Cron at 08:00 Dhaka.

### Mail into the system

Point a mail provider's inbound webhook (Postmark, or anything posting
`{from, subject, text, attachments}`) at `/inbound/email/<organisation slug>`
with `INBOUND_SECRET` in an `x-inbound-secret` header. Which domains count as
partners, and whose ticket their mail becomes, is set on the Email screen,
which can also send a message in by hand.

Walking the demo changes it. To start over:

```bash
node --env-file=.env scripts/dev-tenant.mjs --fresh
```

### The API and webhooks

Keys are made under Administration → Integrations (`integrations.manage`);
documentation is at `/developers`, the spec at `/api/v1/openapi.json`.
Webhook deliveries go out after every write and in the daily round; a
webhook's address may be a path on this server (`/webhooks/echo`), resolved
against `APP_URL`.

### ServiceDesk Plus

Administration → Integrations → ServiceDesk Plus: the server's address, a
technician's API key (sealed at rest), and which templates or categories
become which forms. Tickets arrive by ServiceDesk's webhook (Developer Space
→ Webhooks, run by a custom trigger on new requests, posting `{"id": …}` to
`/integrations/servicedesk/<organisation>` with the link's secret in
`X-AMS-Secret`), or are fetched — on demand and in the daily round — for an
edition without webhooks. Write-backs go out after every decision.

ServiceDesk Plus Cloud is set up on the same screen: the data centre and
the portal's name make the address (`https://sdpondemand.manageengine.in/app/<portal>`),
and it signs in through Zoho — a Self Client in Zoho's API console
generates a code with the scope `SDPOnDemand.requests.ALL`, pasted once and
swapped for a refresh token kept sealed; access tokens are renewed as they
lapse. The client secret is only ever sent to Zoho's own accounts servers.

An on-premises ServiceDesk is usually on a private network, which outbound calls refuse;
run with `OUTBOUND_ALLOW_PRIVATE=1` where the server can reach it directly,
or give it a public address (a tunnel). A self-signed certificate can be
allowed per link. Without a server, `node scripts/servicedesk-mock.mjs`
answers the same API on port 8085.

### Tests

```bash
npm test          # all ten, cheapest first
```

| | |
|---|---|
| `typecheck` | TypeScript, no emit |
| `test:callsites` | Every query chain and function call in the source, pushed through the real query builder. Static — no database, no browser. |
| `test:identity` | 35 checks with no database: two-step codes against the RFC 6238 vectors, sealing their secrets, the password policy and a generator that always meets it, the idle timeout and the 12-hour limit, reading the HR file |
| `test:reports` | 35 checks with no database: the report query builder builds only from its catalogue and binds every value, the CSV cannot carry a formula, the Excel file is a real workbook, the PDFs open, and emails fill and escape their templates |
| `test:commercial` | 29 checks with no database: reading Word NFAs — business cases, labels as people write them, lakh and crore, dates in words — the top sheet's amounts in words and wrapped PO lines, and both shapes of inbound mail |
| `test:integration` | 67 checks with no database: webhook signatures as a receiver checks them — tampered, replayed and unsigned deliveries refused — the API's answers before a key is looked up, the OpenAPI document and its agreement with the database's scopes and events, and ManageEngine exports read whichever way they spell their columns and dates, deadlines counted over the Eid break as the browser previews them, and ServiceDesk Plus tickets read in every shape it sends them, and its API called — key, input_data, notes, close, and the cloud's Zoho sign-in — against the stand-in |
| `test:auth` | 24 checks: passwords, sessions, and whether withdrawing an evaluation takes effect on the next request |
| `test:render` | All 36 routes rendered once, against real ids, and every persona checked against the employee table |
| `db:test` | 189 checks: tenant isolation, the security policies, provisioning, the approval chain, the workflow shapes — parallel tracks, quorum, conditions, roles, return, recall, questions, follow-ups — the ticket: references, priority, signatures, notes, CC, links, copies, hand-over — and identity: the session decides who acts, permissions from roles, maker-checker on accounts and roles, the HR import, two-step for administrators, form audiences — and reports: months of history, the report views and who may read them, column changes approved by somebody else, every notification queued as an email, scheduled reports, reminders and escalation — and commercial: the reviewer the requester chooses, the team copied, campaigns from approved NFAs, budget alerts, extensions, coupons, merging divisions, partner mail to tickets, and older evaluations brought up to the template — and integration: keys of an evaluation's own, who may make and revoke them and a revoked key refused at once, webhooks queued for exactly what they listen for, one audit trail over every source and who may read it, retention archiving and purging by the policy without deleting a record, and migrated tickets imported once — and the working calendar: deadlines stepping over holidays, and who may keep it — and ServiceDesk Plus: mapped tickets raised once as their requester, others left alone or refused with the desk told why, every decision queued back in order, and who may change the link |
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
- **The API has no rate limit.** Keys are scoped, logged and revoked at
  once, but nothing caps how often one may call; a deployment would put a
  quota in front of `/api/v1`.
- **Records past retention are listed, not destroyed.** Retention archives
  and purges logs on its own; disposing of a twelve-year-old financial
  record is left to a person.
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
