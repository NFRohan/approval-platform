-- =====================================================================
-- Identity suite — who is acting, and what they may do.
--
-- The session's employee decides who acts, whatever a caller claims.
-- Permissions come from active roles. Designing a workflow needs
-- forms.build, enforced by the policies themselves. Accounts and roles
-- are created by one person and approved by another. The HR master file
-- adds, updates and retires people.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

delete from public.tenants where slug = 'iden-t';
insert into public.tenants (name, slug, kind, expires_at) values ('Identity Tenant', 'iden-t', 'demo', now() + interval '1 day');
select set_config('t.i', (select id::text from public.tenants where slug = 'iden-t'), false);
insert into public.app_users (tenant_id, username, password_hash, full_name)
values (current_setting('t.i')::uuid, 'i.eval', 'x', 'I Evaluator');
select set_config('u.i', (select id::text from public.app_users where username = 'i.eval'), false);

insert into public.employees (tenant_id, employee_id, name, department) values
  (current_setting('t.i')::uuid, 'ADM',  'Admin',     'Admin'),
  (current_setting('t.i')::uuid, 'HRA',  'HR Admin',  'HR'),
  (current_setting('t.i')::uuid, 'DSN',  'Designer',  'Ops'),
  (current_setting('t.i')::uuid, 'SET',  'Settings',  'Ops'),
  (current_setting('t.i')::uuid, 'SEC',  'Security',  'Admin'),
  (current_setting('t.i')::uuid, 'NOB',  'Nobody',    'Ops'),
  (current_setting('t.i')::uuid, 'APR',  'Approver',  'Ops'),
  (current_setting('t.i')::uuid, 'OLD',  'Leaving',   'Ops');
insert into public.employees (tenant_id, employee_id, name, line_manager_id) values
  (current_setting('t.i')::uuid, 'RQ', 'Requester', 'APR');

insert into public.roles (tenant_id, name, permissions, status) values
  (current_setting('t.i')::uuid, 'sysadmin', array['forms.build','users.manage','roles.manage','org.manage'], 'active'),
  (current_setting('t.i')::uuid, 'hradmin',  array['users.manage','users.approve','org.manage'], 'active'),
  (current_setting('t.i')::uuid, 'designer', array['forms.build'], 'active'),
  (current_setting('t.i')::uuid, 'settings', array['forms.settings'], 'active'),
  (current_setting('t.i')::uuid, 'security', array['roles.approve'], 'active'),
  (current_setting('t.i')::uuid, 'dormant',  array['forms.build'], 'pending');
insert into public.employee_roles (tenant_id, employee_id, role_id)
select current_setting('t.i')::uuid, v.e, r.id
  from (values ('ADM','sysadmin'), ('HRA','hradmin'), ('DSN','designer'), ('SET','settings'),
               ('SEC','security'), ('NOB','dormant')) v(e, n)
  join public.roles r on r.name = v.n and r.tenant_id = current_setting('t.i')::uuid;

insert into public.form_templates (id, tenant_id, name, status) values
  ('e0000000-0000-4000-8000-000000000001', current_setting('t.i')::uuid, 'Form', 'published');
insert into public.approval_rules (id, tenant_id, form_template_id, approver_user_id, label, step_index, deadline_days) values
  ('e0000000-0000-4000-8000-0000000000a1', current_setting('t.i')::uuid, 'e0000000-0000-4000-8000-000000000001', 'APR', 'one', 0, 3);
insert into public.form_submissions (id, tenant_id, form_template_id, submitted_by, status) values
  ('e0000000-0000-4000-8000-0000000000b1', current_setting('t.i')::uuid, 'e0000000-0000-4000-8000-000000000001', 'RQ', 'submitted');

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL: % — got %, want %', label, got, want; end if;
  raise notice 'pass: %', label;
end $$;

-- Signed in, acting as an employee — as a session now is.
create or replace function pg_temp.as_emp(p_emp text) returns void language plpgsql as $$
begin
  perform set_config('app.tenant_id',   current_setting('t.i'), true),
          set_config('app.user_id',     current_setting('u.i'), true),
          set_config('app.role',        'admin', true),
          set_config('app.is_staff',    'false', true),
          set_config('app.employee_id', coalesce(p_emp, ''), true);
end $$;

