-- =====================================================================
-- Who sees a request (db/009_visibility.sql).
--
-- On a fresh evaluation, as the application's own role: a request is
-- seen by whoever raised it, whoever is on its chain (or standing in
-- for them, or acted on it), whoever is copied or told about it,
-- oversight, and the head of the requester's department — and by
-- nobody else. What hangs off a request goes with it.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

select set_config('app.is_staff', 'true', false);
select set_config('t.tpl', (select tenant_id::text from app.provision_demo(
  'Visibility Test', 'visibility.test.' || substr(md5(random()::text), 1, 8), 'hash', interval '1 day')), false);
select set_config('app.is_staff', 'false', false);

create or replace function pg_temp.as_emp(p_emp text) returns void language plpgsql as $$
begin
  perform set_config('app.tenant_id',   current_setting('t.tpl'), true),
          set_config('app.user_id',     '00000000-0000-4000-8000-0000000000aa', true),
          set_config('app.role',        'admin', true),
          set_config('app.is_staff',    'false', true),
          set_config('app.employee_id', coalesce(p_emp, ''), true),
          set_config('app.api_key',     '', true),
          set_config('app.mfa',         'true', true);
end $$;

-- A request nobody but its requester's chain has any part in: not Tom's,
-- Tom not on it, not copied, not told, and raised outside Operations so
-- no head Tom works under is in play either.
create or replace function pg_temp.stranger_request(p_emp text) returns uuid language sql as $$
  select s.id from public.form_submissions s
    join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by
   where s.tenant_id = current_setting('t.tpl')::uuid and s.status <> 'draft'
     and s.submitted_by <> p_emp and e.department <> 'Operations'
     and not exists (select 1 from public.approval_requests r where r.submission_id = s.id and r.approver_user_id = p_emp)
     and not exists (select 1 from public.approval_events v where v.subject_id = s.id and v.actor_id = p_emp)
     and not exists (select 1 from public.submission_cc c where c.submission_id = s.id and c.employee_id = p_emp)
     and not exists (select 1 from public.notifications n where n.entity_id = s.id and n.recipient_id = p_emp)
     and exists (select 1 from public.submission_values v where v.submission_id = s.id)
     and exists (select 1 from public.approval_requests r where r.submission_id = s.id)
   order by s.submitted_at
   limit 1
$$;

do $$
declare v_s uuid; v_total int;
begin
  v_s := pg_temp.stranger_request('EMP-2847');
  if v_s is null then raise exception 'FAIL: the evaluation has no request Tom has no part in to test with'; end if;
  perform set_config('t.stranger', v_s::text, false);
  select count(*) into v_total from public.form_submissions where tenant_id = current_setting('t.tpl')::uuid and status <> 'draft';
  perform set_config('t.total', v_total::text, false);
end $$;

-- =====================================================================
-- 1. An analyst sees their own, and not somebody else's
-- =====================================================================
do $$
declare v_own int; v_seen int; v_n int; v_mine int; v_live int;
begin
  select count(*) into v_own from public.form_submissions
   where tenant_id = current_setting('t.tpl')::uuid and submitted_by = 'EMP-2847' and status <> 'draft';
  set local role app_api;
  perform pg_temp.as_emp('EMP-2847');
  select count(*) into v_seen from public.form_submissions where status <> 'draft';
  select count(*) into v_live from public.form_submissions where status <> 'draft' and archived_at is null;
  select count(*) into v_mine from public.form_submissions where status <> 'draft' and submitted_by = 'EMP-2847';
  if v_mine <> v_own then raise exception 'FAIL: Tom sees % of his own % requests', v_mine, v_own; end if;
  if v_seen >= current_setting('t.total')::int then
    raise exception 'FAIL: Tom sees all % requests', v_seen;
  end if;
  if exists (select 1 from public.form_submissions where id = current_setting('t.stranger')::uuid) then
    raise exception 'FAIL: Tom sees a request he has no part in';
  end if;
  -- Nothing that hangs off it shows either.
  select count(*) into v_n from public.submission_values where submission_id = current_setting('t.stranger')::uuid;
  if v_n > 0 then raise exception 'FAIL: Tom reads its answers'; end if;
  select count(*) into v_n from public.approval_requests where submission_id = current_setting('t.stranger')::uuid;
  if v_n > 0 then raise exception 'FAIL: Tom reads its steps'; end if;
  select count(*) into v_n from public.approval_events where subject_id = current_setting('t.stranger')::uuid;
  if v_n > 0 then raise exception 'FAIL: Tom reads its history'; end if;
  select count(*) into v_n from public.submission_stats where submission_id = current_setting('t.stranger')::uuid;
  if v_n > 0 then raise exception 'FAIL: Tom reads its sums'; end if;
  select count(*) into v_n from public.activity_log where entity_id = current_setting('t.stranger')::uuid;
  if v_n > 0 then raise exception 'FAIL: Tom reads its activity'; end if;
  -- The tracker follows: what it lists is what he may see.
  if jsonb_array_length(public.tracker_list('{}'::jsonb)) <> v_live then raise exception 'FAIL: the tracker lists % where Tom may see %', jsonb_array_length(public.tracker_list('{}'::jsonb)), v_live; end if;
  if public.tracker_list('{}'::jsonb) @> jsonb_build_array(jsonb_build_object('id', current_setting('t.stranger'))) then
    raise exception 'FAIL: the tracker lists the stranger''s request';
  end if;
  -- And it cannot be changed from outside.
  update public.form_submissions set priority = 'urgent' where id = current_setting('t.stranger')::uuid;
  get diagnostics v_n = row_count;
  if v_n > 0 then raise exception 'FAIL: Tom changed a request he cannot see'; end if;
