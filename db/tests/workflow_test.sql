-- =====================================================================
-- Workflow suite — the shapes of chain the scope of work asks for.
--
-- The chain suite proves a sequence: one step after another. This one
-- proves what Stage 1 added on top: lanes running in parallel inside a
-- phase and joining, quorum, conditional routes, organisational roles,
-- returning to an earlier approver, the requester taking a request back,
-- approvers asking each other questions, and the ticket that follows.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

delete from public.tenants where slug = 'flow-t';

insert into public.tenants (name, slug, kind, expires_at)
values ('Flow Tenant', 'flow-t', 'demo', now() + interval '1 day');
select set_config('t.f', (select id::text from public.tenants where slug = 'flow-t'), false);

insert into public.app_users (tenant_id, username, password_hash, full_name)
values (current_setting('t.f')::uuid, 'f.eval', 'x', 'F Evaluator');
select set_config('u.f', (select id::text from public.app_users where username = 'f.eval'), false);

-- The org chart. CX runs the division; HD heads the Ops department and
-- is also the requester's line manager, so "LM then HoD" is one person.
insert into public.employees (tenant_id, employee_id, name, department) values
  (current_setting('t.f')::uuid, 'CX', 'Chief Operating Officer', 'Ops'),
  (current_setting('t.f')::uuid, 'HB', 'HR Business Partner',     'HR'),
  (current_setting('t.f')::uuid, 'HR', 'Head of HR',              'HR'),
  (current_setting('t.f')::uuid, 'FI', 'Finance Clearance',       'Finance'),
  (current_setting('t.f')::uuid, 'SC', 'Supply Chain Clearance',  'Supply Chain'),
  (current_setting('t.f')::uuid, 'AD', 'Admin Clearance',         'Admin'),
  (current_setting('t.f')::uuid, 'IT', 'IT Clearance',            'Technology'),
  (current_setting('t.f')::uuid, 'K1', 'Compliance One',          'Compliance'),
  (current_setting('t.f')::uuid, 'K2', 'Compliance Two',          'Compliance'),
  (current_setting('t.f')::uuid, 'K3', 'Compliance Three',        'Compliance'),
  (current_setting('t.f')::uuid, 'OUT', 'Not On Any Chain',       'Ops');

insert into public.employees (tenant_id, employee_id, name, department, line_manager_id) values
  (current_setting('t.f')::uuid, 'HD', 'Head of Ops', 'Ops', 'CX');

insert into public.employees (tenant_id, employee_id, name, department, line_manager_id) values
  (current_setting('t.f')::uuid, 'RQ', 'Requester', 'Ops', 'HD');

insert into public.departments (tenant_id, name, head_employee_id, hrbp_employee_id, cxo_employee_id) values
  (current_setting('t.f')::uuid, 'Ops', 'HD', 'HB', 'CX');

-- Forms. A: exit clearance. B: any two of three accessors, then HR.
-- C: a plain three-step sequence. D: conditional routes. E → F: a
-- follow-up. All with a "Route" and an "Amount" question for conditions.
insert into public.form_templates (id, tenant_id, name, status) values
  ('a0000000-0000-4000-8000-00000000000a', current_setting('t.f')::uuid, 'Exit clearance', 'published'),
  ('a0000000-0000-4000-8000-00000000000b', current_setting('t.f')::uuid, 'Gift declaration', 'published'),
  ('a0000000-0000-4000-8000-00000000000c', current_setting('t.f')::uuid, 'Sequence', 'published'),
  ('a0000000-0000-4000-8000-00000000000d', current_setting('t.f')::uuid, 'Campaign', 'published'),
  ('a0000000-0000-4000-8000-00000000000f', current_setting('t.f')::uuid, 'Campaign NFA', 'published');
insert into public.form_templates (id, tenant_id, name, status, followup_template_id) values
  ('a0000000-0000-4000-8000-00000000000e', current_setting('t.f')::uuid, 'Campaign request', 'published',
   'a0000000-0000-4000-8000-00000000000f');

insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, order_index) values
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000d', 'select', 'Route', 0),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000d', 'number', 'Budget', 1),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000e', 'text', 'Campaign name', 0),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000e', 'text', 'Internal note', 1),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000f', 'text', 'Campaign name', 0),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000f', 'number', 'Beneficiary count', 1);

-- A: phase 0 runs the division lane (LM, HoD, HRBP, CXO in order) beside
-- four department lanes; phase 1 is HR, after all of them.
insert into public.approval_rules
  (tenant_id, form_template_id, approver_user_id, label, step_index, lane, position, stage_label) values
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', null, 'line_manager',    0, 'Division', 0, 'Clearance'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', null, 'department_head', 0, 'Division', 1, 'Clearance'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', null, 'hrbp',            0, 'Division', 2, 'Clearance'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', null, 'cxo',             0, 'Division', 3, 'Clearance'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', 'FI', 'finance',         0, 'Finance',  4, 'Clearance'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', 'SC', 'scm',             0, 'Supply Chain', 5, 'Clearance'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', 'AD', 'admin',           0, 'Admin',    6, 'Clearance'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', 'IT', 'it',              0, 'Technology', 7, 'Clearance'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000a', 'HR', 'hr',              1, null,       0, 'Final settlement');

-- B: three accessors, any two; then HR.
insert into public.approval_rules
  (tenant_id, form_template_id, approver_user_id, label, step_index, position, quorum) values
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000b', 'K1', 'accessor', 0, 0, 2),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000b', 'K2', 'accessor', 0, 1, 2),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000b', 'K3', 'accessor', 0, 2, 2),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000b', 'HR', 'hr',       1, 0, null);

-- C: FI, then SC, then AD.
insert into public.approval_rules
  (tenant_id, form_template_id, approver_user_id, label, step_index) values
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000c', 'FI', 'one',   0),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000c', 'SC', 'two',   1),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000c', 'AD', 'three', 2);

-- D: the CXO first only on the exceptional route; IT only over 1,000,000;
-- then finance always.
insert into public.approval_rules
  (tenant_id, form_template_id, approver_user_id, label, step_index, condition) values
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000d', 'CX', 'cxo_exception', 0,
   '{"field": "Route", "op": "eq", "value": "Exceptional"}'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000d', 'IT', 'big_budget', 1,
   '{"field": "Budget", "op": "gt", "value": "1000000"}'),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000d', 'FI', 'finance', 2, null);

-- E: one approver; F, the follow-up, one approver.
insert into public.approval_rules
  (tenant_id, form_template_id, approver_user_id, label, step_index) values
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000e', 'FI', 'review', 0),
  (current_setting('t.f')::uuid, 'a0000000-0000-4000-8000-00000000000f', 'HD', 'hod', 0);

