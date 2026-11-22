-- =====================================================================
-- Approval platform — schema
--
-- A port of the 18 Supabase migrations onto plain Postgres, with three
-- deliberate changes:
--
--   1. Every table carries a tenant, and every child references its
--      parent on (id, tenant_id) rather than id alone. A record cannot
--      point across a tenant boundary even if a query forgets to filter.
--
--   2. Approvals are a SEQUENCE, not a set. The previous build created
--      every approver's request at once, all pending, with no column
--      expressing order -- so a CFO could approve before the line
--      manager had seen it. approval_requests now carries step_index and
--      a `waiting` state, and only the lowest unfinished step is live.
--
--   3. Employee identifiers are neutral (EMP-xxxx). The originals named
--      the client.
--
-- No Supabase: gen_random_uuid() is built into Postgres 13+, and nothing
-- here depends on auth.*, storage.* or PostgREST.
-- =====================================================================

begin;

create schema if not exists app;

-- ---------------------------------------------------------------------
-- Session context. The API sets these per request, transaction-locally.
-- Anything unset resolves to NULL, and `tenant_id = NULL` is never true,
-- so a connection with no context reads nothing rather than everything.
-- ---------------------------------------------------------------------
create or replace function app.current_tenant() returns uuid
language sql stable as $fn$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$fn$;

create or replace function app.current_user_id() returns uuid
language sql stable as $fn$
  select nullif(current_setting('app.user_id', true), '')::uuid
$fn$;

create or replace function app.current_role() returns text
language sql stable as $fn$
  select coalesce(nullif(current_setting('app.role', true), ''), 'anon')
$fn$;

create or replace function app.is_staff() returns boolean
language sql stable as $fn$
  select coalesce(nullif(current_setting('app.is_staff', true), ''), 'false')::boolean
$fn$;

create or replace function app.set_updated_at() returns trigger
language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end $fn$;

-- =====================================================================
-- tenants and platform accounts
--
-- One tenant per evaluation. Demo tenants expire; the template never
-- does, because every demo is cloned from it.
-- =====================================================================
create table if not exists public.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique not null,
  kind       text not null default 'demo' check (kind in ('demo','template','internal')),
  expires_at timestamptz,
  revoked_at timestamptz,
  notes      text,
  created_by uuid,
  created_at timestamptz not null default now()
);

do $ck$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_expiry_rule') then
    alter table public.tenants add constraint tenants_expiry_rule check (
      (kind = 'demo' and expires_at is not null)
      or (kind in ('template','internal') and expires_at is null)
    );
  end if;
end $ck$;

create index if not exists tenants_expiry_idx on public.tenants(expires_at)
  where expires_at is not null;