end $$;
do $$ begin raise notice 'pass: an analyst sees his own requests and not another''s — nor its answers, steps, history, sums or activity'; end $$;

-- =====================================================================
-- 2. On the chain: an approver sees what comes to them
-- =====================================================================
do $$
declare v_who text;
begin
  select approver_user_id into v_who from public.approval_requests
   where submission_id = current_setting('t.stranger')::uuid and approver_user_id is not null order by step_index limit 1;
  perform set_config('t.approver', v_who, false);
  set local role app_api;
  perform pg_temp.as_emp(v_who);
  if not exists (select 1 from public.form_submissions where id = current_setting('t.stranger')::uuid) then
    raise exception 'FAIL: % is on the chain and cannot see the request', v_who;
  end if;
  if not exists (select 1 from public.submission_values where submission_id = current_setting('t.stranger')::uuid) then
    raise exception 'FAIL: % is on the chain and cannot read its answers', v_who;
  end if;
end $$;
do $$ begin raise notice 'pass: whoever is on the chain sees the request and its answers'; end $$;

-- =====================================================================
-- 3. Standing in: a delegate sees the steps still open
-- =====================================================================
do $$
declare v_sub uuid;
begin
  select r.submission_id into v_sub from public.approval_requests r
    join public.form_submissions s on s.id = r.submission_id
   where r.tenant_id = current_setting('t.tpl')::uuid and r.status = 'pending' and r.approver_user_id <> 'EMP-2847'
     and s.id not in (select id from public.form_submissions where submitted_by = 'EMP-2847')
     and not exists (select 1 from public.approval_requests x where x.submission_id = s.id and x.approver_user_id = 'EMP-2847')
     and not exists (select 1 from public.notifications n where n.entity_id = s.id and n.recipient_id = 'EMP-2847')
     and not exists (select 1 from public.submission_cc c where c.submission_id = s.id and c.employee_id = 'EMP-2847')
   limit 1;
  if v_sub is null then raise exception 'FAIL: no open step to delegate'; end if;
  perform pg_temp.as_emp('EMP-2847');
  set local role app_api;
  if exists (select 1 from public.form_submissions where id = v_sub) then
    raise exception 'FAIL: Tom sees the request before standing in';
  end if;
  reset role;
  insert into public.delegation_rules (tenant_id, delegator_id, delegate_id, start_date, end_date, reason)
  select current_setting('t.tpl')::uuid, r.approver_user_id, 'EMP-2847', current_date - 1, current_date + 7, 'leave'
    from public.approval_requests r where r.submission_id = v_sub and r.status = 'pending' limit 1;
  set local role app_api;
  if not exists (select 1 from public.form_submissions where id = v_sub) then
    raise exception 'FAIL: standing in, Tom cannot see the step he may act on';
  end if;
