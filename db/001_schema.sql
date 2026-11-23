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

-- =====================================================================
-- Stage 2 — the ticket.
--
-- What a request carries besides its route: a reference a person can
-- say aloud, a priority, people copied on it, notes, links to other
-- requests, documents with descriptions, tags and versions, and a
-- signature where a step asks for one.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Reference numbers: AMS-2026-00042.
--
-- The reference used to be the head of the uuid, which nobody can read
-- out over the phone and nobody can guess the order of. Audit and
-- compliance ask for records by reference number, so each tenant counts
-- its own, by the year the request was raised in Dhaka.
-- ---------------------------------------------------------------------
create table if not exists public.tenant_counters (
  tenant_id uuid not null default app.current_tenant()
              references public.tenants(id) on delete cascade,
  name      text not null,
  value     bigint not null default 0,
  primary key (tenant_id, name)
);

create or replace function app.next_counter(p_tenant uuid, p_name text)
returns bigint
language sql
security invoker
set search_path = public, pg_temp
as $$
  insert into public.tenant_counters as c (tenant_id, name, value)
  values (p_tenant, p_name, 1)
  on conflict (tenant_id, name) do update set value = c.value + 1
  returning value
$$;

alter table public.form_submissions add column if not exists ref_number text;
alter table public.form_submissions add column if not exists priority   text not null default 'normal';
-- Set when the route includes a rule that asks to be seen — the
-- exceptional CXO approval — so notifications, queues and reports can
-- say so.
alter table public.form_submissions add column if not exists flag       text;

do $s2$
begin
  if not exists (select 1 from pg_constraint where conname = 'form_submissions_priority_check') then
    alter table public.form_submissions
      add constraint form_submissions_priority_check check (priority in ('normal', 'high', 'urgent'));
  end if;
end $s2$;
create unique index if not exists form_submissions_ref_idx
  on public.form_submissions(tenant_id, ref_number) where ref_number is not null;

create or replace function app.assign_ref_number()
returns trigger
language plpgsql
as $$
begin
  if new.ref_number is null then
    new.ref_number := 'AMS-'
      || to_char(coalesce(new.submitted_at, now()) at time zone 'Asia/Dhaka', 'YYYY') || '-'
      || lpad(app.next_counter(new.tenant_id, 'submission')::text, 5, '0');
  end if;
  return new;
end $$;

drop trigger if exists form_submissions_ref on public.form_submissions;
create trigger form_submissions_ref before insert on public.form_submissions
  for each row execute function app.assign_ref_number();

-- Requests raised before references existed get theirs, oldest first.
do $s2$
declare r record;
begin
  for r in
    select id, tenant_id, submitted_at from public.form_submissions
     where ref_number is null order by tenant_id, submitted_at, id
  loop
    update public.form_submissions
       set ref_number = 'AMS-' || to_char(r.submitted_at at time zone 'Asia/Dhaka', 'YYYY') || '-'
                        || lpad(app.next_counter(r.tenant_id, 'submission')::text, 5, '0')
     where id = r.id;
  end loop;
end $s2$;

