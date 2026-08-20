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

- [ ] Port `api/_lib` — request context, query builder, table whitelist for 25
      tables, auth helpers
- [ ] `/api/data` endpoint
- [ ] Client shim presenting the same surface `@supabase/supabase-js` did, so
      all 156 call sites stay as they are
- [ ] Retire `src/integrations/supabase/` — client, server client, dead auth
      middleware, 1,058 lines of generated types
- [ ] Swap Cloudflare Workers config for Vercel
- [ ] **#8 — pagination and row ceilings**, done here because the whitelist is
      the natural place for a default limit
- [ ] Render smoke test across all 20 routes

**Exit:** every screen works with no Supabase dependency anywhere. Verify
`movement-orders.tsx` first — it holds a fifth of the queries.

**Risk:** the largest sprint, and the one where a missed call site shows up as a
blank screen rather than an error. The render test is the mitigation.

### Sprint 3 — Make approvals a chain

*Goal: authorization flows up the chain of command, and there is only one
approval system.*

- [ ] **#11 — sequential approval with escalation.** Requests created across
      `step_index`; only the lowest unfinished step is `pending`; a rejection
      stops the chain; clarification pauses it. Slab resolution returns every
      level up to the threshold, so 600,000 climbs Controller → Head → CFO.
- [ ] **#2 — Notices and Stationery onto the engine**, deleting both hardcoded
      `CHAIN` arrays. Their approvals then appear in the queue, history and
      timeline like everything else.
- [ ] **#17 — Maintenance three-tier hierarchy** (Divisional → Moderator →
      Admin), nearly free once the chain exists.
- [ ] **#13 — forward/reassign and add-a-reviewer.** `reassigned_from` is
      already in the schema; adding a reviewer inserts a step and renumbers.
- [ ] Chain tests: order enforced, rejection halts, reassignment preserves the
      trail, a reviewer inserted mid-chain does not strand the rest.

**Exit:** a 600,000 request can be walked up three levels on screen, using the
persona switcher, and the timeline shows it.

### Sprint 4 — Stop the demo contradicting itself

*Goal: nothing on screen states something the data does not support.*

- [ ] **#1 — slab tables render from `approval_slabs`.** Delete both hardcoded
      versions. Decide whether the Board Approval tier is real: either seed it
      or stop promising it.
- [ ] **#3 — required-field validation on submit.** Run the same check
      `handleNext()` uses before `handleSubmit()` proceeds.
- [ ] **#7 — dashboard panels wired** to the data that already exists elsewhere.
- [ ] **#10 — SLA deadlines act on something**, or are presented as indicative.
- [ ] **#4 — notification bell reads real data** (delivery lands next sprint;
      the count and list stop being literals here).

**Exit:** every figure on screen traces to a row.

### Sprint 5 — Notifications and the visible surface

*Goal: the parts a prospect touches first stop feeling unfinished.*

- [ ] **#12 — in-app notifications.** Drive the `notifications` table from chain
      events and the existing `notification_rules`. No mail or SMS gateway; the
      interface says so rather than implying one.
- [ ] **#5 — global search wired** across submissions, forms and people, with
      the ⌘K the badge already advertises.
- [ ] **#6 — breadcrumb reflects the route.**
- [ ] **#9 — loading states** on the builder screens and the forms list.
- [ ] **#15 — working-day SLA and overdue reminders**, which turns #10 from
      indicative into real.

**Exit:** an approver is told it is their turn, and can find anything from the
top bar.

### Sprint 6 — Access, remaining features, ship

*Goal: it can be handed to a stranger.*

- [ ] Sign-in, and evaluation credentials that expire — ported from the survey
      platform, including the staff console for issuing, extending, revoking and
      resetting
- [ ] Persona switching preserved **inside** a tenant. It is the best thing the
      demo does and it is not authentication.
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
