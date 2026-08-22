# Approval platform — codebase audit and sprint plan

Drafted 20 August 2026. Covers moving the demo onto live infrastructure and
closing all 17 polish items agreed on.

---

## 1. Where the codebase actually stands

Read rather than assumed — every figure below was measured against the source.

### Shape

| | |
|---|---|
| Framework | TanStack Start, React 19, TypeScript |
| UI | shadcn/ui — 46 components, Tailwind 4 |
| Screens | 20 routes, ~9,150 lines across routes and builder |
| Database | 21 tables, 18 migrations, 1,212 lines of SQL |
| Data access | 156 queries, **all client-side** |
| Deploy target | Cloudflare Workers → moving to Vercel |
| Tests | none |

### The four structural facts that shape this plan

**Every query runs in the browser.** No server functions, no route loaders, no
query caching — despite `@tanstack/react-query` being installed and unused. The
database credential ships in the JavaScript bundle, which is how the design
intends it: safety was meant to come from row-level security.

**Row-level security permits everything.** All 21 tables have it enabled, and
every policy is `USING (true)` — generated in a loop, for read, insert, update
and delete alike. 43 permissive clauses, zero conditional. So the one mechanism
the architecture depends on is switched off in practice.

**There is no authentication.** Identity is seven people hardcoded in
`CurrentUserContext.tsx`, selected from a dropdown or by `?as=` in the URL.
Nothing to port — it has to be introduced.

**Coupling to Supabase is shallower than it looks.** The 1,058 lines of
generated types in `src/integrations/supabase/types.ts` are imported by the
client wrapper alone; no route is typed against the database. 24 files import
the client. That means a shim can replace the backend with the 156 call sites
left as they are.

### Query distribution — the cutover's blast radius

| File | Queries |
|---|---:|
| `routes/movement-orders.tsx` | 34 |
| `routes/approvals.tsx` | 15 |
| `routes/forms.$formId.tsx` | 11 |
| `routes/builder.index.tsx` | 11 |
| `routes/maintenance.tsx` | 10 |
| `routes/stationery.tsx` | 9 |
| `routes/notices.$noticeId.tsx` | 9 |
| `routes/builder.approvers.tsx` | 9 |
| 14 further files | 39 |

`movement-orders.tsx` is 1,258 lines and holds a fifth of all queries. It is the
highest-risk file in the cutover and should be verified first, not last.

### What the demo contradicts about itself

These are not requirement gaps — the requirements audit could not see them,
because it compared the demo against the specification rather than against
itself. They matter more, because they are what a prospect notices in a live
walkthrough.

- **Three different slab tables.** `ConfigPanel.tsx` and `PeopleStep.tsx` each
  hardcode a *different* table, and both differ from the database. Both promise
  a "Board Approval" tier above 2,000,000 that does not exist in the data. Enter
  3,000,000 and the interface says Board Approval while the routing sends it to
  the CFO.
- **Two approval systems.** Notices and Stationery walk a hardcoded frontend
  array (`const CHAIN = [...]`) rather than creating `approval_requests`, so
  their approvals never appear in the queue, the history or the timeline.
- **Approvals have no order.** Every approver's request is created at once, all
  pending, and the queue never checks whose turn it is. The CFO can approve
  before the line manager has looked.
- **Slabs select one approver** rather than escalating — a 600,000 request never
  touches the Finance Controller.

### Dead or misleading surfaces

| Thing | State |
|---|---|
| Global search box | An input with no `value`, no `onChange`, no handler |
| Notification bell | "3 new notifications" is a literal string over three invented items |
| Breadcrumb | Hardcoded "Home / Dashboard" on every screen |
| Dashboard panels | Three panels of invented names and dates; the stat cards above them are live |
| Required fields | Validated in `handleNext()` only — the final step is never checked, so a single-step form is never validated at all |
| SLA deadlines | Stored, displayed, coloured when overdue — and acted on by nothing |
| Pagination | 154 of 156 queries are unbounded |

---

## 2. Sequencing logic

Three constraints decide the order.

**The migration comes first.** Ten of the seventeen items touch data access.
Fixing them against Supabase means doing them twice.

