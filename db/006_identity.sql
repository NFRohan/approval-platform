-- =====================================================================
-- Who is acting, and what they may do.
--
-- A session names an employee (set per transaction as app.employee_id,
-- see src/server/db.ts). Every chain function used to take the actor
-- from its caller, which was the browser; app.acting() now takes it from
-- the session whenever there is one, so the actor checks written in
-- earlier stages become access control rather than a courtesy.
--
-- Permissions come from roles an employee holds. Accounts and roles are
-- managed through the functions here, which check permission and, for
-- creating or changing either, that the person approving is not the
-- person who asked.
--
-- SECURITY DEFINER throughout the management functions: app_users and
-- roles are not writable by members at all, so these are the only way
-- in, and every statement in them names the tenant explicitly.
--
-- Re-runnable.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Who the session says is acting.
-- ---------------------------------------------------------------------
create or replace function app.current_employee()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.employee_id', true), '')
$$;

-- The actor a function acts as: the session's employee when there is
-- one. What the caller passed is used only when there is no session
-- employee at all — scripts, the seed, the test suites.
create or replace function app.acting(p_actor text)
returns text
language sql
stable
as $$
  select coalesce(app.current_employee(), p_actor)
$$;

-- ---------------------------------------------------------------------
-- Permissions.
-- ---------------------------------------------------------------------
create or replace function app.permission_catalogue()
returns text[]
language sql
immutable
as $$
  select array[
    'forms.build',      -- design workflows: fields, approvers, stages
    'forms.settings',   -- change a workflow's task settings only
    'users.manage',     -- register, update, deactivate, unlock, reset
    'users.approve',    -- approve accounts and profile changes
    'roles.manage',     -- create and change roles
    'roles.approve',    -- approve roles and role changes
    'org.manage',       -- departments, HR import, leavers
    'audit.view',       -- the audit trails
    'reports.view',     -- reports and analytics
    'reports.manage',   -- create and change report templates; approve column changes
    'notifications.manage' -- email wording, and the delivery log
  ]
$$;

-- The permissions that administer people rather than work.
create or replace function app.admin_permissions()
returns text[]
language sql
immutable
as $$
  select array['users.manage', 'users.approve', 'roles.manage', 'roles.approve', 'org.manage']
$$;

-- Does whoever is acting hold this permission?
--
-- With an employee in the session, only that employee's active roles
-- count — an evaluation's login acting as Tom has Tom's permissions, which
-- is what lets a demonstration show the difference. Without one (the
-- seed, scripts, the test suites) a tenant admin holds them all, as
-- before roles existed.
create or replace function app.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select case
    when app.current_employee() is null then
      app.is_staff() or coalesce(current_setting('app.role', true), '') = 'admin'
    -- Where the organisation requires it, administering accounts, roles
    -- or the org chart needs a session that passed two-step sign-in.
    -- The server says so in app.mfa; holding the role is not enough.
    when p_permission = any (app.admin_permissions())
     and coalesce(current_setting('app.mfa', true), '') <> 'true'
     and exists (select 1 from public.tenants t
                  where t.id = app.current_tenant() and t.require_admin_mfa) then
      false
    else exists (
      select 1
        from public.employee_roles er
        join public.roles r on r.id = er.role_id and r.tenant_id = er.tenant_id
       where er.tenant_id = app.current_tenant()
         and er.employee_id = app.current_employee()
         and r.status = 'active'
         and p_permission = any (r.permissions))
  end
$$;

create or replace function app.require_permission(p_permission text)
returns void
language plpgsql
stable
as $$
begin
  if not app.has_permission(p_permission) then
    raise exception 'you need the % permission for that', p_permission;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Policies.
