# Known issues

Twenty-one findings from the August 2026 review that were deliberately
left open. Each is real and each was verified against the source. None of
them is reachable by using the demo — every one needs a hand-made API
call, or a second tenant, or a database this one is not.

That is the whole reason they are here rather than fixed. This is an
evaluation demo: seeded data, tenants that expire on their own, one
credential per prospect, and a persona switcher that is deliberately
unrestricted. Under those conditions the items below cost nothing. Under
production conditions several of them cost a great deal, and the point of
writing them down is so that the day the second condition arrives, nobody
has to find them again.

The twenty-three findings that *were* reachable have been fixed — see the
commits between `b61614b` and `f155f21`.

**If this moves out of demo, do the five in "Before real data" first.**
Nothing else in this file is urgent; those five stop being theoretical
the moment one real tenant exists.

---

## Before real data

### 1. Deleting a form template destroys every submission and its approval history

`db/001_schema.sql` — `form_submissions.form_template_id` references
`form_templates(id, tenant_id)` `on delete cascade`, and
`submission_values` and `approval_requests` cascade in turn. Deleting one
template erases every submission ever made against it, every answer, and
every approval step and comment, irreversibly.

Nothing in the interface performs a real delete — the trash button on the
Forms screen runs `update({ status: 'draft' })` — so this is reachable
only through the data endpoint. But `form_templates` is in the writable
whitelist and the write policy admits any signed-in member regardless of
role, so a crafted call is all it takes.

It also sits oddly beside the care taken elsewhere: `activity_log` and
`staff_audit` are deliberately append-only, and the detailed history they
summarise is not.

**Fix:** `on delete restrict`, or an `archived` status instead of hard
deletes, and drop `form_templates` from the generically-deletable set.

### 2. The amount that drives finance escalation is supplied by the caller

`src/server/tables.ts` — `build_approval_chain` takes `p_amount` as a
bare RPC parameter and never re-derives it from the submission's own
money field. Submit a claim of 620,000, call the RPC with
`p_amount: 50`, and the CFO and Head of Finance are never asked while the
form still displays 620,000 to anyone who opens it.

The comment directly above the allowlist says these RPCs exist because
"whose turn it is must be decided somewhere the browser cannot skip".
This is the one value that escaped that rule.

**Fix:** read the amount from the submission's money-typed
`submission_values` row inside the function, and drop `p_amount` from the
signature.

### 3. The reservation ledger is directly writable

`src/server/tables.ts` — `item_stock` lists `reserved_quantity`,
`item_id` and `venue_id` as writable. The `reserve_stock` /
`release_reservation` / `transfer_stock` functions take row locks and the
CHECK constraints stop the ledger going negative, but nothing confines
reservation changes to those functions. A member can set
`reserved_quantity = 0` on a row backing an open movement order —
silently releasing a reservation without cancelling anything.

**Fix:** leave only `quantity` writable, for stock-take adjustments.
Every reservation change goes through the RPCs.

### 4. Nothing checks that the caller owns the approval step

`db/005_chain.sql`, `db/002_rls.sql` — `act_on_approval`,
`reassign_approval` and `add_reviewer` verify that a step is open, not
that the caller is the person it is open with. The write policy is the
generic `tenant_id = current_tenant() and is_member()`.

**This is intentional here.** `db/002_rls.sql` says so directly: one
login per prospect, and no distinction drawn between members. The
persona switcher is a demo feature, not authentication.

It is listed because it has one consequence that is easy to miss:
**delegation date ranges and form scoping are enforced in the interface
only.** A delegate can act outside their window, or on a form outside
their scope, because nothing server-side consults `delegation_rules`. If
delegation is ever shown as a real capability rather than a demo
gesture, that is a gap.

**Fix, if the model changes:** have the three functions resolve the
caller's identity to `approver_user_id`, directly or through an active,
in-window, correctly-scoped delegation.

### 5. Delegation scope is the one place the tenant invariant is not enforced by the database

`db/001_schema.sql` — `delegation_rules.form_template_ids` is a `uuid[]`,
and Postgres cannot put a foreign key on an array. Provisioning carefully
remaps the array when cloning a tenant, which proves the need is
understood, but ordinary writes go straight to the column with no check
that each id is a real template belonging to the same tenant.

Every other parent reference in the schema is a composite
`(id, tenant_id)` foreign key. This is the exception.

**Fix:** a `before insert or update` trigger validating every element
against `form_templates` for the row's own `tenant_id`.

---

## Hardening

### 6. TLS certificates are not verified on any non-local database connection

`src/server/db.ts`, `api/health.mjs` — `rejectUnauthorized: false`
applies to everything that is not `localhost`, which in practice means
all production traffic. The health endpoint sets it unconditionally, with
no local exemption. Connections are encrypted but unauthenticated.

**Fix:** delete the flag. Neon's certificates chain to a public CA, so
this is almost certainly left over from local debugging. One line.

### 7. CSV export has no formula-injection guard

`src/lib/csv.ts` — quote, comma and newline escaping is correct, but
nothing handles a leading `=`, `+`, `-` or `@`. Item and venue names are
unrestricted free text and reach the exported columns, so a venue named
`=HYPERLINK("http://evil","x")` executes when the file is opened in
Excel. The same helper backs the submissions and approval-history
exports, which carry more user-authored text still.

A smaller point in the same function: the quoting test checks `\n` but
not `\r`, so a lone carriage return breaks the row.

**Fix:** prefix values beginning with those four characters, and add
`\r` to the quoting test. Both land in the same three lines.