create or replace function pg_temp.refused(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $$;

-- =====================================================================
-- 1. The session decides who acts
-- =====================================================================
do $$
declare v_id uuid;
begin
  set local role app_api;
  perform pg_temp.as_emp('APR');
  perform public.build_approval_chain('form_submission', 'e0000000-0000-4000-8000-0000000000b1', 'e0000000-0000-4000-8000-000000000001');
  select id into v_id from public.approval_requests where submission_id = 'e0000000-0000-4000-8000-0000000000b1';

  -- Signed in as NOB, claiming to be APR.
  perform pg_temp.as_emp('NOB');
  if not pg_temp.refused(format($q$select public.act_on_approval(%L, 'approve', null, 'APR')$q$, v_id)) then
    raise exception 'FAIL: a caller claiming to be the approver acted for them';
  end if;

  -- Signed in as APR, the claim does not matter.
  perform pg_temp.as_emp('APR');
  perform public.act_on_approval(v_id, 'approve', null, 'somebody else entirely');
  if (select status from public.approval_requests where id = v_id) <> 'approved' then
    raise exception 'FAIL: the session''s own approver could not act';
  end if;
  reset role;
  raise notice 'pass: who acts is the session''s employee, whatever the caller claims';
end $$;

-- =====================================================================
-- 2. Permissions come from active roles
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.as_emp('DSN');
  select pg_temp.check('a designer may design', app.has_permission('forms.build'), true);
  select pg_temp.check('...and may not manage accounts', app.has_permission('users.manage'), false);
  select pg_temp.as_emp('NOB');
  select pg_temp.check('a role still waiting for approval grants nothing', app.has_permission('forms.build'), false);
  select pg_temp.as_emp('APR');
  select pg_temp.check('somebody with no roles may not design', app.has_permission('forms.build'), false);
commit;

-- =====================================================================
-- 3. Designing a workflow needs forms.build — enforced by the policies
-- =====================================================================
do $$
begin
  set local role app_api;
  perform pg_temp.as_emp('APR');
  if not pg_temp.refused($q$insert into public.form_fields (form_template_id, field_type, field_name, order_index)
                            values ('e0000000-0000-4000-8000-000000000001', 'text', 'Sneaky', 9)$q$) then
    raise exception 'FAIL: somebody without forms.build added a field';
  end if;
  if (select count(*) from public.approval_rules where id = 'e0000000-0000-4000-8000-0000000000a1') = 1 then
    update public.approval_rules set approver_user_id = 'NOB' where id = 'e0000000-0000-4000-8000-0000000000a1';
  end if;
  if (select approver_user_id from public.approval_rules where id = 'e0000000-0000-4000-8000-0000000000a1') <> 'APR' then
    raise exception 'FAIL: somebody without forms.build rerouted a workflow';
  end if;

  perform pg_temp.as_emp('DSN');
  insert into public.form_fields (form_template_id, field_type, field_name, order_index)
  values ('e0000000-0000-4000-8000-000000000001', 'text', 'Purpose', 0);

  -- Task settings only: deadlines and signatures, through the function.
  perform pg_temp.as_emp('SET');
  perform public.update_rule_settings('e0000000-0000-4000-8000-0000000000a1', 5, true);
  if (select deadline_days || '/' || require_signature from public.approval_rules
       where id = 'e0000000-0000-4000-8000-0000000000a1') <> '5/true' then
    raise exception 'FAIL: task settings were not changed';
  end if;
  if not pg_temp.refused($q$insert into public.form_fields (form_template_id, field_type, field_name, order_index)
                            values ('e0000000-0000-4000-8000-000000000001', 'text', 'Also sneaky', 9)$q$) then
    raise exception 'FAIL: settings-only permission changed the form itself';
  end if;
  perform pg_temp.as_emp('APR');
  if not pg_temp.refused($q$select public.update_rule_settings('e0000000-0000-4000-8000-0000000000a1', 2, false)$q$) then
    raise exception 'FAIL: somebody with neither permission changed task settings';
  end if;
  reset role;
  raise notice 'pass: only forms.build designs a workflow; forms.settings changes its task settings and nothing else';
end $$;

-- =====================================================================
-- 4. Accounts: registered by one person, approved by another
-- =====================================================================
do $$
declare v_id uuid;
begin
  set local role app_api;
  perform pg_temp.as_emp('APR');
  if not pg_temp.refused($q$select public.create_account('RQ', 'rq.user', 'hash')$q$) then
    raise exception 'FAIL: somebody without users.manage registered an account';
  end if;

  perform pg_temp.as_emp('ADM');
  v_id := public.create_account('RQ', 'rq.user', 'hash');
  if (select approval_state from public.app_users where id = v_id) <> 'pending' then
    raise exception 'FAIL: a new account was usable before approval';
  end if;
  if not pg_temp.refused(format($q$select public.create_account('RQ', 'rq.again', 'hash')$q$)) then
    raise exception 'FAIL: one person got two accounts';
  end if;

  -- ADM registered it, and lacks users.approve anyway; HRA did not.
  perform pg_temp.as_emp('HRA');
  perform public.decide_account(v_id, true);
  if (select approval_state || '/' || approved_by_employee from public.app_users where id = v_id) <> 'approved/HRA' then
    raise exception 'FAIL: the approval was not recorded';
  end if;

  -- HRA registers one and cannot approve it herself.
  v_id := public.create_account('SEC', 'sec.user', 'hash');
  if not pg_temp.refused(format($q$select public.decide_account(%L, true)$q$, v_id)) then
    raise exception 'FAIL: whoever registered an account approved it';
  end if;

  -- A profile change waits, and is not approved by its proposer.
  perform pg_temp.as_emp('HRA');
  perform public.propose_profile(v_id, 'Security Officer', 'sec@example.com');
  if not pg_temp.refused(format($q$select public.decide_profile(%L, true)$q$, v_id)) then
    raise exception 'FAIL: a profile change was approved by whoever proposed it';
  end if;

  -- Nobody changes their own account's status; deactivated is final.
  perform pg_temp.as_emp('ADM');
  perform public.set_account_status(v_id, 'deactivated');
  if not pg_temp.refused(format($q$select public.set_account_status(%L, 'active')$q$, v_id)) then
    raise exception 'FAIL: a deactivated account was brought back';
  end if;
  reset role;
  raise notice 'pass: an account is registered by one person and approved by another, never by its own subject';
  raise notice 'pass: profile changes wait for somebody else; deactivation is permanent';
end $$;

-- =====================================================================
-- 5. Roles: created by one person, approved by another
-- =====================================================================
do $$
declare v_id uuid;
begin
  set local role app_api;
  perform pg_temp.as_emp('ADM');
  if not pg_temp.refused($q$select public.create_role('bogus', null, array['launch.missiles'])$q$) then
    raise exception 'FAIL: a role was given a permission that does not exist';
  end if;
  v_id := public.create_role('Report reader', 'Reads reports', array['reports.view']);
  if not pg_temp.refused(format($q$select public.assign_role('APR', %L, true)$q$, v_id)) then
    raise exception 'FAIL: a role was given out before it was approved';
  end if;

  perform pg_temp.as_emp('SEC');
  perform public.decide_role(v_id, true);
  perform pg_temp.as_emp('ADM');
  perform public.assign_role('APR', v_id, true);
  if not pg_temp.refused(format($q$select public.assign_role('ADM', %L, true)$q$,
         (select id from public.roles where name = 'security' and tenant_id = app.current_tenant()))) then
    raise exception 'FAIL: an administrator gave themselves the role that approves roles';
  end if;

  -- A change waits; the role keeps working as it was.
  perform public.propose_role_change(v_id, null, array['reports.view', 'forms.build']);
  perform pg_temp.as_emp('APR');
  if app.has_permission('forms.build') then
    raise exception 'FAIL: a proposed role change took effect before approval';
  end if;
  perform pg_temp.as_emp('ADM');
  if not pg_temp.refused(format($q$select public.decide_role(%L, true)$q$, v_id)) then
    raise exception 'FAIL: a role change was approved by whoever proposed it';
  end if;
  perform pg_temp.as_emp('SEC');
  perform public.decide_role(v_id, true);
  perform pg_temp.as_emp('APR');
  if not app.has_permission('forms.build') then
    raise exception 'FAIL: an approved role change did not take effect';
  end if;
  reset role;
  raise notice 'pass: roles are created and changed by one person and approved by another, and changes wait';
end $$;

-- =====================================================================
-- 6. The HR master file
-- =====================================================================
do $$
declare v jsonb;
begin
  set local role app_api;
  perform pg_temp.as_emp('APR');
  if not pg_temp.refused($q$select public.import_employees('[]'::jsonb)$q$) then
    raise exception 'FAIL: somebody without org.manage imported the HR file';
  end if;

  perform pg_temp.as_emp('HRA');
  v := public.import_employees($j$[
    {"employee_id": "NEW1", "name": "New Starter", "department": "Ops", "line_manager_id": "NEW2", "email": "New.Starter@Example.com"},
    {"employee_id": "NEW2", "name": "New Manager", "department": "Ops"},
    {"employee_id": "RQ",   "name": "Requester Renamed", "line_manager_id": "APR"},
    {"employee_id": "BAD",  "name": "Bad Manager", "line_manager_id": "NOPE"},
    {"employee_id": "ADM", "name": "Admin", "department": "Admin"},
    {"employee_id": "HRA", "name": "HR Admin", "department": "HR"},
    {"employee_id": "DSN", "name": "Designer", "department": "Ops"},
    {"employee_id": "SET", "name": "Settings", "department": "Ops"},
    {"employee_id": "SEC", "name": "Security", "department": "Admin"},
    {"employee_id": "NOB", "name": "Nobody", "department": "Ops"},
    {"employee_id": "APR", "name": "Approver", "department": "Ops"}
  ]$j$::jsonb, true);

  if (v->>'added')::int <> 3 then raise exception 'FAIL: % added, expected 3', v->>'added'; end if;
  if (select line_manager_id from public.employees where employee_id = 'NEW1' and tenant_id = app.current_tenant()) <> 'NEW2' then
    raise exception 'FAIL: a manager listed after their report was not set';
  end if;
  if (select email from public.employees where employee_id = 'NEW1' and tenant_id = app.current_tenant()) <> 'new.starter@example.com' then
    raise exception 'FAIL: the work address was not kept, in lower case';
  end if;
  if (select name from public.employees where employee_id = 'RQ' and tenant_id = app.current_tenant()) <> 'Requester Renamed' then
    raise exception 'FAIL: a changed name was not updated';
  end if;
  if not (v->'skipped')::text like '%BAD%' then
    raise exception 'FAIL: a row with an unknown manager was not reported';
  end if;
  if (select active from public.employees where employee_id = 'OLD' and tenant_id = app.current_tenant()) then
    raise exception 'FAIL: somebody missing from the file is still active';
  end if;
  -- A file without a department column leaves departments alone.
  perform public.import_employees('[{"employee_id": "DSN", "name": "Designer"}]'::jsonb, false);
  if (select department from public.employees where employee_id = 'DSN' and tenant_id = app.current_tenant()) is distinct from 'Ops' then
    raise exception 'FAIL: a file without a department column cleared somebody''s department';
  end if;
  reset role;
  raise notice 'pass: the HR file adds, updates, sets managers in any order, reports what it skipped and retires who is missing';
end $$;

-- =====================================================================
-- 7. Handing over a leaver's work needs org.manage
-- =====================================================================
do $$
begin
  set local role app_api;
  perform pg_temp.as_emp('APR');
  if not pg_temp.refused($q$select public.hand_over('DSN', 'APR', null)$q$) then
    raise exception 'FAIL: somebody without org.manage handed a colleague''s work away';
  end if;
  reset role;
  raise notice 'pass: handing over a leaver''s work needs org.manage';
end $$;

-- =====================================================================
-- 8. A new row names whoever the session says, not the browser
-- =====================================================================
do $$
declare v_by text;
begin
  set local role app_api;
  perform pg_temp.as_emp('NOB');
  insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status)
  values (app.current_tenant(), 'e0000000-0000-4000-8000-000000000001', 'APR', 'submitted')
  returning submitted_by into v_by;
  if v_by <> 'NOB' then raise exception 'FAIL: a request was raised in somebody else''s name (%)', v_by; end if;

  insert into public.activity_log (action, entity_type, entity_id, actor_id, detail)
  values ('approved', 'form_submission', gen_random_uuid(), 'APR', 'forged')
  returning actor_id into v_by;
  if v_by <> 'NOB' then raise exception 'FAIL: an audit entry was written in somebody else''s name'; end if;

  -- The org chart is the HR file's, or org.manage's.
  update public.employees set line_manager_id = 'NOB' where employee_id = 'RQ' and tenant_id = app.current_tenant();
  if (select line_manager_id from public.employees where employee_id = 'RQ' and tenant_id = app.current_tenant()) = 'NOB' then
    raise exception 'FAIL: somebody without org.manage changed who manages whom';
  end if;
  reset role;
  raise notice 'pass: a new request or audit entry names the session''s employee, whatever the browser sent';
  raise notice 'pass: the org chart changes only with org.manage';