--
-- Roles and who holds them are read by members and written only through
-- the functions below. Designing a workflow needs forms.build; the
-- org chart's departments need org.manage. Everything else keeps the
-- member rule from 002.
-- ---------------------------------------------------------------------
do $id$
declare t text;
begin
  foreach t in array array['roles', 'employee_roles'] loop
    execute format('drop policy if exists %1$s_member_read on public.%1$I', t);
    execute format($f$
      create policy %1$s_member_read on public.%1$I
        for select to app_api
        using (tenant_id = app.current_tenant() and app.is_member())
    $f$, t);
  end loop;

  foreach t in array array['form_templates', 'form_fields', 'approval_rules',
                           'approval_slabs', 'notification_rules'] loop
    execute format('drop policy if exists %1$s_member_write on public.%1$I', t);
    execute format('drop policy if exists %1$s_builder_write on public.%1$I', t);
    execute format($f$
      create policy %1$s_builder_write on public.%1$I
        for all to app_api
        using (tenant_id = app.current_tenant() and app.is_member() and app.has_permission('forms.build'))
        with check (tenant_id = app.current_tenant() and app.is_member() and app.has_permission('forms.build'))
    $f$, t);
  end loop;

  -- The org chart itself: people, their managers and departments come
  -- from the HR file or the directory, and change only with org.manage.
  execute 'drop policy if exists employees_member_write on public.employees';
  execute 'drop policy if exists employees_org_write on public.employees';
  execute $f$
    create policy employees_org_write on public.employees
      for all to app_api
      using (tenant_id = app.current_tenant() and app.is_member() and app.has_permission('org.manage'))
      with check (tenant_id = app.current_tenant() and app.is_member() and app.has_permission('org.manage'))
  $f$;

  execute 'drop policy if exists departments_member_write on public.departments';
  execute 'drop policy if exists departments_org_write on public.departments';
  execute $f$
    create policy departments_org_write on public.departments
      for all to app_api
      using (tenant_id = app.current_tenant() and app.is_member() and app.has_permission('org.manage'))
      with check (tenant_id = app.current_tenant() and app.is_member() and app.has_permission('org.manage'))
  $f$;
end $id$;

-- Something administrative happened. Into the tenant's own trail.
create or replace function app.audit(p_action text, p_entity_type text, p_entity_id uuid, p_detail text)
returns void
language sql
security definer
set search_path = public, app, pg_temp
as $$
  insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  -- Something about the organisation as a whole names the tenant itself.
  values (app.current_tenant(), app.current_employee(), p_action, p_entity_type,
          coalesce(p_entity_id, app.current_tenant()), p_detail)
$$;

-- ---------------------------------------------------------------------
-- Accounts.
-- ---------------------------------------------------------------------

-- The account, in this tenant, or an error.
create or replace function app.account(p_user uuid)
returns public.app_users
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare v public.app_users;
begin
  select * into v from public.app_users where id = p_user and tenant_id = app.current_tenant();
  if not found then
    raise exception 'there is no such account here';
  end if;
  return v;
end $$;

-- Register an account for an employee. It cannot be used until somebody
-- else approves it. The password arrives hashed: the server generates it,
-- shows it once, and keeps only the hash.
create or replace function public.create_account(p_employee text, p_username text, p_hash text)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_emp record;
  v_id  uuid;
begin
  perform app.require_permission('users.manage');
  select employee_id, name, active into v_emp from public.employees
   where employee_id = p_employee and tenant_id = app.current_tenant();
  if not found then raise exception 'no employee % here', p_employee; end if;
  if not v_emp.active then raise exception '% has left', v_emp.name; end if;
  if exists (select 1 from public.app_users where tenant_id = app.current_tenant() and employee_id = p_employee) then
    raise exception '% already has an account', v_emp.name;
  end if;
  if p_username !~ '^[a-z0-9][a-z0-9._-]{2,39}$' then
    raise exception 'a username is 3 to 40 lower-case letters, digits, dots, dashes or underscores';
  end if;
  if exists (select 1 from public.app_users where lower(username) = lower(p_username)) then
    raise exception 'that username is taken';
  end if;

  -- No hash means the directory checks the password: there is none here
  -- to set, change or expire.
  insert into public.app_users
    (tenant_id, username, password_hash, full_name, role, must_change_pw, approval_state,
     created_by_employee, employee_id, auth_source)
  values (app.current_tenant(), p_username, coalesce(p_hash, '!directory'), v_emp.name, 'viewer',
          p_hash is not null, 'pending', app.current_employee(), p_employee,
          case when p_hash is null then 'ldap' else 'local' end)
  returning id into v_id;

  perform app.audit('account_requested', 'app_user', v_id, 'Account requested for ' || v_emp.name || ' (' || p_username || ')');
  return v_id;
end $$;