end $$;
do $$ begin raise notice 'pass: a delegate sees the requests on the steps they stand in for'; end $$;

-- =====================================================================
-- 4. Copied, and told
-- =====================================================================
do $$
begin
  insert into public.submission_cc (tenant_id, submission_id, employee_id, added_by)
  values (current_setting('t.tpl')::uuid, current_setting('t.stranger')::uuid, 'EMP-0412', 'EMP-0445');
  set local role app_api;
  perform pg_temp.as_emp('EMP-0412');
  if not exists (select 1 from public.form_submissions where id = current_setting('t.stranger')::uuid) then
    raise exception 'FAIL: somebody copied on a request cannot see it';
  end if;
end $$;
do $$
declare v_sub uuid;
begin
  select pg_temp.stranger_request('EMP-3120') into v_sub;
  perform set_config('t.told', v_sub::text, false);
  insert into public.notifications (tenant_id, recipient_id, kind, title, body, entity_type, entity_id)
  values (current_setting('t.tpl')::uuid, 'EMP-3120', 'watch', 'A request you watch was approved', '', 'form_submission', v_sub);
  set local role app_api;
  perform pg_temp.as_emp('EMP-3120');
  if not exists (select 1 from public.form_submissions where id = v_sub) then
    raise exception 'FAIL: somebody told about a request cannot open it';
  end if;
end $$;
do $$ begin raise notice 'pass: whoever is copied on a request, or told about it, sees it'; end $$;

-- =====================================================================
-- 5. Oversight sees everything
-- =====================================================================
do $$
declare v_n int;
begin
  set local role app_api;
  perform pg_temp.as_emp('EMP-0830');   -- the compliance auditor: audit.view, reports.view
  select count(*) into v_n from public.form_submissions where status <> 'draft';
  if v_n <> current_setting('t.total')::int then
    raise exception 'FAIL: the auditor sees % of % requests', v_n, current_setting('t.total');
  end if;
end $$;
do $$ begin raise notice 'pass: oversight (reports.view, audit.view) sees every request'; end $$;

-- =====================================================================
-- 5b. A role overseeing a form sees every request of it, and no others
-- =====================================================================
-- Somebody new in Compliance: on no declaration's route, copied on
-- nothing, told of nothing. Only the role, held through the department.
do $$
begin
  perform pg_temp.as_emp(null);   -- the organisation's administrator
  insert into public.employees (tenant_id, employee_id, name, designation, department, line_manager_id)
  values (current_setting('t.tpl')::uuid, 'EMP-0899', 'Noor Islam', 'Compliance Analyst', 'Compliance', 'EMP-0700');
end $$;
do $$
declare v_form uuid; v_all int; v_seen int; v_other int;
begin
  select id into v_form from public.form_templates
   where tenant_id = current_setting('t.tpl')::uuid and name = 'Gift & Hospitality Declaration';
  if not exists (select 1 from public.form_overseers where form_template_id = v_form) then
    raise exception 'FAIL: the evaluation was not given the Compliance oversight of ABC declarations';
  end if;
  select count(*) into v_all from public.form_submissions where form_template_id = v_form and status <> 'draft';
  set local role app_api;
  perform pg_temp.as_emp('EMP-0899');
  if app.sees_every_request() then raise exception 'FAIL: Noor has the organisation-wide view; the test proves nothing'; end if;
  select count(*) into v_seen from public.form_submissions where form_template_id = v_form and status <> 'draft';
  select count(*) into v_other from public.form_submissions where form_template_id <> v_form and status <> 'draft';
  reset role;
  if v_all = 0 then raise exception 'FAIL: no declarations to test with'; end if;
  if v_seen <> v_all then
    raise exception 'FAIL: Noor, in Compliance, sees % of % ABC declarations', v_seen, v_all;
  end if;
  if v_other <> 0 then
    raise exception 'FAIL: the oversight of declarations showed Noor % requests of other forms', v_other;
  end if;
  -- Without the role, nothing.
  delete from public.role_groups where tenant_id = current_setting('t.tpl')::uuid and department = 'Compliance'
     and role_id = (select role_id from public.form_overseers where form_template_id = v_form limit 1);
  set local role app_api;
  perform pg_temp.as_emp('EMP-0899');
  select count(*) into v_seen from public.form_submissions where form_template_id = v_form and status <> 'draft';
  reset role;
  if v_seen <> 0 then raise exception 'FAIL: Noor still sees % declarations with the role taken from Compliance', v_seen; end if;