-- ---------------------------------------------------------------------
-- Linked requests: "a ticket should have option to link other tickets".
-- Stored once, in either direction.
-- ---------------------------------------------------------------------
create table if not exists public.submission_links (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default app.current_tenant()
               references public.tenants(id) on delete cascade,
  from_id    uuid not null,
  to_id      uuid not null,
  note       text,
  created_by text,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, from_id, to_id),
  check (from_id <> to_id),
  foreign key (from_id, tenant_id) references public.form_submissions(id, tenant_id) on delete cascade,
  foreign key (to_id, tenant_id)   references public.form_submissions(id, tenant_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- People copied on a request by whoever raised it. They are told when it
-- is raised and when it finishes, and see it among the requests copied
-- to them — the ad-hoc report CC the scope of work says people in CC
-- currently cannot get at.
-- ---------------------------------------------------------------------
create table if not exists public.submission_cc (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant()
                  references public.tenants(id) on delete cascade,
  submission_id uuid not null,
  employee_id   text not null,
  added_by      text,
  created_at    timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, submission_id, employee_id),
  foreign key (submission_id, tenant_id) references public.form_submissions(id, tenant_id) on delete cascade,
  foreign key (employee_id, tenant_id)   references public.employees(employee_id, tenant_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Notes on a request, from anybody on it, at any time — including after
-- it is approved. Append-only, like the rest of the trail.
-- ---------------------------------------------------------------------
create table if not exists public.ticket_notes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant()
                  references public.tenants(id) on delete cascade,
  submission_id uuid not null,
  author_id     text not null,
  body          text not null check (length(trim(body)) > 0),
  created_at    timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (submission_id, tenant_id) references public.form_submissions(id, tenant_id) on delete cascade
);
create index if not exists ticket_notes_submission_idx on public.ticket_notes(tenant_id, submission_id, created_at);

-- ---------------------------------------------------------------------
-- Documents: what each one is, tags to find it by, and every version.
--
-- Attaching again used to replace the file. Supporting documents are
-- revised after submission — "further claim adjustment" — and the
-- earlier one is evidence too, so a new file is a new version and the
-- old one is kept, marked superseded.
-- ---------------------------------------------------------------------
alter table public.attachments add column if not exists description   text;
alter table public.attachments add column if not exists tags          text[] not null default '{}';
alter table public.attachments add column if not exists version       integer not null default 1;
alter table public.attachments add column if not exists superseded_at timestamptz;
create index if not exists attachments_tags_idx on public.attachments using gin (tags);

-- Who opened which document, for audit. Append-only.
create table if not exists public.attachment_access (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant()
                  references public.tenants(id) on delete cascade,
  attachment_id uuid not null,
  actor_id      text,
  accessed_at   timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (attachment_id, tenant_id) references public.attachments(id, tenant_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- A signature where a step asks for one, and a flag a rule can raise.
-- ---------------------------------------------------------------------
alter table public.approval_rules    add column if not exists require_signature boolean not null default false;
alter table public.approval_rules    add column if not exists flag              text;
alter table public.approval_requests add column if not exists require_signature boolean not null default false;
alter table public.approval_requests add column if not exists signature         text;
alter table public.approval_requests add column if not exists signed_at         timestamptz;

-- ---------------------------------------------------------------------
-- Leavers. An employee who has left keeps their row, because the trail
-- names them, but is no longer active.
-- ---------------------------------------------------------------------
alter table public.employees add column if not exists active  boolean not null default true;
alter table public.employees add column if not exists left_on date;

-- =====================================================================
-- Stage 3 — who somebody is, and what they may do.
--
-- Until now one login stood for a whole evaluation and the browser said
-- which employee it was acting as. Now a session names an employee: a
-- person's own account is linked to theirs, and an evaluation's login
-- acts as one persona at a time, switched on the server and audited.
-- What an employee may do comes from the roles they hold; creating or
-- changing an account or a role is approved by somebody else.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tenant settings.
--   persona_switching   an evaluation's login may act as any employee;
--                       an organisation's people sign in as themselves
--   require_admin_mfa   anybody holding an administrative permission
--                       must set up two-step sign-in
--   default_persona     who an evaluation's login acts as at first
-- ---------------------------------------------------------------------
alter table public.tenants add column if not exists persona_switching boolean not null default true;
alter table public.tenants add column if not exists require_admin_mfa boolean not null default false;
alter table public.tenants add column if not exists default_persona   text;

-- ---------------------------------------------------------------------
-- Accounts.
--
-- employee_id links an account to the person it belongs to; an
-- evaluation's own login has none and acts as personas instead.
-- The password policy needs a history, a count of failures and a lock;
-- two-step sign-in needs a secret; maker-checker needs to know who
-- asked for an account and who approved it, and to hold a profile change
-- until it is approved.
-- ---------------------------------------------------------------------
alter table public.app_users add column if not exists employee_id          text;
alter table public.app_users add column if not exists failed_attempts      integer not null default 0;
alter table public.app_users add column if not exists locked_at            timestamptz;
alter table public.app_users add column if not exists password_history     text[] not null default '{}';
alter table public.app_users add column if not exists mfa_secret           text;
alter table public.app_users add column if not exists mfa_enabled          boolean not null default false;
alter table public.app_users add column if not exists auth_source          text not null default 'local';
alter table public.app_users add column if not exists approval_state       text not null default 'approved';
alter table public.app_users add column if not exists pending_profile      jsonb;
alter table public.app_users add column if not exists created_by_employee  text;
alter table public.app_users add column if not exists approved_by_employee text;
alter table public.app_users add column if not exists deactivated_at       timestamptz;
-- The last time-step a two-step code was accepted for, so a code cannot
-- be used twice inside its window.
alter table public.app_users add column if not exists mfa_last_step        bigint;

do $s3$
begin
  -- Deactivated is permanent; disabled can be undone.
  alter table public.app_users drop constraint if exists app_users_status_check;
  alter table public.app_users
    add constraint app_users_status_check check (status in ('active', 'disabled', 'deactivated'));

  if not exists (select 1 from pg_constraint where conname = 'app_users_auth_source_check') then
    alter table public.app_users
      add constraint app_users_auth_source_check check (auth_source in ('local', 'ldap'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_users_approval_state_check') then
    alter table public.app_users
      add constraint app_users_approval_state_check check (approval_state in ('pending', 'approved', 'rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_users_employee_fk') then
    alter table public.app_users
      add constraint app_users_employee_fk foreign key (employee_id, tenant_id)
      references public.employees(employee_id, tenant_id) on delete set null (employee_id);
  end if;
end $s3$;

-- One account per person.
create unique index if not exists app_users_employee_idx
  on public.app_users(tenant_id, employee_id) where employee_id is not null;

-- ---------------------------------------------------------------------
-- Roles: named sets of permissions, held by employees.
--
-- A new role is pending until somebody other than its author approves
-- it; a change to an active role waits in pending_* while the role keeps
-- working as it was.
-- ---------------------------------------------------------------------
create table if not exists public.roles (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant()
                        references public.tenants(id) on delete cascade,
  name                text not null,
  description         text,
  permissions         text[] not null default '{}',
  status              text not null default 'pending' check (status in ('pending', 'active', 'rejected')),
  pending_name        text,
  pending_permissions text[],
  created_by          text,
  changed_by          text,
  approved_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, name)
);

create table if not exists public.employee_roles (
  tenant_id   uuid not null default app.current_tenant()
                references public.tenants(id) on delete cascade,
  employee_id text not null,
  role_id     uuid not null,
  assigned_by text,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, employee_id, role_id),
  foreign key (employee_id, tenant_id) references public.employees(employee_id, tenant_id) on delete cascade,
  foreign key (role_id, tenant_id)     references public.roles(id, tenant_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Who a form is for. "NFA or Memo report or template should be visible
-- as per the role of the user and his/her's division." Null is everyone.
-- ---------------------------------------------------------------------
alter table public.form_templates add column if not exists audience_departments text[];

-- ---------------------------------------------------------------------
-- People syncs — from the HR file, the directory, or the daily schedule.
-- ---------------------------------------------------------------------
create table if not exists public.directory_syncs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default app.current_tenant()
               references public.tenants(id) on delete cascade,
  source     text not null check (source in ('ldap', 'csv', 'scheduled')),
  result     jsonb,
  error      text,
  run_by     text,
  created_at timestamptz not null default now()
);
create index if not exists directory_syncs_tenant_idx on public.directory_syncs(tenant_id, created_at desc);

-- An employee's work address, from the HR master file.
alter table public.employees add column if not exists email text;


-- =====================================================================
-- Stage 4 — reports, analytics and email.
--
-- Every notification can also go out as an email, written from a
-- template the organisation can change, and every email is kept with
-- what happened to it. Reports are templates of columns and filters over
-- the requests and their approval steps; admins keep them, others ask
-- for changes, and any of them can be sent out on a schedule.
-- =====================================================================

-- When a step became somebody's turn. Response times and the SLA are
-- measured from here; deadline_at alone cannot say how long anybody had.
alter table public.approval_requests add column if not exists opened_at timestamptz;

-- ---------------------------------------------------------------------
-- Email templates: the organisation's own wording for each kind of
-- notification. A kind with no row uses the built-in wording; a row
-- with enabled = false sends no email for that kind at all.
-- ---------------------------------------------------------------------
create table if not exists public.email_templates (
  tenant_id  uuid not null default app.current_tenant()
               references public.tenants(id) on delete cascade,
  kind       text not null,
  subject    text,
  body       text,
  enabled    boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, kind)
);

-- ---------------------------------------------------------------------
-- The outbox, which is also the delivery log.
--
--   queued    written, not yet handed to a mail server
--   sent      the mail server accepted it
--   captured  no mail server is configured; kept here, as it would
--             have been sent, so it can be read
--   failed    the mail server refused it, or could not be reached
--   skipped   nothing to send it to
-- ---------------------------------------------------------------------
create table if not exists public.email_outbox (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant()
                     references public.tenants(id) on delete cascade,
  notification_id  uuid,
  report_id        uuid,
  kind             text not null,
  recipient_id     text,
  to_address       text,
  context          jsonb not null default '{}',
  entity_type      text,
  entity_id        uuid,
  subject          text,
  body_text        text,
  body_html        text,
  attachment_names text[] not null default '{}',
  status           text not null default 'queued'
                     check (status in ('queued', 'sending', 'sent', 'captured', 'failed', 'skipped')),
  attempts         integer not null default 0,
  error            text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (id, tenant_id)
);
create index if not exists email_outbox_tenant_idx on public.email_outbox(tenant_id, created_at desc);
create index if not exists email_outbox_queued_idx on public.email_outbox(created_at) where status = 'queued';

-- ---------------------------------------------------------------------
-- Report templates.
--
-- A dataset (requests, approval steps, or approvers' performance), the
-- columns to show in order, and the filters it starts with. Admins
-- (reports.manage) create and change them; anybody who reads reports can
-- ask for different columns, which waits in pending_columns until an
-- admin other than the asker approves it. A schedule sends the report,
-- as a file, to the people listed.
-- ---------------------------------------------------------------------
create table if not exists public.report_templates (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant()
                        references public.tenants(id) on delete cascade,
  name                text not null,
  description         text,
  dataset             text not null check (dataset in ('requests', 'steps', 'approvers')),
  columns             text[] not null,
  filters             jsonb not null default '{}',
  standard            boolean not null default false,
  pending_columns     text[],
  change_note         text,
  change_requested_by text,
  schedule            text not null default 'none' check (schedule in ('none', 'weekly', 'monthly')),
  recipients          text[] not null default '{}',
  format              text not null default 'xlsx' check (format in ('xlsx', 'pdf', 'csv')),
  last_sent_at        timestamptz,
  created_by          text,
  updated_by          text,
  approved_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, name)
);

-- A demonstration needs months of history for its charts to say
-- anything; this marks a tenant that has had it generated.
alter table public.tenants add column if not exists history_seeded boolean not null default false;

commit;