**The chain comes before what depends on it.** Sequential approval (#11) has to
exist before notifications are worth sending (#12 — "it's your turn" is the
notification that matters), before forward/reassign has anything to forward
(#13), before Notices and Stationery can move onto the engine (#2), and before
Maintenance can have three tiers (#17).

**Truth before polish.** Items where the interface states something false — the
slab tables, the dashboard, the notification count — outrank items that are
merely unfinished. A prospect forgives a missing feature and remembers a wrong
number.

Two items are independent of everything and can be picked up whenever a sprint
runs short: the breadcrumb (#6) and the search box (#5).

---

## 3. The sprints

Each ends with something demonstrable. Items in **bold** are from the agreed
list of 17.

### Sprint 1 — Data foundation

*Goal: a schema that can hold more than one prospect, on plain Postgres.*

- [x] `db/001_schema.sql` — 25 tables, tenant column on every one, 33 composite
      foreign keys, approval chain redesigned with `step_index` and `waiting`
- [x] `db/002_rls.sql` — all 43 `USING (true)` policies replaced, plus the
      unprivileged `app_api` role
- [x] `db/003_provisioning.sql` — mint, extend, revoke, purge, reset password
- [x] `db/004_seed_template.sql` — the demo data as a template tenant, already
      de-branded
- [x] Three suites — isolation, RLS, provisioning — and runners for both
      applying and testing

**Exit met.** Two evaluations can be minted, each sees only its own data, and
52 checks prove it:

```
npm run db:apply     # 4 files, re-runnable
npm run db:test      # ALL DATABASE SUITES PASSED (52 checks)
```

### Sprint 2 — Cut over to our own API

*Goal: nothing reaches the database from a browser.*

- [x] `src/server/{db,query,tables}.ts` — request context, query builder, and a
      whitelist of 22 tables generated from the live schema
- [x] One server function, `runData`
- [x] Client shim with the same surface the screens already call, plus a
      polling stand-in for realtime
- [x] `src/integrations/supabase/` retired entirely, `@supabase/supabase-js`
      uninstalled
- [x] Cloudflare plugin off, `wrangler.jsonc` removed
- [x] **#8 — row ceilings**, in the query builder as both default and cap
- [x] Render smoke test across 19 routes, detail screens included

**Exit met.** Every screen renders with no Supabase dependency anywhere, and
the driver, the SQL builder and the connection string appear only in the server
bundle:

```
npm run test:render     ALL 19 ROUTES RENDER
npm run db:test         ALL DATABASE SUITES PASSED (52 checks)
```

**Still open:** the Vercel adapter. The Cloudflare target is gone and the build
emits a Node server entry, but nothing has been deployed, so no claim is made
that it runs on Vercel yet. That is the first thing to settle in sprint 6.

### Review of sprints 1–2

Run before starting sprint 3. Both suites were green and sixteen write paths
were broken, because nothing tested whether the screens and the whitelist
agreed with each other.

| Found | Effect |
|---|---|
| `updated_at` written by hand at 13 call sites | Approve, reject, hold, dispatch and complete failed outright on movement orders, notices, stationery and maintenance |
| The trigger that should maintain it was attached only to `app_users` | Removing the client write alone would have left the column permanently null |
| `form_fields.id` not writable | Every field placed in the builder failed to save |
| `reserve_stock`, `release_reservation`, `transfer_stock` | Whitelisted and called, defined in no file and no database; three of four call sites logged the failure and carried on |
| `transfer_stock` argument names differed from the declaration | Both venues bound as null, so it would have moved stock from nowhere to nowhere even once defined |
| The seed was not re-runnable once a demo tenant existed | One lookup matched by reference number across every tenant, and a clone carries the same numbers |
| The shim returned `unknown` | 127 type errors; the project had not typechecked since the cutover |

All fixed. The gap that let them through is closed by
`scripts/callsites-test.mjs`, which reads every query chain and function call
out of the syntax tree and pushes it through the real query builder — static,
no database, no browser. Each of the four defects was reintroduced to confirm
it fails.

```
npm test        typecheck · 160 call sites · 19 routes · 52 database checks
```

Two things were noted and deliberately not changed. The row ceiling now warns
when it truncates instead of dropping rows in silence, but no screen reads the
flag. And `runData` is still unauthenticated: anyone with the deployed URL can
read, write and delete across all 22 whitelisted tables. That is the dependency
between sign-in and deploy — they are both in sprint 6, and sign-in has to land
first.

### Sprint 3 — Make approvals a chain

*Goal: authorization flows up the chain of command, and there is only one
approval system.*

- [x] **#11 — sequential approval with escalation.** Steps created across
      `step_index`; only the lowest unfinished step is `pending`; a rejection
      marks the rest skipped; clarification pauses and resumes in place. Slabs
      escalate cumulatively, so 620,000 climbs Controller → Head → CFO.
- [x] **#2 — Notices and Stationery onto the engine.** Both hardcoded `CHAIN`
      arrays deleted — they named EMP-1134 and EMP-0445, employees who stopped
      existing at de-branding, so those approvals had been routing to nobody.
- [x] **#17 — Maintenance three-tier hierarchy** (divisional → moderator →
      admin), with approving separated from fulfilment.
- [x] **#13 — forward/reassign and add-a-reviewer**, both reachable from the
      queue.
- [x] Chain tests — 17 checks, all about order.

**Exit met.** A 620,000 claim walks three levels, one approver at a time,
through the queries each persona's screen runs:

```
Raj Patel      (Finance Controller)      sees it at step 1 — nobody else can act
Dana Whitfield (Head of Finance)         sees it at step 2 — nobody else can act
Alex Mercer    (Chief Financial Officer) sees it at step 3 — nobody else can act
submission is now: completed
```

**How the subject is held.** `approval_requests` now hangs off any of four
things via an exclusive arc: four nullable references, exactly one set, with
`subject_id` and `subject_type` generated from whichever is populated. A
polymorphic `(type, id)` pair would have been shorter and would have discarded
the foreign keys that keep a step and its subject in one tenant.

**Where the engine lives.** In the database. Advancing a chain is several
writes that must all happen or none — mark the step, open the next, move the
subject's status — and whose turn it is cannot be a client's opinion.
`approval_requests` has no writable columns at all now; every transition is a
function call. The load-bearing rule is that only a `pending` step can be acted
on, verified by removing the guard and watching the suite fail.

**Two things found while doing it.** `recomputeSubmissionStatus` decided a
submission was complete by checking every sibling step was approved, which read
`waiting` as "not approved yet" and so completed nothing. And the seed was
still not re-runnable: two more lookups matched across tenants once a clone
existed, the same class of bug as the one fixed in the review.

### Sprint 4 — Stop the demo contradicting itself

*Goal: nothing on screen states something the data does not support.*

- [x] **#1 — slab tables render from `approval_slabs`.** Both hardcoded copies
      deleted. They disagreed with each other and with the database, and named
      four people who stopped existing at the schema port.
- [x] **#3 — required-field validation on submit**, across every step rather
      than only the one being left.
- [x] **#7 — dashboard panels wired** to real submissions and real pending
      steps, with the two dead "view all" links pointed somewhere.
- [x] **#10 — deadlines presented as targets**, and ordering the queue.
- [x] **#4 — notification bell reads real data**, marks read, and hides the
      badge at zero.

**Exit met.** Every figure and every name on screen traces to a row.

**The Board Approval tier is dropped, not seeded.** A committee is not an
employee, and `approval_slabs.approver_user_id` references one — so making it
real meant either inventing a person called "Board", which is the demo lying in
a new way, or building quorum approval, which is a feature and not a
correction. The top band is unbounded and ends at the CFO, which is what the
escalation has always done.

**Found while doing it.** The form said "Submitting as Ahmed Rahman" while
recording `EMP-2847`, who is somebody else: a constant naming one person and
carrying another's id. The same class as the persona drift found during the
de-brand, and the reason the subject-labelling written in sprint 3 was lifted
into `chain.ts` rather than copied — two copies drift, as the band tables did.

### Sprint 5 — Notifications and the visible surface

*Goal: the parts a prospect touches first stop feeling unfinished.*

- [x] **#12 — in-app notifications**, written by the chain at the four moments
      that matter: a step opening, a step forwarded, a chain finishing, and a
      rejection or clarification going back to whoever raised it. Watchers in
      `notification_rules` hear about new submissions.
- [x] **#5 — global search wired** across submissions, forms, people, notices,
      maintenance and stationery, with the ⌘K the badge already advertised.
- [x] **#6 — breadcrumb reflects the route** (done early, on report).
- [x] **#9 — loading states** on the forms list and both builder people-steps.
- [x] **#15 — working-day targets and overdue reminders**, which is what turns
      #10 from indicative into real.

**Exit met.** An approver is told it is their turn, proved against the deployed
tenant's own data:

```
620,000 claim is with EMP-0312; approving it…
approval.turn notifications: 2 -> 3
newest: Dana Whitfield — "Your approval is needed"
        Travel & Expense Reimbursement has cleared the previous approver
        and is now with you.
```

**Delivery is in-app only and the interface says so.** No mail, no SMS. A
notification that silently goes nowhere is worse than none, because people stop
checking the place it should have appeared.

**Targets now count working days.** "Three days" meaning Friday to Monday is
what made the old ones useless — a third of every target landed on a weekend
nobody was working, so requests arrived already overdue.
`remind_overdue()` writes one reminder per person per day; the approvals screen
asks for it on load, because a demo has no scheduler, and the comment says so
rather than implying a timer exists.

**Search results all go somewhere real.** A submission has no name of its own,
so it is found through the values inside it — typing a person's name finds
their claim. A person opens the activity log filtered to them, which meant
giving that route an `actor` parameter and actually filtering on it: a result
that navigates somewhere and changes nothing would have been the same class of
lie the last sprint removed.

**Found while doing it.** The seed called the chain engine while being applied
*before* it. It only worked because the functions survived from a previous
apply — on a genuinely fresh database `db:apply` would have failed at the seed.
The files are renumbered so dependencies come first and the seed is last.

### Sprint 6 — Access, remaining features, ship

*Goal: it can be handed to a stranger.*

- [ ] Sign-in, and evaluation credentials that expire — ported from the survey
      platform, including the staff console for issuing, extending, revoking and
      resetting
- [ ] Persona switching preserved **inside** a tenant. It is the best thing the
      demo does and it is not authentication.

**One credential per prospect, not one per approval level.** The chain has six
levels, which is not six logins: the levels are personas, and switching between
them is a demo feature. Six accounts would mean signing out and back in five
times to watch one request climb, which is the opposite of the point. A
prospect gets one login, lands in a sandbox cloned from the template, and
switches persona with a click.

The reason to gate it is not the data — the platform generates nothing
sensitive, unlike the survey platform's respondent answers. It is that two
prospects sharing one URL would edit each other's forms mid-demo, that the data
endpoint permits deletes across 22 tables, and that an ungated link still works
a year later in somebody else's browser. Provisioning already does all of this
(`db/003_provisioning.sql`: mint, extend, revoke, purge, reset); sign-in is a
form in front of it.
- [ ] **#14 — save a submission as a draft**
- [ ] **#16 — Business Card acknowledgment gate**, including the spec's full
      status vocabulary
- [ ] Full de-brand sweep — 31 source files, 8 database files, personas,
      identifiers, regional details
- [ ] Deploy to Vercel, region pinned to the database
- [ ] `docs/DEPLOY.md`, README rewrite

**Exit:** a prospect is issued a login that expires on its own, and sees a demo
that names nobody.

---

## 4. Deliberately excluded

Dispatch, Event Coordination, Interview and Access Support, GMS, VMS, Air
Ticketing, standalone Stock & Inventory — each is a project, and none makes the
demo land better. Also out: mobile app, ERP and Tableau integration, MFA,
directory sync, division management.

Worth stating to anyone reading the requirements audit alongside this: five of
the ten specified Admin modules stay absent, on purpose.

---

## 5. Risks

**The cutover is the dangerous sprint.** 156 call sites, no tests today, and the
failure mode is a blank screen rather than an error. Mitigation: build the
render smoke test before the shim, not after, and verify `movement-orders.tsx`
first.

**21 tables of composite keys is where mistakes hide.** The isolation suite
exists and passes; extend it as tables gain policies rather than trusting the
pattern held.

**The chain rewrite touches the demo's best feature.** Slab routing and
content-derived approvers are what make this impressive. Sprint 3 changes their
semantics, so the chain tests matter more than their line count suggests.

**Shared infrastructure.** This currently sits on a separate database inside the
same Neon project as the survey platform — logically isolated, shared compute.
Fine for a demo; flag it if genuinely separate infrastructure is wanted.

---

## 6. Status

**Sprint 1 is complete.** 52 checks across three suites, run against Neon.

```
isolation      6 checks   composite keys hold the tenant boundary
rls           17 checks   the policies actually restrict
provisioning  29 checks   minting, cloning, lifecycle, reset
```

Two findings worth carrying forward.

**The owning role bypasses row-level security.** `neondb_owner` carries
BYPASSRLS on Neon, so it is exempt whatever FORCE says. That is what lets the
seed write across tenants, and it means testing as the owner proves nothing.
What makes the application safe is dropping to `app_api` for the life of each
transaction, and the suites do the same.

**Never run the suites through the pooler.** They carry fixture ids in
session-level settings, and a transaction pooler hands one server connection to
several clients — a setting left by one suite arrived in the next one's and
silently disabled the policies consulting it. `db:test` now refuses a pooled
endpoint. The application is unaffected: it sets context transaction-locally,
which is what a pooler resets.