-- Submissions, all raised by RQ.
insert into public.form_submissions (id, tenant_id, form_template_id, submitted_by, status)
select ('b0000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       current_setting('t.f')::uuid,
       ('a0000000-0000-4000-8000-00000000000' || t)::uuid,
       'RQ', 'submitted'
  from (values (1, 'a'), (2, 'b'), (3, 'a'), (4, 'c'), (5, 'c'), (6, 'c'),
               (7, 'd'), (8, 'd'), (9, 'c'), (10, 'e'), (11, 'c')) v(n, t);

insert into public.submission_values (tenant_id, submission_id, field_name, value) values
  (current_setting('t.f')::uuid, 'b0000000-0000-4000-8000-000000000007', 'Route',  'Exceptional'),
  (current_setting('t.f')::uuid, 'b0000000-0000-4000-8000-000000000007', 'Budget', '2,500,000'),
  (current_setting('t.f')::uuid, 'b0000000-0000-4000-8000-000000000008', 'Route',  'Regular'),
  (current_setting('t.f')::uuid, 'b0000000-0000-4000-8000-000000000008', 'Budget', '400000'),
  (current_setting('t.f')::uuid, 'b0000000-0000-4000-8000-000000000010', 'Campaign name', 'Eid cashback'),
  (current_setting('t.f')::uuid, 'b0000000-0000-4000-8000-000000000010', 'Internal note', 'not carried');

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % — got %, want %', label, got, want;
  end if;
  raise notice 'pass: %', label;
end $$;

create or replace function pg_temp.ctx() returns void language plpgsql as $$
begin
  perform set_config('app.tenant_id', current_setting('t.f'), true),
          set_config('app.user_id',   current_setting('u.f'), true),
          set_config('app.role',      'admin', true),
          set_config('app.is_staff',  'false', true);
end $$;

-- Who is live on a submission right now, in lane order.
create or replace function pg_temp.live(p_sub uuid) returns text language sql as $$
  select coalesce(string_agg(approver_user_id, ',' order by step_index, lane, lane_step), '')
    from public.approval_requests where submission_id = p_sub and status = 'pending'
$$;

-- Act as whoever holds the open step of a submission held by a person.
create or replace function pg_temp.act(p_sub uuid, p_who text, p_action text, p_comment text default null)
returns text language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from public.approval_requests
   where submission_id = p_sub and approver_user_id = p_who
     and status in ('pending', 'clarification')
   order by step_index, lane, lane_step limit 1;
  if v_id is null then raise exception 'FAIL: % has nothing open on %', p_who, p_sub; end if;
  return public.act_on_approval(v_id, p_action, p_comment, p_who);
end $$;

create or replace function pg_temp.step(p_sub uuid, p_who text) returns uuid language sql as $$
  select id from public.approval_requests
   where submission_id = p_sub and approver_user_id = p_who
   order by step_index, lane, lane_step limit 1
$$;

-- =====================================================================
-- 1. Exit clearance: the division lane runs beside four departments,
--    and HR closes it only after all five
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();

  -- HD is both line manager and head of department: one step, not two.
  select pg_temp.check('the clearance lays out eight steps',
    public.build_approval_chain('form_submission', 'b0000000-0000-4000-8000-000000000001',
                                'a0000000-0000-4000-8000-00000000000a'), 8);

  select pg_temp.check('the division lane is LM/HoD once, then HRBP, then CXO',
    (select string_agg(approver_user_id, ',' order by lane_step) from public.approval_requests
      where submission_id = 'b0000000-0000-4000-8000-000000000001' and step_index = 0 and lane = 0),
    'HD,HB,CX'::text);

  select pg_temp.check('all five lanes are live at once',
    pg_temp.live('b0000000-0000-4000-8000-000000000001'), 'HD,FI,SC,AD,IT'::text);

  select pg_temp.check('HR waits behind them',
    (select status from public.approval_requests
      where submission_id = 'b0000000-0000-4000-8000-000000000001' and approver_user_id = 'HR'),
    'waiting'::text);

  select pg_temp.check('lanes carry their names for the timeline',
    (select lane_label from public.approval_requests
      where submission_id = 'b0000000-0000-4000-8000-000000000001' and approver_user_id = 'SC'),
    'Supply Chain'::text);
commit;

do $$
declare s uuid := 'b0000000-0000-4000-8000-000000000001';
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform pg_temp.act(s, 'FI', 'approve');
  perform pg_temp.act(s, 'SC', 'approve');
  perform pg_temp.act(s, 'AD', 'approve');
  perform pg_temp.act(s, 'IT', 'approve');
  if pg_temp.live(s) <> 'HD' then
    raise exception 'FAIL: with four departments cleared, live is % not the division lane alone', pg_temp.live(s);
  end if;

  perform pg_temp.act(s, 'HD', 'approve');
  if pg_temp.live(s) <> 'HB' then raise exception 'FAIL: the division lane moved to % not HB', pg_temp.live(s); end if;
  perform pg_temp.act(s, 'HB', 'approve');
  perform pg_temp.act(s, 'CX', 'approve');
  if pg_temp.live(s) <> 'HR' then raise exception 'FAIL: after every lane, live is % not HR', pg_temp.live(s); end if;

  perform pg_temp.act(s, 'HR', 'approve');
  if (select status from public.form_submissions where id = s) <> 'completed' then
    raise exception 'FAIL: the clearance did not complete';
  end if;

  reset role;
  raise notice 'pass: departments clear in parallel; HR is asked only once every lane has';
end $$;

-- =====================================================================
-- 2. Any two of three accessors
-- =====================================================================
do $$
declare s uuid := 'b0000000-0000-4000-8000-000000000002';
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission', s, 'a0000000-0000-4000-8000-00000000000b');
  if pg_temp.live(s) <> 'K1,K2,K3' then raise exception 'FAIL: live is %', pg_temp.live(s); end if;

  perform pg_temp.act(s, 'K2', 'approve');
  if pg_temp.live(s) <> 'K1,K3' then raise exception 'FAIL: one of two moved it on: live is %', pg_temp.live(s); end if;

  perform pg_temp.act(s, 'K3', 'approve');
  if pg_temp.live(s) <> 'HR' then raise exception 'FAIL: two of three did not move it on: live is %', pg_temp.live(s); end if;
  if (select status from public.approval_requests where id = pg_temp.step(s, 'K1')) <> 'skipped' then
    raise exception 'FAIL: the third accessor is still asked once two have cleared it';
  end if;

  reset role;
  raise notice 'pass: any two of three accessors clear it, and the third is no longer asked';
end $$;

-- =====================================================================
-- 3. One refusal inside a parallel phase refuses the request
-- =====================================================================
do $$
declare s uuid := 'b0000000-0000-4000-8000-000000000003';
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission', s, 'a0000000-0000-4000-8000-00000000000a');
  perform pg_temp.act(s, 'FI', 'approve');
  perform pg_temp.act(s, 'AD', 'reject', 'Laptop not returned');

  if (select status from public.form_submissions where id = s) <> 'rejected' then
    raise exception 'FAIL: a refused clearance is not rejected';
  end if;
  if pg_temp.live(s) <> '' then raise exception 'FAIL: % still live after a rejection', pg_temp.live(s); end if;
  if (select count(*) from public.approval_requests where submission_id = s and status = 'skipped') <> 6 then
    raise exception 'FAIL: the other lanes and HR were not all marked never asked';
  end if;

  reset role;
  raise notice 'pass: a refusal in one lane ends the request, and the rest are recorded as never asked';
end $$;

-- =====================================================================
-- 4. Conditional routes
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();

  select pg_temp.check('the exceptional route goes to the CXO first, and IT for a big budget',
    (select public.build_approval_chain('form_submission', 'b0000000-0000-4000-8000-000000000007',
                                        'a0000000-0000-4000-8000-00000000000d')), 3);
  select pg_temp.check('...in that order',
    (select string_agg(approver_user_id, ',' order by step_index) from public.approval_requests
      where submission_id = 'b0000000-0000-4000-8000-000000000007'), 'CX,IT,FI'::text);

  select pg_temp.check('the regular route with a small budget goes straight to finance',
    (select public.build_approval_chain('form_submission', 'b0000000-0000-4000-8000-000000000008',
                                        'a0000000-0000-4000-8000-00000000000d')), 1);

  select pg_temp.check('a condition on a subject with no answers never holds',
    app.condition_holds(null, '{"field": "Route", "op": "eq", "value": "Exceptional"}'), false);
  select pg_temp.check('no condition always holds', app.condition_holds(null, null), true);
commit;

-- =====================================================================
-- 5. Organisational roles
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();
  select pg_temp.check('line manager',    app.resolve_role('line_manager', 'RQ'), 'HD'::text);
  select pg_temp.check('skip level',      app.resolve_role('skip_level', 'RQ'), 'CX'::text);
  select pg_temp.check('head of department', app.resolve_role('department_head', 'RQ'), 'HD'::text);
  select pg_temp.check('HR business partner', app.resolve_role('hrbp', 'RQ'), 'HB'::text);
  select pg_temp.check('CXO',             app.resolve_role('cxo', 'RQ'), 'CX'::text);
commit;

-- =====================================================================
-- 6. Return to an earlier approver
-- =====================================================================
do $$
declare s uuid := 'b0000000-0000-4000-8000-000000000004'; refused boolean;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission', s, 'a0000000-0000-4000-8000-00000000000c');
  perform pg_temp.act(s, 'FI', 'approve');

  -- Not to somebody who has not approved, nor to somebody later.
  refused := false;
  begin
    perform public.return_to_approver(pg_temp.step(s, 'SC'), pg_temp.step(s, 'AD'), 'no', 'SC');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: returned to a later step'; end if;

  perform pg_temp.act(s, 'SC', 'approve');
  perform public.return_to_approver(pg_temp.step(s, 'AD'), pg_temp.step(s, 'FI'),
                                    'The invoice total does not match', 'AD');

  if pg_temp.live(s) <> 'FI' then raise exception 'FAIL: returned, but live is % not FI', pg_temp.live(s); end if;
  if (select status from public.approval_requests where id = pg_temp.step(s, 'SC')) <> 'waiting' then
    raise exception 'FAIL: the approver in between is not asked again';
  end if;
  if not exists (select 1 from public.approval_events
                  where subject_id = s and action = 'returned' and target_id = 'FI'
                    and comment = 'The invoice total does not match') then
    raise exception 'FAIL: the return is not on the trail';
  end if;
  if (select count(*) from public.notifications
       where recipient_id = 'FI' and kind = 'approval.returned' and entity_id = s) <> 1 then
    raise exception 'FAIL: the approver it was returned to was not told';
  end if;

  -- And it walks again in order.
  perform pg_temp.act(s, 'FI', 'approve');
  perform pg_temp.act(s, 'SC', 'approve');
  perform pg_temp.act(s, 'AD', 'approve');
  if (select status from public.form_submissions where id = s) <> 'completed' then
    raise exception 'FAIL: a returned request did not finish';
  end if;
  if (select count(*) from public.approval_events where subject_id = s and action = 'approved' and actor_id = 'FI') <> 2 then
    raise exception 'FAIL: both of FI''s approvals should be on the trail';
  end if;

  reset role;
  raise notice 'pass: a request goes back to an earlier approver, is asked again in order, and the trail keeps both rounds';
end $$;

-- =====================================================================
-- 7. The requester takes it back — until somebody has approved
-- =====================================================================
do $$
declare s uuid := 'b0000000-0000-4000-8000-000000000005'; refused boolean;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission', s, 'a0000000-0000-4000-8000-00000000000c');

  refused := false;
  begin perform public.recall_submission(s, 'FI');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: somebody other than the requester recalled it'; end if;

  perform public.recall_submission(s, 'RQ');
  if (select status from public.form_submissions where id = s) <> 'draft' then
    raise exception 'FAIL: a recalled request is not a draft again';
  end if;
  if exists (select 1 from public.approval_requests where submission_id = s) then
    raise exception 'FAIL: a recalled request still has its chain';
  end if;
  if not exists (select 1 from public.approval_events where subject_id = s and action = 'recalled') then
    raise exception 'FAIL: the recall is not on the trail';
  end if;

  -- Edited and sent again, it gets a fresh chain.
  update public.form_submissions set status = 'submitted' where id = s;
  perform public.build_approval_chain('form_submission', s, 'a0000000-0000-4000-8000-00000000000c');
  perform pg_temp.act(s, 'FI', 'approve');

  refused := false;
  begin perform public.recall_submission(s, 'RQ');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: recalled after an approval'; end if;

  refused := false;
  begin perform public.cancel_submission(s, 'changed my mind', 'RQ');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: cancelled after an approval'; end if;

  reset role;
  raise notice 'pass: only the requester can take a request back, and only before anybody approves';
end $$;

do $$
declare s uuid := 'b0000000-0000-4000-8000-000000000006';
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission', s, 'a0000000-0000-4000-8000-00000000000c');
  perform public.cancel_submission(s, 'Raised by mistake', 'RQ');

  if (select status from public.form_submissions where id = s) <> 'cancelled' then
    raise exception 'FAIL: not cancelled';
  end if;
  if pg_temp.live(s) <> '' then raise exception 'FAIL: % still live after cancelling', pg_temp.live(s); end if;
  if (select count(*) from public.notifications
       where recipient_id = 'FI' and kind = 'request.cancelled' and entity_id = s) <> 1 then
    raise exception 'FAIL: the approver it was with was not told';
  end if;

  reset role;
  raise notice 'pass: cancelling ends a request and tells whoever it was with';
end $$;

-- =====================================================================
-- 8. Approvers ask each other
-- =====================================================================
do $$
declare s uuid := 'b0000000-0000-4000-8000-000000000009'; q uuid; refused boolean;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission', s, 'a0000000-0000-4000-8000-00000000000c');
  perform pg_temp.act(s, 'FI', 'approve');

  q := public.ask_question(s, 'FI', 'Did you check the vendor''s tax certificate?', 'SC');
  if (select count(*) from public.notifications where recipient_id = 'FI' and kind = 'question.asked') <> 1 then
    raise exception 'FAIL: the person asked was not told';
  end if;
  if pg_temp.live(s) <> 'SC' then raise exception 'FAIL: asking a question paused the chain'; end if;

  refused := false;
  begin perform public.ask_question(s, 'FI', 'Who are you?', 'OUT');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: somebody off the chain asked its approvers a question'; end if;

  refused := false;
  begin perform public.ask_question(s, 'OUT', 'Can you check?', 'SC');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: a question went to somebody off the chain'; end if;

  refused := false;
  begin perform public.answer_question(q, 'Yes', 'AD');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: somebody else answered for FI'; end if;

  perform public.answer_question(q, 'Yes — it is on file.', 'FI');
  if (select answer from public.approval_queries where id = q) <> 'Yes — it is on file.' then
    raise exception 'FAIL: the answer was not kept';
  end if;
  if (select count(*) from public.notifications where recipient_id = 'SC' and kind = 'question.answered') <> 1 then
    raise exception 'FAIL: the asker was not told';
  end if;

  refused := false;
  begin perform public.answer_question(q, 'Changed answer', 'FI');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: an answer was overwritten'; end if;

  reset role;
  raise notice 'pass: approvers ask approvers on the same request, answers come back, and the chain does not pause';
end $$;

-- =====================================================================
-- 9. The ticket that follows
-- =====================================================================
do $$
declare s uuid := 'b0000000-0000-4000-8000-000000000010'; f uuid;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission', s, 'a0000000-0000-4000-8000-00000000000e');
  perform pg_temp.act(s, 'FI', 'approve');

  select id into f from public.form_submissions where parent_submission_id = s;
  if f is null then raise exception 'FAIL: no follow-up was started'; end if;
  if (select status from public.form_submissions where id = f) <> 'draft' then
    raise exception 'FAIL: the follow-up should wait as a draft for the requester to send';
  end if;
  if (select submitted_by from public.form_submissions where id = f) <> 'RQ' then
    raise exception 'FAIL: the follow-up is not the requester''s';
  end if;
  if (select value from public.submission_values where submission_id = f and field_name = 'Campaign name') <> 'Eid cashback' then
    raise exception 'FAIL: the shared answer was not carried over';
  end if;
  if exists (select 1 from public.submission_values where submission_id = f and field_name = 'Internal note') then
    raise exception 'FAIL: an answer the follow-up does not ask for was carried over';
  end if;
  if (select count(*) from public.notifications
       where recipient_id = 'RQ' and kind = 'request.followup' and entity_id = f) <> 1 then
    raise exception 'FAIL: the requester was not told about the follow-up';
  end if;

  reset role;
  raise notice 'pass: approval starts the follow-up as a draft, preloaded, and tells the requester';
end $$;

-- =====================================================================
-- 10. The trail cannot be rewritten
-- =====================================================================
do $$
declare n int;
begin
  set local role app_api;
  perform pg_temp.ctx();

  update public.approval_events set comment = 'rewritten';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: % trail entries were rewritten', n; end if;

  delete from public.approval_events;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: % trail entries were deleted', n; end if;

  if (select count(*) from public.approval_events) = 0 then
    raise exception 'FAIL: the engine wrote no trail at all';
  end if;

  reset role;
  raise notice 'pass: the chain''s history can be added to and read, never altered or removed';
end $$;

-- =====================================================================
-- 11. The preview is the chain
--
-- The form's review step shows what preview_approval_chain returns, and
-- the chain that follows is built from the same planner. For the same
-- requester and answers they must agree exactly.
-- =====================================================================
do $$
declare
  v_preview text;
  v_built   text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  -- The clearance: lanes, roles, collapse.
  select string_agg((e->>'step_index') || '.' || (e->>'lane') || '.' || (e->>'lane_step') || '=' || (e->>'approver'), ','
                    order by (e->>'step_index')::int, (e->>'lane')::int, (e->>'lane_step')::int)
    into v_preview
    from jsonb_array_elements(public.preview_approval_chain(
           'a0000000-0000-4000-8000-00000000000a', 'RQ', '{}'::jsonb)) e;
  select string_agg(step_index || '.' || lane || '.' || lane_step || '=' || approver_user_id, ','
                    order by step_index, lane, lane_step)
    into v_built
    from public.approval_requests where submission_id = 'b0000000-0000-4000-8000-000000000003';
  if v_preview is distinct from v_built then
    raise exception 'FAIL: clearance preview % differs from the chain built %', v_preview, v_built;
  end if;

  -- Conditions, from answers that are not stored anywhere yet.
  select string_agg(e->>'approver', ',' order by (e->>'step_index')::int)
    into v_preview
    from jsonb_array_elements(public.preview_approval_chain(
           'a0000000-0000-4000-8000-00000000000d', 'RQ',
           '{"Route": "Exceptional", "Budget": "2,500,000"}'::jsonb)) e;
  if v_preview <> 'CX,IT,FI' then raise exception 'FAIL: exceptional preview is %', v_preview; end if;

  select string_agg(e->>'approver', ',' order by (e->>'step_index')::int)
    into v_preview
    from jsonb_array_elements(public.preview_approval_chain(
           'a0000000-0000-4000-8000-00000000000d', 'RQ',
           '{"Route": "Regular", "Budget": "400000"}'::jsonb)) e;
  if v_preview <> 'FI' then raise exception 'FAIL: regular preview is %', v_preview; end if;

  -- Previewing writes nothing.
  if exists (select 1 from public.approval_requests r
              join public.form_submissions s on s.id = r.submission_id
             where s.form_template_id = 'a0000000-0000-4000-8000-00000000000d'
               and s.id not in ('b0000000-0000-4000-8000-000000000007',
                                'b0000000-0000-4000-8000-000000000008')) then
    raise exception 'FAIL: a preview left steps behind';
  end if;

  reset role;
  raise notice 'pass: the preview is the plan the chain is built from, conditions and lanes included';
end $$;

delete from public.tenants where slug = 'flow-t';

do $$ begin raise notice 'ALL WORKFLOW TESTS PASSED'; end $$;
