-- =====================================================================
-- Do the policies actually restrict anything?
--
-- The point of this suite is that the previous build had row level
-- security switched on for all 21 tables and every policy written as
-- `USING (true)`. Enabled-but-permissive reads as protection, so nothing
-- short of behaviour is worth believing.
--
-- IMPORTANT: every check runs after `set local role app_api`.
--
-- The role that owns these tables carries BYPASSRLS on Neon, so it is
-- exempt from policies whatever FORCE says. That is what lets the seed
-- file write across tenants, and it is also why testing as the owner
-- would prove nothing at all. What makes the application safe is that it
-- drops to app_api for the life of every transaction, and app_api has no
-- such exemption. This suite does the same.
--
-- Run against a database with 001 and 002 applied.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- fixtures, written as the owner
-- ---------------------------------------------------------------------
delete from public.tenants where slug in ('rls-a','rls-b');

insert into public.tenants (name, slug, kind, expires_at)
values ('Tenant A', 'rls-a', 'demo', now() + interval '1 day');
insert into public.tenants (name, slug, kind, expires_at)
values ('Tenant B', 'rls-b', 'demo', now() + interval '1 day');

select set_config('t.a', (select id::text from public.tenants where slug='rls-a'), false);
select set_config('t.b', (select id::text from public.tenants where slug='rls-b'), false);

insert into public.app_users (tenant_id, username, password_hash, full_name)
values (current_setting('t.a')::uuid, 'a.eval', 'x', 'A Evaluator');
insert into public.app_users (tenant_id, username, password_hash, full_name)
values (current_setting('t.b')::uuid, 'b.eval', 'x', 'B Evaluator');

select set_config('u.a', (select id::text from public.app_users where username='a.eval'), false);
select set_config('u.b', (select id::text from public.app_users where username='b.eval'), false);

insert into public.employees (tenant_id, employee_id, name)
values (current_setting('t.a')::uuid, 'EMP-0001', 'Person A'),
       (current_setting('t.b')::uuid, 'EMP-0001', 'Person B');

insert into public.form_templates (tenant_id, name, status)
values (current_setting('t.a')::uuid, 'A Form', 'published'),
       (current_setting('t.b')::uuid, 'B Form', 'published');

insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id)
values (current_setting('t.a')::uuid, 'EMP-0001', 'created', 'form_template', gen_random_uuid());

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % — got %, want %', label, got, want;
  end if;
  raise notice 'pass: %', label;
end $$;

-- =====================================================================
-- 1. A signed-in member sees its own tenant, and only that
-- =====================================================================
begin;
  set local role app_api;
  select set_config('app.tenant_id', current_setting('t.a'), true),
         set_config('app.user_id',   current_setting('u.a'), true),
         set_config('app.role',      'admin', true),
         set_config('app.is_staff',  'false', true);

  select pg_temp.check('a member sees its own form templates',
                       (select count(*)::int from public.form_templates), 1);
  select pg_temp.check('a member sees its own employees',
                       (select count(*)::int from public.employees), 1);
  select pg_temp.check('...and the name is its own',
                       (select name from public.employees limit 1), 'Person A'::text);
  select pg_temp.check('a member sees its own tenant row',
                       (select count(*)::int from public.tenants), 1);
commit;

-- =====================================================================
-- 2. Tenant B sees none of A
-- =====================================================================
begin;
  set local role app_api;
  select set_config('app.tenant_id', current_setting('t.b'), true),
         set_config('app.user_id',   current_setting('u.b'), true),
         set_config('app.role',      'admin', true),
         set_config('app.is_staff',  'false', true);

  select pg_temp.check('B sees only its own template',
                       (select name from public.form_templates limit 1), 'B Form'::text);
  select pg_temp.check('B sees none of A''s activity',
                       (select count(*)::int from public.activity_log), 0);
commit;

-- =====================================================================
-- 3. No context reads nothing. This is the case `USING (true)` failed.
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.check('no context sees no templates',
                       (select count(*)::int from public.form_templates), 0);
  select pg_temp.check('no context sees no employees',
                       (select count(*)::int from public.employees), 0);
  select pg_temp.check('no context sees no tenants',
                       (select count(*)::int from public.tenants), 0);
commit;

-- =====================================================================
-- 4. A tenant named without a signed-in user reads nothing either.
--    Naming a tenant is not the same as being in it.
-- =====================================================================
begin;
  set local role app_api;
  select set_config('app.tenant_id', current_setting('t.a'), true),
         set_config('app.user_id',   '', true),
         set_config('app.role',      'anon', true),
         set_config('app.is_staff',  'false', true);

  select pg_temp.check('a tenant with no user sees no templates',
                       (select count(*)::int from public.form_templates), 0);
  select pg_temp.check('a tenant with no user sees no employees',
                       (select count(*)::int from public.employees), 0);
commit;

-- =====================================================================
-- 5. Staff manage tenants and accounts, and cannot read prospect data.
--    The console shows the shape of an evaluation, never its contents.
-- =====================================================================
begin;
  set local role app_api;
  select set_config('app.tenant_id', '', true),
         set_config('app.user_id',   '', true),
         set_config('app.role',      'admin', true),
         set_config('app.is_staff',  'true', true);

  -- Scoped to this suite's fixtures: a seeded database also holds the
  -- template, and any evaluation minted by another suite.
  select pg_temp.check('staff see both tenants under test',
                       (select count(*)::int from public.tenants where slug like 'rls-%'), 2);
  select pg_temp.check('staff see the accounts they issued',
                       (select count(*)::int from public.app_users
                         where username in ('a.eval','b.eval')), 2);
  select pg_temp.check('staff see NO prospect form templates',
                       (select count(*)::int from public.form_templates), 0);
  select pg_temp.check('staff see NO prospect submissions',
                       (select count(*)::int from public.form_submissions), 0);
commit;

-- =====================================================================
-- 6. A member cannot write into another tenant, even naming it directly
-- =====================================================================
do $$
declare ok boolean := false;
begin
  begin
    set local role app_api;
    perform set_config('app.tenant_id', current_setting('t.a'), true),
            set_config('app.user_id',   current_setting('u.a'), true),
            set_config('app.role',      'admin', true),
            set_config('app.is_staff',  'false', true);
    insert into public.employees (tenant_id, employee_id, name)
    values (current_setting('t.b')::uuid, 'EMP-9999', 'Smuggled');
  exception when insufficient_privilege or check_violation then ok := true;
  end;
  reset role;
  if not ok then raise exception 'FAIL: a member wrote into another tenant'; end if;
  raise notice 'pass: a member cannot write into another tenant';
end $$;

-- =====================================================================
-- 7. The activity trail is append-only
-- =====================================================================
do $$
declare n int;
begin
  set local role app_api;
  perform set_config('app.tenant_id', current_setting('t.a'), true),
          set_config('app.user_id',   current_setting('u.a'), true),
          set_config('app.role',      'admin', true),
          set_config('app.is_staff',  'false', true);

  insert into public.activity_log (actor_id, action, entity_type, entity_id)
  values ('EMP-0001', 'approved', 'form_submission', gen_random_uuid());

  update public.activity_log set detail = 'rewritten';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: % activity rows were rewritten', n; end if;

  delete from public.activity_log;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: % activity rows were deleted', n; end if;

  reset role;
  raise notice 'pass: activity can be added and read, never altered or removed';
end $$;

delete from public.tenants where slug in ('rls-a','rls-b');

do $$ begin raise notice 'ALL RLS TESTS PASSED'; end $$;