end $$;
do $$ begin raise notice 'pass: Compliance sees every ABC declaration through its role, and no other request; without the role, none'; end $$;

-- =====================================================================
-- 6. A department's head sees the department's requests
-- =====================================================================
do $$
declare v_head text; v_dept text; v_member text; v_sub uuid; v_other text;
begin
  -- A head without oversight, and somebody in their department.
  select d.head_employee_id, d.name into v_head, v_dept from public.departments d
   where d.tenant_id = current_setting('t.tpl')::uuid and d.head_employee_id is not null
     and not exists (select 1 from public.employee_roles er where er.tenant_id = d.tenant_id and er.employee_id = d.head_employee_id)
     and exists (select 1 from public.employees e where e.tenant_id = d.tenant_id and e.department = d.name
                    and e.employee_id <> d.head_employee_id)
   order by d.name limit 1;
  select employee_id into v_member from public.employees
   where tenant_id = current_setting('t.tpl')::uuid and department = v_dept and employee_id <> v_head limit 1;
  -- Somebody outside the department, with no oversight either.
  select e.employee_id into v_other from public.employees e
   where e.tenant_id = current_setting('t.tpl')::uuid and e.department <> v_dept
     and not exists (select 1 from public.employee_roles er where er.tenant_id = e.tenant_id and er.employee_id = e.employee_id)
     and not exists (select 1 from public.departments d where d.tenant_id = e.tenant_id and d.head_employee_id = e.employee_id)
   limit 1;
  -- A request raised in the department, with nobody yet on it. (A new
  -- request is stamped with the session's employee, so raise it as them.)
  perform pg_temp.as_emp(v_member);
  insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
  select current_setting('t.tpl')::uuid, id, v_member, 'submitted', now()
    from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Leave Application'
  returning id into v_sub;
  if v_sub is null then raise exception 'FAIL: could not raise the test request'; end if;
  set local role app_api;
  perform pg_temp.as_emp(v_head);
  if not exists (select 1 from public.form_submissions where id = v_sub) then
    raise exception 'FAIL: % heads % and cannot see a request raised there', v_head, v_dept;
  end if;
  perform pg_temp.as_emp(v_other);
  if exists (select 1 from public.form_submissions where id = v_sub) then
    raise exception 'FAIL: %, outside %, sees a request raised there', v_other, v_dept;
  end if;
end $$;
do $$ begin raise notice 'pass: a department''s head sees its requests; somebody outside it does not'; end $$;

-- =====================================================================
-- 7. Raising still works, and a reminder needs a request you can see
-- =====================================================================
do $$
declare v_sub uuid; v_tpl uuid; v_n int;
begin
  select id into v_tpl from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Leave Application';
  set local role app_api;
  perform pg_temp.as_emp('EMP-2847');
  insert into public.form_submissions (form_template_id, submitted_by, status, submitted_at)
  values (v_tpl, 'EMP-2847', 'submitted', now()) returning id into v_sub;
  insert into public.submission_values (submission_id, field_name, value) values (v_sub, 'reason', 'Family visit');
  select public.build_approval_chain('form_submission', v_sub, v_tpl) into v_n;
  if v_n < 1 then raise exception 'FAIL: Tom''s own request built no chain'; end if;
  if not exists (select 1 from public.approval_requests where submission_id = v_sub) then
    raise exception 'FAIL: Tom cannot see the steps of his own request';
  end if;
  begin
    perform public.set_tracker_reminder(current_setting('t.stranger')::uuid, current_date + 1, 'peek');
    raise exception 'FAIL: a reminder was set on a request Tom cannot see';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  perform public.set_tracker_reminder(v_sub, current_date + 1, 'chase');
end $$;
do $$ begin raise notice 'pass: raising a request still works end to end, and a reminder needs one you can see'; end $$;

-- Tidy: the evaluation goes, and everything it held with it.
-- Removing an organisation is platform staff's to do (row security on tenants).
select set_config('app.is_staff', 'true', false);
delete from public.tenants where id = current_setting('t.tpl')::uuid;
select set_config('app.is_staff', 'false', false);