-- Sign-in accounts. Distinct from `employees`: an employee is a person
-- inside the demo's org chart, an app_user is someone who can log in.
-- A prospect gets one app_user and switches between employees freely --
-- that persona switching is the demo's whole point, so it stays.
create table if not exists public.app_users (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid references public.tenants(id) on delete cascade,
  username            text not null,
  password_hash       text not null,
  full_name           text,
  email               text,
  role                text not null default 'admin' check (role in ('admin','creator','viewer')),
  is_staff            boolean not null default false,
  status              text not null default 'active' check (status in ('active','disabled')),
  must_change_pw      boolean not null default false,
  password_changed_at timestamptz not null default now(),
  last_login_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists app_users_username_key
  on public.app_users(lower(username));
create index if not exists app_users_tenant_idx on public.app_users(tenant_id);

do $ck$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_users_tenancy_rule') then
    alter table public.app_users add constraint app_users_tenancy_rule check (
      (is_staff = true and tenant_id is null)
      or (is_staff = false and tenant_id is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_users_id_tenant_key') then
    alter table public.app_users add constraint app_users_id_tenant_key unique (id, tenant_id);
  end if;
end $ck$;

drop trigger if exists app_users_updated on public.app_users;
create trigger app_users_updated before update on public.app_users
for each row execute function app.set_updated_at();

do $ck$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_created_by_fkey') then
    alter table public.tenants add constraint tenants_created_by_fkey
      foreign key (created_by) references public.app_users(id) on delete set null;
  end if;
end $ck$;

-- =====================================================================
-- employees — the org chart the demo runs on
--
-- employee_id is the join key everything else uses (14 columns point at
-- it). It was globally unique; it is now unique PER TENANT, so two
-- prospects can both have an EMP-0201 without colliding.
-- =====================================================================
create table if not exists public.employees (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default app.current_tenant()
                          references public.tenants(id) on delete cascade,
  employee_id           text not null,
  name                  text not null,
  designation           text,
  department            text,
  line_manager_id       text,
  gate_pass_card_number text,
  unique (employee_id, tenant_id),
  unique (id, tenant_id)
);
create index if not exists employees_tenant_idx on public.employees(tenant_id);

-- Self-referencing, and still tenant-safe: a line manager must be an
-- employee of the same tenant.
do $ck$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_line_manager_fkey') then
    alter table public.employees add constraint employees_line_manager_fkey
      foreign key (line_manager_id, tenant_id)
      references public.employees(employee_id, tenant_id) on delete set null;
  end if;
end $ck$;

-- =====================================================================
-- forms
-- =====================================================================
create table if not exists public.form_templates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default app.current_tenant()
               references public.tenants(id) on delete cascade,
  name       text not null,
  category   text check (category in ('Finance','HR','Admin')),
  created_by text,
  status     text not null default 'draft' check (status in ('draft','published')),
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (created_by, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
);
create index if not exists form_templates_tenant_idx on public.form_templates(tenant_id);

create table if not exists public.form_fields (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant()
                     references public.tenants(id) on delete cascade,
  form_template_id uuid not null,
  field_type       text,
  field_name       text,
  field_config     jsonb,
  order_index      integer,
  is_required      boolean not null default true,
  unique (id, tenant_id),
  foreign key (form_template_id, tenant_id)
    references public.form_templates(id, tenant_id) on delete cascade
);
create index if not exists form_fields_template_idx
  on public.form_fields(tenant_id, form_template_id, order_index);

-- =====================================================================
-- approval configuration
--
-- approval_rules gains step_index: the chain has an order at
-- configuration time, and that order is what submission copies onto the
-- requests it creates.
-- =====================================================================
-- How a chain is configured, for every kind of subject.
--
-- A form submission's chain is configured per template; a notice,
-- stationery or maintenance chain is configured once for the whole
-- subject type, so form_template_id is null for those. One table rather
-- than an array in the frontend per feature, which is what this
-- replaces.
create table if not exists public.approval_rules (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant()
                     references public.tenants(id) on delete cascade,
  subject_type     text not null default 'form_submission'
                     check (subject_type in ('form_submission','notice',
                                             'stationery_request','maintenance_request')),
  form_template_id uuid,
  approver_user_id text,
  deadline_days    integer not null default 7,
  is_auto_added    boolean not null default false,
  label            text,
  step_index       integer not null default 0,
  unique (id, tenant_id),
  foreign key (form_template_id, tenant_id)
    references public.form_templates(id, tenant_id) on delete cascade,
  foreign key (approver_user_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
);
create index if not exists approval_rules_template_idx
  on public.approval_rules(tenant_id, form_template_id, step_index);

create table if not exists public.approval_slabs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant()
                     references public.tenants(id) on delete cascade,
  form_template_id uuid not null,
  min_amount       numeric not null,
  max_amount       numeric,
  approver_user_id text not null,
  order_index      integer not null default 0,
  unique (id, tenant_id),
  foreign key (form_template_id, tenant_id)
    references public.form_templates(id, tenant_id) on delete cascade,
  foreign key (approver_user_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete cascade
);
create index if not exists approval_slabs_template_idx
  on public.approval_slabs(tenant_id, form_template_id, order_index);

create table if not exists public.notification_rules (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant()
                     references public.tenants(id) on delete cascade,
  form_template_id uuid not null,
  notifyee_user_id text,
  is_auto_added    boolean not null default false,
  label            text,
  unique (id, tenant_id),
  foreign key (form_template_id, tenant_id)
    references public.form_templates(id, tenant_id) on delete cascade,
  foreign key (notifyee_user_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete cascade
);

create table if not exists public.delegation_rules (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null default app.current_tenant()
                      references public.tenants(id) on delete cascade,
  delegator_id      text not null,
  delegate_id       text not null,
  start_date        date not null,
  end_date          date not null,
  reason            text,
  form_template_ids uuid[],
  created_at        timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (delegator_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete cascade,
  foreign key (delegate_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete cascade,
  check (end_date >= start_date)
);

-- =====================================================================
-- submissions and the approval chain
-- =====================================================================
create table if not exists public.form_submissions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant()
                     references public.tenants(id) on delete cascade,
  form_template_id uuid not null,
  submitted_by     text,
  status           text not null default 'submitted'
                     check (status in ('draft','submitted','in_progress','on_hold','completed','rejected','cancelled')),
  submitted_at     timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (form_template_id, tenant_id)
    references public.form_templates(id, tenant_id) on delete cascade,
  foreign key (submitted_by, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
);
create index if not exists form_submissions_tenant_idx
  on public.form_submissions(tenant_id, submitted_at desc);

create table if not exists public.submission_values (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant()
                  references public.tenants(id) on delete cascade,
  submission_id uuid not null,
  field_name    text,
  value         text,
  unique (id, tenant_id),
  foreign key (submission_id, tenant_id)
    references public.form_submissions(id, tenant_id) on delete cascade
);
create index if not exists submission_values_submission_idx
  on public.submission_values(tenant_id, submission_id);

-- ---------------------------------------------------------------------
-- attachments — the file behind a file field.
--
-- The file field used to keep only the name a browser reported, so a
-- submission "with an attachment" had nothing attached. The bytes live
-- here, keyed by the submission and the field they answer, which is how
-- submission_values is keyed too: the answer row still carries the file
-- name, so every screen that already shows answers keeps working, and
-- the screens that can offer a download look the file up by the pair.
--
-- In the database rather than an object store because it is the one
-- store this deployment already has, and it puts files behind the same
-- tenant boundary and policies as everything else. Size is capped by the
-- server function that writes here, below what a serverless request body
-- can carry.
-- ---------------------------------------------------------------------
create table if not exists public.attachments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant()
                  references public.tenants(id) on delete cascade,
  submission_id uuid not null,
  field_name    text not null,
  file_name     text not null,
  content_type  text not null default 'application/octet-stream',
  size_bytes    integer not null check (size_bytes >= 0),
  data          bytea not null,
  uploaded_by   text,
  created_at    timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (submission_id, tenant_id)
    references public.form_submissions(id, tenant_id) on delete cascade
);
create index if not exists attachments_submission_idx
  on public.attachments(tenant_id, submission_id);

-- ---------------------------------------------------------------------
-- approval_requests — one row per step, in order.
--
-- `waiting` is the new state and the reason this table changed. A
-- request becomes `pending` only when every lower step has been
-- approved; until then it is not the approver's problem and does not
-- appear in their queue. The old build had no such column, so every
-- approver was asked at once.
--
-- (submission_id, step_index) is unique: two approvers cannot occupy the
-- same rung. Parallel approval at one rung would need a different shape,
-- and the specification does not ask for it.
-- ---------------------------------------------------------------------
-- An approval step, on whatever is being approved.
--
-- Four things go through a chain — a form submission, a notice, a
-- stationery request and a maintenance request — and they are separate
-- tables, so the subject is held as an exclusive arc: four nullable
-- references, exactly one of which is set. A single polymorphic
-- (type, id) pair would have been shorter and would have thrown away
-- every foreign key, which is what keeps a step and its subject inside
-- the same tenant. subject_id and subject_type are generated from
-- whichever column is populated, so queries and the step-order
-- constraint have one column to work with.
create table if not exists public.approval_requests (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant()
                     references public.tenants(id) on delete cascade,
  submission_id            uuid,
  notice_id                uuid,
  stationery_request_id    uuid,
  maintenance_request_id   uuid,
  subject_id       uuid generated always as (
                     coalesce(submission_id, notice_id,
                              stationery_request_id, maintenance_request_id)) stored,
  subject_type     text generated always as (
                     case
                       when submission_id          is not null then 'form_submission'
                       when notice_id              is not null then 'notice'
                       when stationery_request_id  is not null then 'stationery_request'
                       when maintenance_request_id is not null then 'maintenance_request'
                     end) stored,
  approver_user_id text,
  step_index       integer not null default 0,
  lane             integer not null default 0,
  lane_step        integer not null default 0,
  status           text not null default 'waiting'
                     check (status in ('waiting','pending','approved','rejected','clarification','skipped')),
  comment          text,
  acted_at         timestamptz,
  deadline_at      timestamptz,
  -- Set when an approver forwards their step to someone else, so the
  -- trail shows who it was originally asked of.
  reassigned_from  text,
  created_at       timestamptz not null default now(),
  unique (id, tenant_id),
  -- A step_index is a phase, and a phase may run several lanes at once,
  -- each with its own steps in order (see the Stage 1 block at the end).
  -- What is unique is a position: phase, lane, step within the lane.
  -- Deferrable: inserting a reviewer renumbers the steps after it, and
  -- that shuffle passes through states where two rows briefly share one.
  constraint approval_requests_position_key
    unique (subject_id, step_index, lane, lane_step) deferrable initially immediate,
  check (num_nonnulls(submission_id, notice_id,
                      stationery_request_id, maintenance_request_id) = 1),
  foreign key (submission_id, tenant_id)
    references public.form_submissions(id, tenant_id) on delete cascade,
  foreign key (approver_user_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
  -- The other three subjects are declared further down: their tables are
  -- created after this one.
);
create index if not exists approval_requests_queue_idx
  on public.approval_requests(tenant_id, approver_user_id, status);
create index if not exists approval_requests_chain_idx
  on public.approval_requests(tenant_id, submission_id, step_index);

-- =====================================================================
-- operations modules
-- =====================================================================
create table if not exists public.items (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.current_tenant()
              references public.tenants(id) on delete cascade,
  name      text not null,
  type      text,
  unique (id, tenant_id)
);

create table if not exists public.venues (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.current_tenant()
              references public.tenants(id) on delete cascade,
  name      text not null,
  floor     text,
  unique (id, tenant_id)
);

create table if not exists public.item_stock (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null default app.current_tenant()
                      references public.tenants(id) on delete cascade,
  item_id           uuid not null,
  venue_id          uuid not null,
  quantity          int not null default 0,
  reserved_quantity int not null default 0,
  unique (id, tenant_id),
  unique (item_id, venue_id),
  foreign key (item_id, tenant_id)  references public.items(id, tenant_id)  on delete cascade,
  foreign key (venue_id, tenant_id) references public.venues(id, tenant_id) on delete cascade,
  -- Stock cannot go negative, and cannot be reserved beyond what exists.
  -- The previous build enforced this only inside the reserve function.
  check (quantity >= 0),
  check (reserved_quantity >= 0 and reserved_quantity <= quantity)
);

create table if not exists public.movement_orders (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null default app.current_tenant()
                         references public.tenants(id) on delete cascade,
  ref_number           text not null,
  requester_id         text not null,
  item_name            text not null,
  item_type            text,
  quantity             integer not null default 1 check (quantity > 0),
  source_location      text not null,
  destination_location text not null,
  justification        text,
  preferred_time       text,
  assigned_mover_id    text,
  status               text not null default 'submitted',
  admin_comment        text,
  item_id              uuid,
  source_venue_id      uuid,
  destination_venue_id uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz,
  unique (id, tenant_id),
  unique (ref_number, tenant_id),
  foreign key (requester_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete cascade,
  foreign key (item_id, tenant_id)              references public.items(id, tenant_id)  on delete set null,
  foreign key (source_venue_id, tenant_id)      references public.venues(id, tenant_id) on delete set null,
  foreign key (destination_venue_id, tenant_id) references public.venues(id, tenant_id) on delete set null
);
create index if not exists movement_orders_tenant_idx
  on public.movement_orders(tenant_id, created_at desc);

-- Every other workflow table enumerates its statuses inline. This one
-- did not, and the seed shipped 'in_progress' — a value the movement
-- orders screen does not recognise, so the row fell out of every filter
-- tab and rendered no badge. It cannot be added inline now, because
-- "create table if not exists" is a no-op against a database that
-- already has the table; hence the alter. Existing strays are normalised
-- first, or adding the constraint would fail on them.
update public.movement_orders
   set status = 'submitted'
 where status not in
   ('submitted', 'approved', 'in_transit', 'completed', 'rejected', 'on_hold');

alter table public.movement_orders
  drop constraint if exists movement_orders_status_check;
alter table public.movement_orders
  add constraint movement_orders_status_check
  check (status in
    ('submitted', 'approved', 'in_transit', 'completed', 'rejected', 'on_hold'));

create table if not exists public.notices (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant()
                        references public.tenants(id) on delete cascade,
  title               text not null,
  content             text not null,
  category            text,
  status              text not null default 'draft'
                        check (status in ('draft','pending','approved','rejected','published')),
  created_by          text,
  current_approver_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz,
  unique (id, tenant_id),
  foreign key (created_by, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null,
  foreign key (current_approver_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
);

create table if not exists public.notice_comments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default app.current_tenant()
               references public.tenants(id) on delete cascade,
  notice_id  uuid not null,
  author_id  text,
  text       text not null,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (notice_id, tenant_id) references public.notices(id, tenant_id) on delete cascade,
  foreign key (author_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
);

create table if not exists public.stationery_requests (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant()
                        references public.tenants(id) on delete cascade,
  kind                text not null check (kind in ('business_card','stamp_seal')),
  requester_id        text,
  name                text,
  designation         text,
  department          text,
  division            text,
  email               text,
  contact_number      text,
  reason              text,
  comments            text,
  status              text not null default 'open'
                        check (status in ('open','approved','fulfilled','rejected')),
  current_approver_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz,
  unique (id, tenant_id),
  foreign key (requester_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null,
  foreign key (current_approver_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
);

create table if not exists public.maintenance_items (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.current_tenant()
              references public.tenants(id) on delete cascade,
  name      text not null,
  category  text not null check (category in ('AC','Water Purifier','Generator','General','Others')),
  unique (id, tenant_id)
);

create table if not exists public.maintenance_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant()
                  references public.tenants(id) on delete cascade,
  ref_number    text not null,
  requester_id  text,
  location      text not null,
  status        text not null default 'raised'
                  check (status in ('raised','approved','in_progress','on_hold','completed','rejected')),
  assigned_to   text,
  admin_comment text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  unique (id, tenant_id),
  unique (ref_number, tenant_id),
  foreign key (requester_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
);

create table if not exists public.maintenance_request_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant()
                references public.tenants(id) on delete cascade,
  request_id  uuid not null,
  item_id     uuid,
  description text,
  quantity    integer not null default 1 check (quantity > 0),
  unique (id, tenant_id),
  foreign key (request_id, tenant_id)
    references public.maintenance_requests(id, tenant_id) on delete cascade,
  foreign key (item_id, tenant_id)
    references public.maintenance_items(id, tenant_id) on delete set null
);

-- =====================================================================
-- activity_log — the application-level audit trail
-- =====================================================================
create table if not exists public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant()
                references public.tenants(id) on delete cascade,
  actor_id    text,
  action      text not null,
  entity_type text not null,
  entity_id   uuid not null,
  detail      text,
  created_at  timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (actor_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null
);
create index if not exists activity_log_tenant_idx
  on public.activity_log(tenant_id, created_at desc);

-- =====================================================================
-- notifications — new.
--
-- notification_rules existed and stored who should be told; nothing was
-- ever told. This is the delivery side: an in-app feed. There is no mail
-- or SMS gateway, and the UI says so rather than implying one.
-- =====================================================================
create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant()
                  references public.tenants(id) on delete cascade,
  recipient_id  text not null,
  kind          text not null,
  title         text not null,
  body          text,
  entity_type   text,
  entity_id     uuid,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (recipient_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete cascade
);
create index if not exists notifications_inbox_idx
  on public.notifications(tenant_id, recipient_id, read_at, created_at desc);

-- =====================================================================
-- staff_audit — what Intelligent Machines staff did, not what a prospect
-- did. Deliberately not tenant-scoped: it outlives the sandbox it
-- describes, which is exactly when it is wanted.
-- =====================================================================
create table if not exists public.staff_audit (
  id         uuid primary key default gen_random_uuid(),
  ts         timestamptz not null default now(),
  actor_id   uuid references public.app_users(id) on delete set null,
  actor_name text,
  kind       text not null,
  tenant_ref text,
  detail     text,
  meta       jsonb not null default '{}'::jsonb
);
create index if not exists staff_audit_ts_idx on public.staff_audit(ts desc);

-- =====================================================================
-- Chain configuration for subjects that are not form submissions.
-- =====================================================================
alter table public.approval_rules
  add column if not exists subject_type text not null default 'form_submission';
alter table public.approval_rules alter column form_template_id drop not null;

do $arl$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_subject_type_check') then
    alter table public.approval_rules
      add constraint approval_rules_subject_type_check
      check (subject_type in ('form_submission','notice',
                              'stationery_request','maintenance_request'));
  end if;

  -- A form chain names its template; the others must not.
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_template_matches_subject') then
    alter table public.approval_rules
      add constraint approval_rules_template_matches_subject
      check ((subject_type = 'form_submission') = (form_template_id is not null));
  end if;
end $arl$;

-- =====================================================================
-- The approval subject, for databases that already exist.
--
-- Everything here is what the create-table above already says; it runs
-- as a no-op on a fresh database and brings an existing one to the same
-- shape. The three foreign keys are declared here for both, because the
-- tables they point at are created after approval_requests.
-- =====================================================================
alter table public.approval_requests
  alter column submission_id drop not null;

alter table public.approval_requests
  add column if not exists notice_id              uuid,
  add column if not exists stationery_request_id  uuid,
  add column if not exists maintenance_request_id uuid;

-- Generated, so the subject has one column whatever it is. Added after
-- the columns they read.
alter table public.approval_requests
  add column if not exists subject_id uuid generated always as (
    coalesce(submission_id, notice_id, stationery_request_id, maintenance_request_id)) stored;

alter table public.approval_requests
  add column if not exists subject_type text generated always as (
    case
      when submission_id          is not null then 'form_submission'
      when notice_id              is not null then 'notice'
      when stationery_request_id  is not null then 'stationery_request'
      when maintenance_request_id is not null then 'maintenance_request'
    end) stored;

do $arq$
begin
  -- Step order is unique per subject now, not per submission.
  if exists (select 1 from pg_constraint
              where conname = 'approval_requests_submission_id_step_index_key') then
    alter table public.approval_requests
      drop constraint approval_requests_submission_id_step_index_key;
  end if;

  -- One step per index was the rule until phases could run lanes in
  -- parallel. The position constraint that replaces it needs the lane
  -- columns, so it is added in the Stage 1 block at the end of this
  -- file; here the old one is only dropped wherever it still exists.
  if exists (select 1 from pg_constraint
              where conname = 'approval_requests_subject_id_step_index_key') then
    alter table public.approval_requests
      drop constraint approval_requests_subject_id_step_index_key;
  end if;

  -- Exactly one subject. A step attached to nothing, or to two things,
  -- is the failure this arc exists to make impossible.
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_one_subject') then
    alter table public.approval_requests
      add constraint approval_requests_one_subject
      check (num_nonnulls(submission_id, notice_id,
                          stationery_request_id, maintenance_request_id) = 1);
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_notice_fkey') then
    alter table public.approval_requests
      add constraint approval_requests_notice_fkey
      foreign key (notice_id, tenant_id)
      references public.notices(id, tenant_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_stationery_fkey') then
    alter table public.approval_requests
      add constraint approval_requests_stationery_fkey
      foreign key (stationery_request_id, tenant_id)
      references public.stationery_requests(id, tenant_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_maintenance_fkey') then
    alter table public.approval_requests
      add constraint approval_requests_maintenance_fkey
      foreign key (maintenance_request_id, tenant_id)
      references public.maintenance_requests(id, tenant_id) on delete cascade;
  end if;
end $arq$;

create index if not exists approval_requests_subject_idx
  on public.approval_requests(tenant_id, subject_id, step_index);
create index if not exists approval_requests_pending_idx
  on public.approval_requests(tenant_id, approver_user_id, status);

-- =====================================================================
-- updated_at, maintained by the database.
--
-- Four tables carry an updated_at that nothing was setting: the column
-- was declared, no default and no trigger, while the screens wrote it by
-- hand on every action. The API whitelist refuses that write, and
-- rightly — a timestamp the client chooses is not a fact. The trigger
-- already existed for app_users; these are the tables it was never
-- attached to.
-- =====================================================================
do $ua$
declare t text;
begin
  foreach t in array array[
    'movement_orders', 'notices', 'stationery_requests', 'maintenance_requests'
  ] loop
    execute format('alter table public.%I alter column updated_at set default now()', t);
    -- Rows that predate the default, so the column can be made not null.
    execute format(
      'update public.%I set updated_at = coalesce(updated_at, created_at, now())
         where updated_at is null', t);
    execute format('alter table public.%I alter column updated_at set not null', t);
    execute format('drop trigger if exists %I on public.%I', t || '_updated', t);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function app.set_updated_at()', t || '_updated', t);
  end loop;
end $ua$;

-- =====================================================================
-- Stage 1 — the engine the scope of work asks for.
--
-- Additions to tables that already exist on deployed databases are
-- written as ALTERs, guarded, so this file stays re-runnable against a
-- database that has every table already.
-- =====================================================================

-- ---------------------------------------------------------------------
-- departments — who heads each one, its HR business partner, its CXO.
--
-- The org roles an approval rule can name besides "line manager": the
-- HR clearance flow is Line Manager → Head of Department → HRBP → CXO,
-- "accommodating instances where layers may be the same person". An
-- employee's department is the text on their row, matched by name.
-- ---------------------------------------------------------------------
create table if not exists public.departments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant()
                     references public.tenants(id) on delete cascade,
  name             text not null,
  head_employee_id text,
  hrbp_employee_id text,
  cxo_employee_id  text,
  created_at       timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, name),
  foreign key (head_employee_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null (head_employee_id),
  foreign key (hrbp_employee_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null (hrbp_employee_id),
  foreign key (cxo_employee_id, tenant_id)
    references public.employees(employee_id, tenant_id) on delete set null (cxo_employee_id)
);

-- ---------------------------------------------------------------------
-- Phases, lanes, quorum, conditions.
--
-- A chain is phases run one after another (step_index). A phase runs one
-- or more lanes at the same time, and a lane is steps in order. The HR
-- clearance flow is the case that needs all three: the requester's own
-- division signs off Line Manager → HoD → HRBP → CXO while Finance,
-- Supply Chain, Administration and IT clear it alongside, and HR closes
-- it only after every one of them has.
--
-- On rules: rules sharing a step_index are one phase. Rules in a phase
-- that name the same lane are one lane, in `position` order; a rule
-- naming no lane is a lane of its own. position orders the whole phase,
-- so lanes are numbered in the order their first rule appears. quorum is how many lanes must
-- finish for the phase to be done — null means all; "any two of three
-- compliance accessors" is three single-person lanes with quorum 2.
-- condition makes a rule apply only when an answer says so:
-- {"field": "Approval route", "op": "eq", "value": "Exceptional"}.
-- stage_label names the phase on the timeline, lane names the lane.
--
-- Every chain built before this is one lane per phase, which is exactly
-- what it was: a sequence.
-- ---------------------------------------------------------------------
alter table public.approval_rules add column if not exists quorum      integer;
alter table public.approval_rules add column if not exists condition   jsonb;
alter table public.approval_rules add column if not exists stage_label text;
alter table public.approval_rules add column if not exists lane        text;
alter table public.approval_rules add column if not exists position    integer not null default 0;

alter table public.approval_requests add column if not exists lane        integer not null default 0;
alter table public.approval_requests add column if not exists lane_step   integer not null default 0;
alter table public.approval_requests add column if not exists lane_label  text;
alter table public.approval_requests add column if not exists quorum      integer;
alter table public.approval_requests add column if not exists stage_label text;

do $s1$
begin
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_position_key') then
    alter table public.approval_requests
      add constraint approval_requests_position_key
      unique (subject_id, step_index, lane, lane_step) deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_rules_quorum_positive') then
    alter table public.approval_rules
      add constraint approval_rules_quorum_positive check (quorum is null or quorum > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_quorum_positive') then
    alter table public.approval_requests
      add constraint approval_requests_quorum_positive check (quorum is null or quorum > 0);
  end if;
end $s1$;

-- ---------------------------------------------------------------------
-- Categories: the divisions in the scope of work. Compliance holds the
-- ABC declarations, Commercial the campaign requests.
-- ---------------------------------------------------------------------
alter table public.form_templates drop constraint if exists form_templates_category_check;
alter table public.form_templates
  add constraint form_templates_category_check
  check (category in ('Finance', 'HR', 'Admin', 'Compliance', 'Commercial', 'Legal'));

-- ---------------------------------------------------------------------
-- Follow-ups and linked submissions.
--
-- A template may name the template that follows it: the commercial flow
-- in the scope of work raises a secondary NFA automatically when the
-- first ticket is approved, preloaded with what the first one said.
-- parent_submission_id records where a submission came from.
-- ---------------------------------------------------------------------
alter table public.form_templates   add column if not exists followup_template_id uuid;
alter table public.form_submissions add column if not exists parent_submission_id uuid;

do $s1$
begin
  if not exists (select 1 from pg_constraint where conname = 'form_templates_followup_fk') then
    alter table public.form_templates
      add constraint form_templates_followup_fk
      foreign key (followup_template_id, tenant_id)
      references public.form_templates(id, tenant_id) on delete set null (followup_template_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'form_submissions_parent_fk') then
    alter table public.form_submissions
      add constraint form_submissions_parent_fk
      foreign key (parent_submission_id, tenant_id)
      references public.form_submissions(id, tenant_id) on delete set null (parent_submission_id);
  end if;
end $s1$;

-- ---------------------------------------------------------------------
-- approval_events — everything that happened to a chain, in order.
--
-- A step row holds only its latest state: returning a request to an
-- earlier approver puts their row back to pending, and a forward
-- overwrites who it is with. The history lives here, append-only like
-- activity_log, written by the engine functions and nothing else. It is
-- what the timeline reads when it shows that a step was approved,
-- returned and approved again.
-- ---------------------------------------------------------------------
create table if not exists public.approval_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant()
                 references public.tenants(id) on delete cascade,
  request_id   uuid,
  subject_type text not null,
  subject_id   uuid not null,
  actor_id     text,
  action       text not null,
  comment      text,
  target_id    text,
  created_at   timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (request_id, tenant_id)
    references public.approval_requests(id, tenant_id) on delete set null (request_id)
);
create index if not exists approval_events_subject_idx
  on public.approval_events(tenant_id, subject_id, created_at);

-- ---------------------------------------------------------------------
-- approval_queries — one approver asking another a question.
--
-- "An approver can ask question only to approvers in the NFA." Asking
-- does not pause the chain: it is a conversation beside it. Asking the
-- requester is a different thing, clarification, which does pause.
-- ---------------------------------------------------------------------
create table if not exists public.approval_queries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant()
                 references public.tenants(id) on delete cascade,
  subject_type text not null,
  subject_id   uuid not null,
  asked_by     text not null,
  asked_to     text not null,
  question     text not null check (length(trim(question)) > 0),
  answer       text,
  answered_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (asked_by, tenant_id)
    references public.employees(employee_id, tenant_id) on delete cascade,
  foreign key (asked_to, tenant_id)
    references public.employees(employee_id, tenant_id) on delete cascade
);
create index if not exists approval_queries_subject_idx
  on public.approval_queries(tenant_id, subject_id);
create index if not exists approval_queries_to_idx
  on public.approval_queries(tenant_id, asked_to) where answer is null;

commit;