end $$;

-- =====================================================================
-- 9. Two-step sign-in, where the organisation requires it for admins
-- =====================================================================
do $$
begin
  update public.tenants set require_admin_mfa = true where id = current_setting('t.i')::uuid;
  set local role app_api;
  perform pg_temp.as_emp('ADM');
  perform set_config('app.mfa', 'false', true);
  if app.has_permission('users.manage') then
    raise exception 'FAIL: an administrator administered without two-step sign-in where it is required';
  end if;
  if not app.has_permission('forms.build') then
    raise exception 'FAIL: the two-step rule took away a permission that does not administer anybody';
  end if;
  perform set_config('app.mfa', 'true', true);
  if not app.has_permission('users.manage') then
    raise exception 'FAIL: two-step sign-in did not restore the administrator''s permission';
  end if;
  reset role;
  update public.tenants set require_admin_mfa = false where id = current_setting('t.i')::uuid;
  raise notice 'pass: where required, administering needs a session that passed two-step sign-in';
end $$;

-- =====================================================================
-- 10. A disabled account's sessions end at once; directory accounts
-- =====================================================================
do $$
declare v_id uuid;
begin
  set local role app_api;
  perform pg_temp.as_emp('ADM');
  v_id := public.create_account('APR', 'apr.dir', null);
  if (select auth_source || '/' || must_change_pw from public.app_users where id = v_id) <> 'ldap/false' then
    raise exception 'FAIL: an account with no password was not left to the directory';
  end if;
  perform pg_temp.as_emp('HRA');
  perform public.decide_account(v_id, true);

  -- That account, signed in.
  perform set_config('app.user_id', v_id::text, true);
  perform app.assert_account_live();
  perform set_config('app.user_id', current_setting('u.i'), true);

  perform pg_temp.as_emp('ADM');
  perform public.set_account_status(v_id, 'disabled');
  perform set_config('app.user_id', v_id::text, true);
  if not pg_temp.refused('select app.assert_account_live()') then
    raise exception 'FAIL: a disabled account''s session still worked';
  end if;

  perform pg_temp.as_emp('APR');
  if not pg_temp.refused('select * from public.list_accounts()') then
    raise exception 'FAIL: somebody without users.manage listed the accounts';
  end if;
  perform pg_temp.as_emp('ADM');
  if (select count(*) from public.list_accounts()) < 3 then
    raise exception 'FAIL: the administrator could not list the accounts';
  end if;
  reset role;
  raise notice 'pass: disabling an account ends its sessions; a directory account has no password here';
end $$;

-- =====================================================================
-- 11. A form for some departments is raised only by them
-- =====================================================================
do $$
begin
  update public.form_templates set audience_departments = array['HR']
   where id = 'e0000000-0000-4000-8000-000000000001';
  set local role app_api;
  perform pg_temp.as_emp('NOB');   -- Ops, no active role
  if not pg_temp.refused($q$insert into public.form_submissions (form_template_id, status)
                            values ('e0000000-0000-4000-8000-000000000001', 'submitted')$q$) then
    raise exception 'FAIL: somebody outside a form''s audience raised it';
  end if;
  perform pg_temp.as_emp('HRA');   -- HR
  insert into public.form_submissions (form_template_id, status)
  values ('e0000000-0000-4000-8000-000000000001', 'submitted');
  perform pg_temp.as_emp('DSN');   -- Ops, but designs workflows
  if not app.in_audience('e0000000-0000-4000-8000-000000000001') then
    raise exception 'FAIL: a workflow designer could not see a form they may be designing';
  end if;
  reset role;
  raise notice 'pass: a form for some departments is raised only by them';
end $$;

delete from public.tenants where slug = 'iden-t';

do $$ begin raise notice 'ALL IDENTITY TESTS PASSED'; end $$;