### 8. Prototype keys pass the whitelist guards

`src/server/tables.ts`, `src/server/query.ts` — `TABLES`, `RPCS` and
`OPERATORS` are plain objects checked only for truthiness, so
`TABLES['constructor']` gets past `if (!def) throw`.

Verified harmless: the spread of `Object.prototype` is empty, so the
request dies with a `TypeError` before any connection opens. **No data is
reachable.** It turns a clean 400 into a 500 and breaks the documented
fail-closed behaviour.

**Fix:** `Object.create(null)` for the three maps.

### 9. Primary keys are writable on update, not only on insert

`src/server/tables.ts`, `src/server/query.ts` — `id` is writable on
`form_fields` so the client can mint a UUID at insert time, but the same
list governs updates. A user can rewrite an existing row's primary key
within their own tenant, orphaning it from anything still holding the old
id. No isolation break.

**Fix:** separate insert-only columns from update-writable ones.

---

## Data integrity

### 10. The assigned mover is unconstrained text

`db/001_schema.sql` — `movement_orders.assigned_mover_id` is bare `text`
with no foreign key, two lines below `requester_id`, which correctly
carries the composite reference. A bogus or foreign-tenant employee id
persists silently.

Note that `maintenance_requests.assigned_to` is correctly unconstrained —
it holds external vendor names like `Coolair Services`.

**Fix:** composite FK to `employees(employee_id, tenant_id)` with
`on delete set null`.

### 11. Two answers can exist for one question

`db/001_schema.sql` — `submission_values` has no unique constraint on
`(submission_id, field_name)`, so a retried write leaves two rows for one
field with no defined winner.

Related to the label-keying below: fix the key first, then constrain it.

### 12. Answers are keyed by label rather than by field id

`src/routes/forms.$formId.tsx` — a submission's answers are stored
against the field's label. Two fields sharing a label collide.

The builder now refuses to continue while two labels match, so this
cannot be created through the interface any more. The underlying design
is still fragile: renaming a field after submissions exist orphans the
old answers.

**Fix:** key `submission_values` by `field_id`. This needs a migration
for existing rows and a rewrite of the read path, which is why it was not
done for the demo.

### 13. A slab can be stored with its maximum below its minimum

`db/001_schema.sql` — no CHECK ties `max_amount` to `min_amount`.

Largely moot now: `max_amount` is no longer collected and neither engine
has ever read it. If the column is ever revived, constrain it. Better
still, drop the column.

### 14. No composite index on the filter the screens actually use

`db/001_schema.sql` — `movement_orders` and `form_submissions` are
indexed on `(tenant_id, created_at)`, but the primary filter in both
screens is status. Invisible at demo scale.

---

## Correctness, quietly

### 15. Failed answer writes still report success

`src/routes/forms.$formId.tsx` — the draft-save and submit paths delete
the existing values and then insert the new ones, discarding the insert
result. If the insert fails, the submission is left with no answers while
the interface reports success.

**Fix:** check the error before declaring success, and make
delete-then-insert one transaction.

### 16. Activity-trail writes are never error-checked

Repeats across movement orders, maintenance, stationery and notices:
`await db.from("activity_log").insert(...)` with no error check. Against
a product that promises a trail which cannot be rewritten, a silently
dropped insert leaves a gap while the action reports success.

### 17. Order creation and stock reservation are not atomic

`src/routes/movement-orders.tsx` — if `reserve_stock` fails, the code
shows a warning and still reports the order submitted, leaving an order
with no backing reservation. Milder than the approval path, which is now
a single transaction: the failure mode here is silent under-reservation,
not corruption, because the RPC's own guards hold.

**Fix:** the same treatment `approve_movement_order` received.

### 18. Global search has no stale-response guard

`src/components/shell/GlobalSearch.tsx` — the query is debounced but
responses are not sequenced or aborted, so a slower earlier request can
overwrite the results of a faster later one.

### 19. Delegation windows use UTC dates, not local ones

`src/routes/approvals.tsx`, `src/routes/approvals.delegate.tsx` —
`new Date().toISOString().slice(0,10)` compared against `date` columns.
At UTC+6 a delegation ending on the 23rd stops being honoured at 18:00
local on the 23rd, and one starting on the 24th is not honoured until
06:00 local. Skewed in both directions.

### 20. A hook sits below an early return

`src/components/builder/Canvas.tsx` — `useSortable` is called after the
layout-field early return, which lint flags as a rules-of-hooks
violation.

**It cannot fire today.** Both routes to reaching it were checked: field
kind is immutable once placed, and the list is keyed by field id, so each
card keeps a fixed kind and the hook order never changes. Worth fixing so
that adding a "change field type" feature does not detonate it.

### 21. The staff-account script's fast path always throws

`scripts/staff-account.mjs` — `ON CONFLICT ON CONSTRAINT
app_users_username_key` names a unique *index*, not a constraint, and
Postgres only accepts named constraints there. The script's own comment
acknowledges the fallback, so it works, but every run pays for a
guaranteed failed query first.

---

## What is deliberately not here

Lint reports about 2,100 Prettier disagreements. They are pre-existing
style drift — single versus double quotes in `src/server/*`, mostly — and
not defects. A whole-repo reformat would bury every future diff, so it
should be one commit of its own or none at all.

`npm run lint` is not part of `npm test`, which is why the line-ending
noise that used to hide these went unnoticed for so long. That part is
fixed: `endOfLine: "auto"` in `.prettierrc`.