-- Approve or reject a new account. Not by whoever asked for it, and not
-- by the person it is for.
create or replace function public.decide_account(p_user uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v public.app_users;
begin
  perform app.require_permission('users.approve');
  v := app.account(p_user);
  if v.approval_state <> 'pending' then raise exception 'that account is not waiting for approval'; end if;
  if v.created_by_employee is not distinct from app.current_employee() then
    raise exception 'an account has to be approved by somebody other than whoever asked for it';
  end if;
  if v.employee_id is not distinct from app.current_employee() then
    raise exception 'nobody approves their own account';
  end if;

  update public.app_users
     set approval_state = case when p_approve then 'approved' else 'rejected' end,
         approved_by_employee = app.current_employee()
   where id = p_user;
  perform app.audit(case when p_approve then 'account_approved' else 'account_rejected' end,
                    'app_user', p_user, v.username);
  return case when p_approve then 'approved' else 'rejected' end;
end $$;

-- A profile change waits for approval.
create or replace function public.propose_profile(p_user uuid, p_full_name text, p_email text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v public.app_users;
begin
  perform app.require_permission('users.manage');
  v := app.account(p_user);
  update public.app_users
     set pending_profile = jsonb_build_object(
           'full_name', nullif(trim(p_full_name), ''),
           'email',     nullif(trim(p_email), ''),
           'by',        app.current_employee(),
           'at',        now())
   where id = p_user;
  perform app.audit('profile_change_proposed', 'app_user', p_user, v.username);
end $$;

create or replace function public.decide_profile(p_user uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v public.app_users;
begin
  perform app.require_permission('users.approve');
  v := app.account(p_user);
  if v.pending_profile is null then raise exception 'there is no profile change waiting'; end if;
  if v.pending_profile->>'by' is not distinct from app.current_employee() then
    raise exception 'a profile change has to be approved by somebody other than whoever proposed it';
  end if;
  update public.app_users
     set full_name = case when p_approve then coalesce(v.pending_profile->>'full_name', full_name) else full_name end,
         email     = case when p_approve then coalesce(v.pending_profile->>'email', email) else email end,
         pending_profile = null
   where id = p_user;
  perform app.audit(case when p_approve then 'profile_change_approved' else 'profile_change_rejected' end,
                    'app_user', p_user, v.username);
end $$;

-- Active, disabled (temporary) or deactivated (permanent).
create or replace function public.set_account_status(p_user uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v public.app_users;
begin
  perform app.require_permission('users.manage');
  v := app.account(p_user);
  if p_status not in ('active', 'disabled', 'deactivated') then raise exception 'no such status: %', p_status; end if;
  if v.employee_id is not distinct from app.current_employee() then
    raise exception 'you cannot change your own account''s status';
  end if;
  if v.status = 'deactivated' then
    raise exception 'a deactivated account stays deactivated';
  end if;
  update public.app_users
     set status = p_status,
         deactivated_at = case when p_status = 'deactivated' then now() end
   where id = p_user;
  perform app.audit('account_' || p_status, 'app_user', p_user, v.username);
end $$;

create or replace function public.unlock_account(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v public.app_users;
begin
  perform app.require_permission('users.manage');
  v := app.account(p_user);
  update public.app_users set failed_attempts = 0, locked_at = null where id = p_user;
  perform app.audit('account_unlocked', 'app_user', p_user, v.username);
end $$;

-- A new temporary password, hashed by the server; changed at next sign-in.
create or replace function public.set_account_password(p_user uuid, p_hash text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v public.app_users;
begin
  perform app.require_permission('users.manage');
  v := app.account(p_user);
  if v.auth_source = 'ldap' then
    raise exception '% signs in with the directory password; reset it there', v.username;
  end if;
  update public.app_users
     set password_history = (array[password_hash] || password_history)[1:5],
         password_hash = p_hash, must_change_pw = true, password_changed_at = now(),
         failed_attempts = 0, locked_at = null
   where id = p_user;
  perform app.audit('password_reset', 'app_user', p_user, v.username);
end $$;

-- ---------------------------------------------------------------------
-- Roles.
-- ---------------------------------------------------------------------
create or replace function app.check_permissions(p_permissions text[])
returns void
language plpgsql
immutable
as $$
declare p text;
begin
  foreach p in array coalesce(p_permissions, '{}') loop
    if not p = any (app.permission_catalogue()) then
      raise exception 'there is no % permission', p;
    end if;
  end loop;
end $$;

create or replace function public.create_role(p_name text, p_description text, p_permissions text[])
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_id uuid;
begin
  perform app.require_permission('roles.manage');
  perform app.check_permissions(p_permissions);
  if coalesce(trim(p_name), '') = '' then raise exception 'a role needs a name'; end if;
  insert into public.roles (tenant_id, name, description, permissions, status, created_by)
  values (app.current_tenant(), trim(p_name), nullif(trim(p_description), ''),
          coalesce(p_permissions, '{}'), 'pending', app.current_employee())
  returning id into v_id;
  perform app.audit('role_requested', 'role', v_id, trim(p_name));
  return v_id;
end $$;

-- A change to an active role waits; the role works as it was meanwhile.
create or replace function public.propose_role_change(p_role uuid, p_name text, p_permissions text[])
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  perform app.require_permission('roles.manage');
  perform app.check_permissions(p_permissions);
  select * into v from public.roles where id = p_role and tenant_id = app.current_tenant();
  if not found then raise exception 'no such role'; end if;
  if v.status <> 'active' then raise exception 'only an active role can be changed'; end if;
  update public.roles
     set pending_name = nullif(trim(p_name), ''), pending_permissions = coalesce(p_permissions, '{}'),
         changed_by = app.current_employee(), updated_at = now()
   where id = p_role;
  perform app.audit('role_change_proposed', 'role', p_role, v.name);
end $$;

create or replace function public.decide_role(p_role uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  perform app.require_permission('roles.approve');
  select * into v from public.roles where id = p_role and tenant_id = app.current_tenant() for update;
  if not found then raise exception 'no such role'; end if;

  if v.status = 'pending' then
    if v.created_by is not distinct from app.current_employee() then
      raise exception 'a role has to be approved by somebody other than whoever created it';
    end if;
    update public.roles
       set status = case when p_approve then 'active' else 'rejected' end,
           approved_by = app.current_employee(), updated_at = now()
     where id = p_role;
  elsif v.pending_permissions is not null then
    if v.changed_by is not distinct from app.current_employee() then
      raise exception 'a role change has to be approved by somebody other than whoever proposed it';
    end if;
    update public.roles
       set name = case when p_approve then coalesce(v.pending_name, name) else name end,
           permissions = case when p_approve then v.pending_permissions else permissions end,
           pending_name = null, pending_permissions = null,
           approved_by = app.current_employee(), updated_at = now()
     where id = p_role;
  else
    raise exception 'that role has nothing waiting for approval';
  end if;

  perform app.audit(case when p_approve then 'role_approved' else 'role_rejected' end, 'role', p_role, v.name);
  return case when p_approve then 'approved' else 'rejected' end;
end $$;

create or replace function public.assign_role(p_employee text, p_role uuid, p_assign boolean)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_role record;
begin
  perform app.require_permission('users.manage');
  select name, status into v_role from public.roles where id = p_role and tenant_id = app.current_tenant();
  if not found then raise exception 'no such role'; end if;
  if not exists (select 1 from public.employees where employee_id = p_employee and tenant_id = app.current_tenant()) then
    raise exception 'no employee % here', p_employee;
  end if;
  -- Otherwise an administrator could hand themselves the role that
  -- approves roles, and approve their own.
  if p_employee = app.current_employee() then
    raise exception 'nobody changes their own roles';
  end if;
  if p_assign then
    if v_role.status <> 'active' then raise exception 'only an approved role can be given to somebody'; end if;
    insert into public.employee_roles (tenant_id, employee_id, role_id, assigned_by)
    values (app.current_tenant(), p_employee, p_role, app.current_employee())
    on conflict do nothing;
  else
    delete from public.employee_roles
     where tenant_id = app.current_tenant() and employee_id = p_employee and role_id = p_role;
  end if;
  perform app.audit(case when p_assign then 'role_assigned' else 'role_removed' end, 'role', p_role,
                    v_role.name || case when p_assign then ' given to ' else ' taken from ' end || p_employee);
end $$;

-- ---------------------------------------------------------------------
-- A workflow's task settings, for somebody who may change those and
-- nothing else. "Users have two options, one for opening workflow with
-- full edit permission and another one for opening only task settings
-- ... He cannot update any element of diagram, eForm, or variable."
-- ---------------------------------------------------------------------
create or replace function public.update_rule_settings(p_rule uuid, p_deadline_days int, p_require_signature boolean)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  if not (app.has_permission('forms.settings') or app.has_permission('forms.build')) then
    raise exception 'you need the forms.settings permission for that';
  end if;
  select r.id, ft.name into v from public.approval_rules r
    left join public.form_templates ft on ft.id = r.form_template_id
   where r.id = p_rule and r.tenant_id = app.current_tenant();
  if not found then raise exception 'no such approval step'; end if;
  if p_deadline_days is null or p_deadline_days < 1 or p_deadline_days > 60 then
    raise exception 'a step needs between 1 and 60 working days';
  end if;
  update public.approval_rules
     set deadline_days = p_deadline_days, require_signature = coalesce(p_require_signature, false)
   where id = p_rule;
  perform app.audit('task_settings_changed', 'approval_rule', p_rule, coalesce(v.name, 'a workflow'));
end $$;

-- ---------------------------------------------------------------------
-- The HR master file.
--
-- "New mail and employee information will be identified automatically
-- within the system as it will be changed in the master file (HR file).
-- In addition, line manager identification will be automatic."
--
-- Rows arrive as JSON: employee_id, name, designation, department,
-- line_manager_id, email. New people are added, changed ones updated,
-- and — when asked — anybody missing from the file is marked as left.
-- Line managers are set in a second pass, so a file may list reports
-- before their managers. Returns what changed.
-- ---------------------------------------------------------------------
create or replace function public.import_employees(p_rows jsonb, p_mark_missing_left boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  r          jsonb;
  v_added    int := 0;
  v_updated  int := 0;
  v_left     int := 0;
  v_managers int := 0;
  v_skipped  text[] := '{}';
  v_id       text;
  v_mgr      text;
  v_existing record;
  v_desig    text;
  v_dept     text;
  v_email    text;
  v_depts    int := 0;
begin
  perform app.require_permission('org.manage');
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'expected a list of employees'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_id := nullif(trim(r->>'employee_id'), '');
    if v_id is null or coalesce(trim(r->>'name'), '') = '' then
      v_skipped := array_append(v_skipped, coalesce(v_id, '(no id)'));
      continue;
    end if;
    select name, designation, department, email, active into v_existing
      from public.employees where employee_id = v_id and tenant_id = app.current_tenant();
    -- A column the file does not carry leaves what is stored alone; an
    -- empty cell in a column it does carry clears it.
    v_desig := case when r ? 'designation' then nullif(trim(r->>'designation'), '') else v_existing.designation end;
    v_dept  := case when r ? 'department'  then nullif(trim(r->>'department'), '')  else v_existing.department end;
    v_email := case when r ? 'email'       then nullif(lower(trim(r->>'email')), '') else v_existing.email end;
    if v_existing is null then
      insert into public.employees (tenant_id, employee_id, name, designation, department, email, active)
      values (app.current_tenant(), v_id, trim(r->>'name'), v_desig, v_dept, v_email, true);
      v_added := v_added + 1;
    elsif (v_existing.name, v_existing.designation, v_existing.department, v_existing.email, v_existing.active)
          is distinct from (trim(r->>'name'), v_desig, v_dept, v_email, true) then
      update public.employees
         set name = trim(r->>'name'), designation = v_desig, department = v_dept, email = v_email,
             active = true, left_on = null
       where employee_id = v_id and tenant_id = app.current_tenant();
      v_updated := v_updated + 1;
    end if;
  end loop;

  -- Line managers, once everybody exists.
  for r in select * from jsonb_array_elements(p_rows) loop
    v_id  := nullif(trim(r->>'employee_id'), '');
    v_mgr := nullif(trim(r->>'line_manager_id'), '');
    continue when v_id is null or v_id = any (v_skipped) or not (r ? 'line_manager_id');
    if v_mgr is not null and not exists (
         select 1 from public.employees where employee_id = v_mgr and tenant_id = app.current_tenant()) then
      v_skipped := array_append(v_skipped, v_id || ' (manager ' || v_mgr || ' unknown)');
      continue;
    end if;
    update public.employees set line_manager_id = v_mgr
     where employee_id = v_id and tenant_id = app.current_tenant()
       and line_manager_id is distinct from v_mgr;
    if found then v_managers := v_managers + 1; end if;
  end loop;

  -- A department the file names for the first time is a new division:
  -- it gets its row, so it can be given a head, an HRBP and a CXO.
  insert into public.departments (tenant_id, name)
  select distinct app.current_tenant(), e.department from public.employees e
   where e.tenant_id = app.current_tenant() and e.department is not null and e.active
     and not exists (select 1 from public.departments d where d.tenant_id = e.tenant_id and d.name = e.department);
  get diagnostics v_depts = row_count;

  if p_mark_missing_left then
    update public.employees e
       set active = false, left_on = (now() at time zone 'Asia/Dhaka')::date
     where e.tenant_id = app.current_tenant() and e.active
       and not exists (select 1 from jsonb_array_elements(p_rows) x where trim(x->>'employee_id') = e.employee_id);
    get diagnostics v_left = row_count;
  end if;

  perform app.audit('hr_import', 'employee', null::uuid,
    format('HR import: %s added, %s updated, %s line managers set, %s marked as left, %s skipped, %s new departments',
           v_added, v_updated, v_managers, v_left, cardinality(v_skipped), v_depts));

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'managers', v_managers,
                            'left', v_left, 'skipped', to_jsonb(v_skipped), 'departments', v_depts);
end $$;


-- ---------------------------------------------------------------------
-- Whoever the session says is acting is who a new row says did it.
--
-- These tables are written by the browser through the whitelist, and
-- each names its author: who raised the request, who wrote the comment,
-- who delegated. The browser's say-so is replaced with the session's, so
-- nobody can raise a request or leave an audit entry in a colleague's
-- name. With no employee in the session (the seed, scripts) the row is
-- left as given.
-- ---------------------------------------------------------------------
create or replace function app.stamp_actor()
returns trigger
language plpgsql
as $$
begin
  -- Only what the browser writes itself, which runs as app_api. A
  -- security-definer function runs as its owner and says whom it means,
  -- and an invoker function writing for somebody else says so with
  -- app.on_behalf: approving a request starts the follow-up draft in the
  -- requester's name, not the approver's. The browser cannot set it —
  -- it reaches the database only through the whitelist.
  if current_user = 'app_api' and app.current_employee() is not null
     and coalesce(current_setting('app.on_behalf', true), '') <> 'true' then
    new := jsonb_populate_record(new, jsonb_build_object(tg_argv[0], app.current_employee()));
  end if;
  return new;
end $$;

do $st$
declare p record;
begin
  for p in select * from (values
      ('activity_log',         'actor_id'),
      ('form_submissions',     'submitted_by'),
      ('delegation_rules',     'delegator_id'),
      ('notices',              'created_by'),
      ('notice_comments',      'author_id'),
      ('stationery_requests',  'requester_id'),
      ('maintenance_requests', 'requester_id'),
      ('movement_orders',      'requester_id')) v(t, c)
  loop
    execute format('drop trigger if exists %1$s_stamp_actor on public.%1$I', p.t);
    execute format('create trigger %1$s_stamp_actor before insert on public.%1$I
                    for each row execute function app.stamp_actor(%2$L)', p.t, p.c);
  end loop;
end $st$;

-- ---------------------------------------------------------------------
-- Who a form is for.
--
-- "NFA or Memo report or template should be visible as per the role of
-- the user and his/her's division." A form with audience_departments
-- set is offered to, and may be raised by, people in those departments,
-- and is seen in full by whoever designs workflows. Null is everyone.
-- Requests already raised stay readable to everybody on them whatever
-- their department is now.
-- ---------------------------------------------------------------------
create or replace function app.in_audience(p_template uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select app.current_employee() is null
      or app.has_permission('forms.build')
      or coalesce((
           select t.audience_departments is null
               or cardinality(t.audience_departments) = 0
               or exists (select 1 from public.employees e
                           where e.tenant_id = t.tenant_id
                             and e.employee_id = app.current_employee()
                             and e.department = any (t.audience_departments))
             from public.form_templates t
            where t.id = p_template and t.tenant_id = app.current_tenant()), true)
$$;

create or replace function app.check_audience()
returns trigger
language plpgsql
as $$
begin
  -- The browser raising a request, not a function starting one on
  -- somebody's behalf (a follow-up draft, a copy).
  if current_user = 'app_api' and coalesce(current_setting('app.on_behalf', true), '') <> 'true'
     and new.form_template_id is not null and not app.in_audience(new.form_template_id) then
    raise exception 'this form is not offered to your department';
  end if;
  return new;
end $$;

drop trigger if exists form_submissions_audience on public.form_submissions;
create trigger form_submissions_audience before insert on public.form_submissions
  for each row execute function app.check_audience();

-- ---------------------------------------------------------------------
-- Is the signed-in account still allowed in?
--
-- Sessions are signed tokens, so disabling an account would otherwise
-- take effect only when its token ran out. The server calls this with
-- every request, beside app.assert_tenant_live(), so disabling,
-- deactivating or locking an account ends its sessions at once.
-- ---------------------------------------------------------------------
create or replace function app.assert_account_live()
returns void
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  if app.current_user_id() is null then return; end if;
  select status, approval_state, locked_at into v from public.app_users where id = app.current_user_id();
  if not found or v.status <> 'active' or v.approval_state <> 'approved'
     or (v.locked_at is not null and v.locked_at > now() - interval '30 minutes') then
    raise exception 'this account is no longer signed in' using errcode = '28000';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- The accounts, for whoever administers them. Never the password hash,
-- its history or the two-step secret.
-- ---------------------------------------------------------------------
create or replace function public.list_accounts()
returns table (
  id uuid, username text, full_name text, employee_id text, employee_name text,
  department text, email text, status text, approval_state text, auth_source text,
  locked boolean, failed_attempts int, mfa_enabled boolean, must_change_pw boolean,
  password_changed_at timestamptz, last_login_at timestamptz,
  pending_profile jsonb, created_by_employee text, approved_by_employee text,
  deactivated_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
begin
  if not (app.has_permission('users.manage') or app.has_permission('users.approve')) then
    raise exception 'you need the users.manage or users.approve permission for that';
  end if;
  return query
    select u.id, u.username, u.full_name, u.employee_id, e.name, e.department, e.email,
           u.status, u.approval_state, u.auth_source,
           (u.locked_at is not null and u.locked_at > now() - interval '30 minutes'),
           u.failed_attempts, u.mfa_enabled, u.must_change_pw,
           u.password_changed_at, u.last_login_at, u.pending_profile,
           u.created_by_employee, u.approved_by_employee, u.deactivated_at, u.created_at
      from public.app_users u
      left join public.employees e on e.employee_id = u.employee_id and e.tenant_id = u.tenant_id
     where u.tenant_id = app.current_tenant()
     order by u.approval_state = 'pending' desc, u.pending_profile is not null desc, lower(u.username);
end $$;

-- ---------------------------------------------------------------------
-- People syncs: every import from the HR file or the directory, with its
-- result or why it failed, so somebody can see the daily sync is running.
-- ---------------------------------------------------------------------
create or replace function public.record_directory_sync(p_source text, p_result jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.require_permission('org.manage');
  if p_source not in ('ldap', 'csv', 'scheduled') then raise exception 'unknown sync source %', p_source; end if;
  insert into public.directory_syncs (tenant_id, source, result, error, run_by)
  values (app.current_tenant(), p_source, p_result, left(p_error, 500), app.current_employee());
end $$;

do $ds$
begin
  drop policy if exists directory_syncs_read on public.directory_syncs;
  create policy directory_syncs_read on public.directory_syncs
    for select to app_api
    using (tenant_id = app.current_tenant() and app.is_member()
           and (app.has_permission('org.manage') or app.has_permission('audit.view')));
end $ds$;

grant execute on all functions in schema app to app_api;
grant execute on function
  public.create_account(text, text, text),
  public.decide_account(uuid, boolean),
  public.propose_profile(uuid, text, text),
  public.decide_profile(uuid, boolean),
  public.set_account_status(uuid, text),
  public.unlock_account(uuid),
  public.set_account_password(uuid, text),
  public.create_role(text, text, text[]),
  public.propose_role_change(uuid, text, text[]),
  public.decide_role(uuid, boolean),
  public.assign_role(text, uuid, boolean),
  public.update_rule_settings(uuid, int, boolean),
  public.import_employees(jsonb, boolean),
  public.list_accounts(),
  public.record_directory_sync(text, jsonb, text)
to app_api;
grant select on public.directory_syncs to app_api;

commit;
