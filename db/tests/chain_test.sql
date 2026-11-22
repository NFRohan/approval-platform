-- =====================================================================
-- Does the chain actually behave like a chain?
--
-- The previous build created every approver's step at once, all pending,
-- with nothing expressing order. It looked like an approval workflow and
-- behaved like a list. So the checks here are all about ORDER: that only
-- one step is open at a time, that a later approver cannot act early,
-- that a rejection stops everything above it, and that the two ways of
-- changing a chain in flight — forwarding a step, inserting a reviewer —
-- leave it walkable rather than stranded.
--
-- IMPORTANT: every check runs after `set local role app_api`, for the
-- same reason the RLS suite does. The owning role carries BYPASSRLS on
-- Neon, so testing as the owner would prove nothing about what the
-- application can actually do.
--
-- Run against a database with 001–006 applied.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- fixtures, written as the owner
-- ---------------------------------------------------------------------
delete from public.tenants where slug = 'chain-t';

insert into public.tenants (name, slug, kind, expires_at)
values ('Chain Tenant', 'chain-t', 'demo', now() + interval '1 day');

select set_config('t.c', (select id::text from public.tenants where slug = 'chain-t'), false);

insert into public.app_users (tenant_id, username, password_hash, full_name)
values (current_setting('t.c')::uuid, 'c.eval', 'x', 'C Evaluator');

select set_config('u.c', (select id::text from public.app_users where username = 'c.eval'), false);

-- Managers before their reports: line_manager_id references an employee
-- of the same tenant.
insert into public.employees (tenant_id, employee_id, name) values
  (current_setting('t.c')::uuid, 'EMP-LM', 'Line Manager'),
  (current_setting('t.c')::uuid, 'EMP-C3', 'Chief Financial Officer');

insert into public.employees (tenant_id, employee_id, name, line_manager_id) values
  (current_setting('t.c')::uuid, 'EMP-C2', 'Head of Finance', 'EMP-C3'),
  (current_setting('t.c')::uuid, 'EMP-EX', 'Extra Reviewer',  'EMP-LM'),
  (current_setting('t.c')::uuid, 'EMP-RQ', 'Requester',       'EMP-LM');

insert into public.employees (tenant_id, employee_id, name, line_manager_id) values
  (current_setting('t.c')::uuid, 'EMP-C1', 'Controller',          'EMP-C2'),
  (current_setting('t.c')::uuid, 'EMP-R2', 'Finance Analyst',     'EMP-C2');

insert into public.form_templates (id, tenant_id, name, status)
values ('33333333-0000-4000-8000-000000000001', current_setting('t.c')::uuid, 'Claim', 'published');

-- The field whose answer decides how far a claim climbs.
insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, order_index)
values (current_setting('t.c')::uuid, '33333333-0000-4000-8000-000000000001', 'money', 'Amount', 0);

-- Line manager first, then however many finance levels the amount reaches.
insert into public.approval_rules
  (tenant_id, subject_type, form_template_id, approver_user_id, deadline_days, label, step_index) values
  (current_setting('t.c')::uuid, 'form_submission', '33333333-0000-4000-8000-000000000001',
   'EMP-LM', 3, 'line_manager', 0),
  (current_setting('t.c')::uuid, 'form_submission', '33333333-0000-4000-8000-000000000001',
   null, 5, 'slab_finance', 1);

insert into public.approval_slabs
  (tenant_id, form_template_id, min_amount, max_amount, approver_user_id, order_index) values
  (current_setting('t.c')::uuid, '33333333-0000-4000-8000-000000000001', 0,         100000, 'EMP-C1', 0),
  (current_setting('t.c')::uuid, '33333333-0000-4000-8000-000000000001', 100000.01, 500000, 'EMP-C2', 1),
  (current_setting('t.c')::uuid, '33333333-0000-4000-8000-000000000001', 500000.01, null,   'EMP-C3', 2);

-- Raised by EMP-RQ, whose line manager is EMP-LM, unless noted. The rule
-- above names EMP-LM too, but only as a fallback: the engine asks the
-- requester's own manager.
insert into public.form_submissions (id, tenant_id, form_template_id, submitted_by, status) values
  ('44444444-0000-4000-8000-000000000001', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-RQ', 'in_progress'),
  ('44444444-0000-4000-8000-000000000002', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-RQ', 'in_progress'),
  ('44444444-0000-4000-8000-000000000003', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-RQ', 'in_progress'),
  ('44444444-0000-4000-8000-000000000004', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-RQ', 'in_progress'),
  ('44444444-0000-4000-8000-000000000005', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-RQ', 'in_progress'),
  ('44444444-0000-4000-8000-000000000006', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-EX', 'in_progress'),
  ('44444444-0000-4000-8000-000000000007', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-EX', 'in_progress'),
  -- 8: a claim whose caller lies about the amount
  ('44444444-0000-4000-8000-000000000008', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-RQ', 'in_progress'),
  -- 9: raised by somebody with a different manager
  ('44444444-0000-4000-8000-000000000009', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-R2', 'in_progress'),
  -- 10: raised by an approver on its own ladder
  ('44444444-0000-4000-8000-000000000010', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-C1', 'in_progress'),
  -- 11: for who may act
  ('44444444-0000-4000-8000-000000000011', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-RQ', 'in_progress');

-- The amounts, as the form stores them: text, sometimes with separators.
insert into public.submission_values (tenant_id, submission_id, field_name, value) values
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000001', 'Amount', '620,000'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000002', 'Amount', '84500'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000003', 'Amount', 'BDT 620000'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000004', 'Amount', '84500'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000005', 'Amount', '620000'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000006', 'Amount', '84500'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000007', 'Amount', '84500'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000008', 'Amount', '620000'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000009', 'Amount', '84500.50'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000010', 'Amount', '620000'),
  (current_setting('t.c')::uuid, '44444444-0000-4000-8000-000000000011', 'Amount', '84500');

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % — got %, want %', label, got, want;
  end if;
  raise notice 'pass: %', label;
end $$;

-- Whoever a step is with: every action names who is acting, and in the
-- ordinary case that is the step's own approver.
create or replace function pg_temp.owner(p_step uuid) returns text
language sql as $$
  select approver_user_id from public.approval_requests where id = p_step
$$;

-- Every block below runs as app_api with a signed-in member's context.
create or replace function pg_temp.ctx() returns void language plpgsql as $$
begin
  perform set_config('app.tenant_id', current_setting('t.c'), true),
          set_config('app.user_id',   current_setting('u.c'), true),
          set_config('app.role',      'admin', true),
          set_config('app.is_staff',  'false', true);
end $$;

-- =====================================================================
-- 1. A large claim escalates cumulatively
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();

  select pg_temp.check('620,000 builds four steps',
    public.build_approval_chain('form_submission',
      '44444444-0000-4000-8000-000000000001',
      '33333333-0000-4000-8000-000000000001'), 4);

  select pg_temp.check('the order is line manager, controller, head, CFO',
    (select string_agg(approver_user_id, ',' order by step_index)
       from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000001'),
    'EMP-LM,EMP-C1,EMP-C2,EMP-C3'::text);

  select pg_temp.check('only the first step is open',
    (select count(*)::int from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000001'
        and status = 'pending'), 1);

  select pg_temp.check('...and it is step 0',
    (select step_index from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000001'
        and status = 'pending'), 0);

  select pg_temp.check('the rest are waiting',
    (select count(*)::int from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000001'
        and status = 'waiting'), 3);
commit;

-- =====================================================================
-- 2. A small claim involves one finance level, not three
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();

  select pg_temp.check('84,500 builds two steps',
    public.build_approval_chain('form_submission',
      '44444444-0000-4000-8000-000000000002',
      '33333333-0000-4000-8000-000000000001'), 2);

  select pg_temp.check('and stops at the controller',
    (select string_agg(approver_user_id, ',' order by step_index)
       from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000002'),
    'EMP-LM,EMP-C1'::text);
commit;

-- =====================================================================
-- 3. A later approver cannot act before it is their turn.
--    This is the case the previous build got wrong.
-- =====================================================================
do $$
declare ok boolean := false; v_id uuid;
begin
  set local role app_api;
  perform pg_temp.ctx();

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000001' and step_index = 3;

  begin
    perform public.act_on_approval(v_id, 'approve', 'jumping the queue', pg_temp.owner(v_id));
  exception when others then ok := true;
  end;

  reset role;
  if not ok then raise exception 'FAIL: the CFO approved before the line manager'; end if;
  raise notice 'pass: a waiting step cannot be acted on';
end $$;

-- =====================================================================
-- 4. Approving promotes exactly the next step
-- =====================================================================
do $$
declare v_id uuid; v_open int; v_next text; v_status text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000001' and step_index = 0;
  perform public.act_on_approval(v_id, 'approve', 'Checked', pg_temp.owner(v_id));

  select count(*)::int into v_open from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000001' and status = 'pending';
  if v_open <> 1 then raise exception 'FAIL: % steps open after approving one', v_open; end if;

  select approver_user_id into v_next from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000001' and status = 'pending';
  if v_next <> 'EMP-C1' then raise exception 'FAIL: the controller is not next, % is', v_next; end if;

  select status into v_status from public.form_submissions
   where id = '44444444-0000-4000-8000-000000000001';
  if v_status <> 'in_progress' then raise exception 'FAIL: submission is %', v_status; end if;

  reset role;
  raise notice 'pass: approving opens the next step and only that one';
end $$;

-- =====================================================================
-- 5. Walking the whole chain finishes the submission
-- =====================================================================
do $$
declare v_id uuid; n int := 0; v_status text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  loop
    select id into v_id from public.approval_requests
     where submission_id = '44444444-0000-4000-8000-000000000001' and status = 'pending';
    exit when v_id is null;
    perform public.act_on_approval(v_id, 'approve', 'Approved', pg_temp.owner(v_id));
    n := n + 1;
    if n > 10 then raise exception 'FAIL: the chain does not terminate'; end if;
  end loop;

  select status into v_status from public.form_submissions
   where id = '44444444-0000-4000-8000-000000000001';
  if v_status <> 'completed' then raise exception 'FAIL: submission is % not completed', v_status; end if;

  reset role;
  raise notice 'pass: three more approvals complete the 620,000 claim';
end $$;

-- =====================================================================
-- 6. A rejection stops the chain, and says who was never asked
-- =====================================================================
do $$
declare v_id uuid; v_skipped int; v_status text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission',
    '44444444-0000-4000-8000-000000000003',
    '33333333-0000-4000-8000-000000000001');

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000003' and step_index = 0;
  perform public.act_on_approval(v_id, 'approve', null, pg_temp.owner(v_id));

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000003' and step_index = 1;
  perform public.act_on_approval(v_id, 'reject', 'Outside policy', pg_temp.owner(v_id));

  select count(*)::int into v_skipped from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000003' and status = 'skipped';
  if v_skipped <> 2 then raise exception 'FAIL: % steps skipped, expected 2', v_skipped; end if;

  if exists (select 1 from public.approval_requests
              where submission_id = '44444444-0000-4000-8000-000000000003'
                and status = 'pending') then
    raise exception 'FAIL: a step is still open after a rejection';
  end if;

  select status into v_status from public.form_submissions
   where id = '44444444-0000-4000-8000-000000000003';
  if v_status <> 'rejected' then raise exception 'FAIL: submission is %', v_status; end if;

  reset role;
  raise notice 'pass: a rejection halts the chain and marks the rest skipped';
end $$;

-- =====================================================================
-- 7. Clarification pauses, and the chain picks up where it stopped
-- =====================================================================
do $$
declare v_id uuid; v_status text; v_step int;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission',
    '44444444-0000-4000-8000-000000000004',
    '33333333-0000-4000-8000-000000000001');

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000004' and step_index = 0;

  perform public.act_on_approval(v_id, 'clarification', 'Which cost centre?', pg_temp.owner(v_id));
  select status into v_status from public.form_submissions
   where id = '44444444-0000-4000-8000-000000000004';
  if v_status <> 'on_hold' then raise exception 'FAIL: submission is % not on_hold', v_status; end if;

  perform public.act_on_approval(v_id, 'resume', null, pg_temp.owner(v_id));
  select step_index into v_step from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000004' and status = 'pending';
  if v_step <> 0 then raise exception 'FAIL: resumed at step % not 0', v_step; end if;

  reset role;
  raise notice 'pass: clarification pauses the chain and resume restores it';
end $$;

-- =====================================================================
-- 8. Forwarding a step keeps the trail
-- =====================================================================
do $$
declare v_id uuid; v_now text; v_from text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000004' and step_index = 0;

  perform public.reassign_approval(v_id, 'EMP-EX', 'Away this week', pg_temp.owner(v_id));

  select approver_user_id, reassigned_from into v_now, v_from
    from public.approval_requests where id = v_id;

  if v_now <> 'EMP-EX' then raise exception 'FAIL: step is with % not EMP-EX', v_now; end if;
  if v_from <> 'EMP-LM' then raise exception 'FAIL: trail says % not EMP-LM', v_from; end if;

  -- Forwarded twice, the trail still names who it was originally asked of.
  perform public.reassign_approval(v_id, 'EMP-C1', 'Also away', pg_temp.owner(v_id));
  select reassigned_from into v_from from public.approval_requests where id = v_id;
  if v_from <> 'EMP-LM' then raise exception 'FAIL: second forward lost the original, says %', v_from; end if;

  reset role;
  raise notice 'pass: forwarding moves the step and keeps who it came from';
end $$;

-- =====================================================================
-- 9. A reviewer is asked before the approver who asked for them
--    "An approver should be able to add reviewer to review the ticket
--    before s/he gives approval."
-- =====================================================================
do $$
declare v_id uuid; v_rev uuid; v_total int; v_seq text; v_dupes int; v_live text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission',
    '44444444-0000-4000-8000-000000000005',
    '33333333-0000-4000-8000-000000000001');

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000005' and step_index = 0;

  v_rev := public.add_reviewer(v_id, 'EMP-EX', 3, pg_temp.owner(v_id));

  select count(*)::int into v_total from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000005';
  if v_total <> 5 then raise exception 'FAIL: % steps after inserting one, expected 5', v_total; end if;

  select string_agg(approver_user_id, ',' order by step_index, lane, lane_step) into v_seq
    from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000005';
  if v_seq <> 'EMP-EX,EMP-LM,EMP-C1,EMP-C2,EMP-C3' then
    raise exception 'FAIL: order is % after adding a reviewer', v_seq;
  end if;

  select approver_user_id into v_live from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000005' and status = 'pending';
  if v_live <> 'EMP-EX' then raise exception 'FAIL: the live step is with % not the reviewer', v_live; end if;
  if (select status from public.approval_requests where id = v_id) <> 'waiting' then
    raise exception 'FAIL: the approver who asked for a review is not waiting for it';
  end if;

  -- Positions stay unique, or a step behind the insertion is unreachable.
  select count(*)::int into v_dupes from (
    select step_index, lane, lane_step from public.approval_requests
     where submission_id = '44444444-0000-4000-8000-000000000005'
     group by step_index, lane, lane_step having count(*) > 1) d;
  if v_dupes <> 0 then raise exception 'FAIL: % duplicated positions', v_dupes; end if;

  -- When the reviewer passes it on, it comes back to the approver.
  perform public.act_on_approval(v_rev, 'approve', 'Figures check out', 'EMP-EX');
  select approver_user_id into v_live from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000005' and status = 'pending';
  if v_live <> 'EMP-LM' then raise exception 'FAIL: after review it went to % not back to EMP-LM', v_live; end if;

  reset role;
  raise notice 'pass: a reviewer is asked first, and the request comes back to the approver after';
end $$;

-- The whole chain is still walkable after the insertion — the real
-- question, since renumbering is where a chain gets stranded.
do $$
declare v_id uuid; n int := 0; v_status text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  loop
    select id into v_id from public.approval_requests
     where submission_id = '44444444-0000-4000-8000-000000000005' and status = 'pending';
    exit when v_id is null;
    perform public.act_on_approval(v_id, 'approve', null, pg_temp.owner(v_id));
    n := n + 1;
    if n > 10 then raise exception 'FAIL: the chain does not terminate'; end if;
  end loop;

  if n <> 4 then raise exception 'FAIL: walked % more steps, expected 4', n; end if;

  select status into v_status from public.form_submissions
   where id = '44444444-0000-4000-8000-000000000005';
  if v_status <> 'completed' then raise exception 'FAIL: submission is %', v_status; end if;

  reset role;
  raise notice 'pass: the rest of the chain is walkable after the review';
end $$;

-- =====================================================================
-- 10. The same engine runs a notice, and tracks who it is with
-- =====================================================================
do $$
declare v_notice uuid; v_id uuid; v_current text; v_status text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  insert into public.notices (tenant_id, title, content, category, status, created_by)
  values (current_setting('app.tenant_id')::uuid, 'Test notice', 'Body', 'General', 'draft', 'EMP-RQ')
  returning id into v_notice;

  insert into public.approval_rules
    (tenant_id, subject_type, form_template_id, approver_user_id, deadline_days, label, step_index)
  values (current_setting('app.tenant_id')::uuid, 'notice', null, 'EMP-LM', 2, 'line_manager', 0),
         (current_setting('app.tenant_id')::uuid, 'notice', null, 'EMP-C1', 3, 'admin', 1);

  if public.build_approval_chain('notice', v_notice) <> 2 then
    raise exception 'FAIL: a notice chain is not two steps';
  end if;

  select current_approver_id into v_current from public.notices where id = v_notice;
  if v_current <> 'EMP-LM' then raise exception 'FAIL: notice is with % not EMP-LM', v_current; end if;

  select id into v_id from public.approval_requests
   where notice_id = v_notice and status = 'pending';
  perform public.act_on_approval(v_id, 'approve', null, pg_temp.owner(v_id));

  select current_approver_id into v_current from public.notices where id = v_notice;
  if v_current <> 'EMP-C1' then raise exception 'FAIL: notice did not move on, it is with %', v_current; end if;

  select id into v_id from public.approval_requests
   where notice_id = v_notice and status = 'pending';
  perform public.act_on_approval(v_id, 'approve', null, pg_temp.owner(v_id));

  select status, current_approver_id into v_status, v_current
    from public.notices where id = v_notice;
  if v_status <> 'published' then raise exception 'FAIL: notice is % not published', v_status; end if;
  if v_current is not null then raise exception 'FAIL: a finished notice is still with somebody'; end if;

  reset role;
  raise notice 'pass: a notice walks the same chain and publishes at the end';
end $$;

-- =====================================================================
-- 11. A step belongs to exactly one subject
-- =====================================================================
do $$
declare ok boolean := false;
begin
  set local role app_api;
  perform pg_temp.ctx();

  begin
    insert into public.approval_requests (approver_user_id, step_index, status)
    values ('EMP-LM', 0, 'pending');
  exception when others then ok := true;
  end;

  reset role;
  if not ok then raise exception 'FAIL: a step was created with no subject'; end if;
  raise notice 'pass: a step with no subject is refused';
end $$;

-- =====================================================================
-- 12. Targets fall on working days — Bangladesh's, on Dhaka's calendar
-- =====================================================================
begin;
  set local role app_api;
  set local timezone = 'Asia/Dhaka';
  select pg_temp.ctx();

  -- 20 August 2026 is a Thursday. Friday and Saturday are the weekend,
  -- so three working days is Sunday, Monday, Tuesday.
  select pg_temp.check('three working days from a Thursday lands on Tuesday',
    to_char(app.add_working_days(timestamptz '2026-08-20 09:00+06', 3), 'Dy'), 'Tue'::text);

  select pg_temp.check('a Sunday counts as a working day',
    to_char(app.add_working_days(timestamptz '2026-08-20 09:00+06', 1), 'Dy'), 'Sun'::text);

  select pg_temp.check('no target ever lands on a Friday or a Saturday',
    (select count(*)::int from generate_series(1, 20) g
      where extract(isodow from app.add_working_days(timestamptz '2026-08-20 09:00+06', g))
            in (5, 6)), 0);

  -- 02:00 on Saturday in Dhaka is 20:00 on Friday in UTC. One working
  -- day on is Sunday 02:00 in Dhaka. Judged in UTC it would skip the UTC
  -- Saturday and land on Sunday 20:00 UTC — Monday in Dhaka.
  select pg_temp.check('the day is the one in Dhaka, not in UTC',
    to_char(app.add_working_days(timestamptz '2026-08-22 02:00+06', 1), 'Dy'), 'Sun'::text);
commit;

-- =====================================================================
-- 13. The chain tells the person whose turn it is
-- =====================================================================
do $$
declare
  v_id  uuid;
  n     int;
begin
  set local role app_api;
  perform pg_temp.ctx();

  delete from public.notifications;   -- start from a known count

  perform public.build_approval_chain('form_submission',
    '44444444-0000-4000-8000-000000000006',
    '33333333-0000-4000-8000-000000000001');

  select count(*)::int into n from public.notifications
   where recipient_id = 'EMP-LM' and kind = 'approval.turn'
     and entity_id = '44444444-0000-4000-8000-000000000006';
  if n <> 1 then raise exception 'FAIL: step zero approver got % turn notices, expected 1', n; end if;

  -- the approver two steps up must NOT be told yet
  select count(*)::int into n from public.notifications where recipient_id = 'EMP-C1';
  if n <> 0 then raise exception 'FAIL: a waiting approver was notified early'; end if;

  reset role;
  raise notice 'pass: building a chain tells only the first approver';
end $$;

do $$
declare v_id uuid; n int;
begin
  set local role app_api;
  perform pg_temp.ctx();

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000006' and status = 'pending';
  perform public.act_on_approval(v_id, 'approve', null, pg_temp.owner(v_id));

  select count(*)::int into n from public.notifications
   where recipient_id = 'EMP-C1' and kind = 'approval.turn';
  if n <> 1 then raise exception 'FAIL: the next approver was not told, got %', n; end if;

  reset role;
  raise notice 'pass: approving hands the notification to the next approver';
end $$;

do $$
declare v_id uuid; n int;
begin
  set local role app_api;
  perform pg_temp.ctx();

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000006' and status = 'pending';
  perform public.act_on_approval(v_id, 'approve', null, pg_temp.owner(v_id));

  -- EMP-EX raised this one, so EMP-EX hears that it finished
  select count(*)::int into n from public.notifications
   where recipient_id = 'EMP-EX' and kind = 'request.completed';
  if n <> 1 then raise exception 'FAIL: the requester was not told it completed, got %', n; end if;

  reset role;
  raise notice 'pass: finishing a chain tells whoever raised it';
end $$;

-- =====================================================================
-- 14. An overdue step produces one reminder, not one per call
-- =====================================================================
do $$
declare first_run int; second_run int; n int;
begin
  set local role app_api;
  perform pg_temp.ctx();

  delete from public.notifications;

  perform public.build_approval_chain('form_submission',
    '44444444-0000-4000-8000-000000000007',
    '33333333-0000-4000-8000-000000000001');

  -- backdate the live step so it is genuinely overdue
  update public.approval_requests
     set deadline_at = now() - interval '2 days'
   where submission_id = '44444444-0000-4000-8000-000000000007' and status = 'pending';

  first_run  := public.remind_overdue();
  second_run := public.remind_overdue();

  if first_run < 1 then raise exception 'FAIL: an overdue step produced no reminder'; end if;
  if second_run <> 0 then
    raise exception 'FAIL: calling twice produced % more reminders', second_run;
  end if;

  select count(*)::int into n from public.notifications where kind = 'approval.overdue';
  if n <> first_run then raise exception 'FAIL: % reminders stored, % reported', n, first_run; end if;

  reset role;
  raise notice 'pass: overdue reminders fire once per day, not once per page load';
end $$;

-- =====================================================================
-- 15. The amount is the submission's own, not the caller's
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();

  select pg_temp.check('a stored 620,000 called as 50 still climbs to the CFO',
    public.build_approval_chain('form_submission',
      '44444444-0000-4000-8000-000000000008',
      '33333333-0000-4000-8000-000000000001', 50), 4);

  select pg_temp.check('separators and a currency mark are read through',
    app.submission_amount('44444444-0000-4000-8000-000000000003'), 620000::numeric);
commit;

-- =====================================================================
-- 16. "Line manager" means the requester's own
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();

  -- EMP-R2 reports to EMP-C2, so the first step is EMP-C2 — not the
  -- EMP-LM named on the rule, which is only a fallback.
  select pg_temp.check('an 84,500.50 claim from EMP-R2 is two steps',
    public.build_approval_chain('form_submission',
      '44444444-0000-4000-8000-000000000009',
      '33333333-0000-4000-8000-000000000001'), 2);

  select pg_temp.check('the requester''s own line manager first, then finance',
    (select string_agg(approver_user_id, ',' order by step_index)
       from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000009'),
    'EMP-C2,EMP-C1'::text);
commit;

-- =====================================================================
-- 17. Nobody approves their own request, and one person is one step
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();

  -- EMP-C1 raises a 620,000 claim. The candidates are their manager
  -- EMP-C2, then the ladder C1, C2, C3. C1 is the requester and drops
  -- out; that leaves C2 twice in a row, which is one step.
  select public.build_approval_chain('form_submission',
    '44444444-0000-4000-8000-000000000010',
    '33333333-0000-4000-8000-000000000001');

  select pg_temp.check('the requester is never one of the approvers',
    (select count(*)::int from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000010'
        and approver_user_id = 'EMP-C1'), 0);

  select pg_temp.check('the same person twice in a row is one step',
    (select string_agg(approver_user_id, ',' order by step_index)
       from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000010'),
    'EMP-C2,EMP-C3'::text);

  select pg_temp.check('...numbered without gaps',
    (select string_agg(step_index::text, ',' order by step_index)
       from public.approval_requests
      where submission_id = '44444444-0000-4000-8000-000000000010'),
    '0,1'::text);
commit;

-- =====================================================================
-- 18. Only the approver, or somebody they delegated to, may act
-- =====================================================================
do $$
declare v_id uuid; refused boolean;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission',
    '44444444-0000-4000-8000-000000000011',
    '33333333-0000-4000-8000-000000000001');
  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000011' and status = 'pending';
  if pg_temp.owner(v_id) <> 'EMP-LM' then
    raise exception 'FAIL: fixture assumption — the open step is with %', pg_temp.owner(v_id);
  end if;

  refused := false;
  begin
    perform public.act_on_approval(v_id, 'approve', null, null);
  exception when others then refused := true;
  end;
  if not refused then raise exception 'FAIL: a step moved with nobody named as acting'; end if;

  refused := false;
  begin
    perform public.act_on_approval(v_id, 'approve', null, 'EMP-C3');
  exception when others then refused := true;
  end;
  if not refused then raise exception 'FAIL: a stranger approved somebody else''s step'; end if;

  refused := false;
  begin
    perform public.reassign_approval(v_id, 'EMP-C1', null, 'EMP-C3');
  exception when others then refused := true;
  end;
  if not refused then raise exception 'FAIL: a stranger forwarded somebody else''s step'; end if;

  refused := false;
  begin
    perform public.add_reviewer(v_id, 'EMP-C1', 3, 'EMP-C3');
  exception when others then refused := true;
  end;
  if not refused then raise exception 'FAIL: a stranger added a reviewer to somebody else''s step'; end if;

  -- A delegation that ended yesterday does not count.
  insert into public.delegation_rules (delegator_id, delegate_id, start_date, end_date, reason)
  values ('EMP-LM', 'EMP-C3',
          (now() at time zone 'Asia/Dhaka')::date - 10,
          (now() at time zone 'Asia/Dhaka')::date - 1, 'Leave, over');
  refused := false;
  begin
    perform public.act_on_approval(v_id, 'approve', null, 'EMP-C3');
  exception when others then refused := true;
  end;
  if not refused then raise exception 'FAIL: an expired delegation was honoured'; end if;

  -- A delegation scoped to another form does not carry this one.
  insert into public.delegation_rules
    (delegator_id, delegate_id, start_date, end_date, reason, form_template_ids)
  values ('EMP-LM', 'EMP-C2',
          (now() at time zone 'Asia/Dhaka')::date - 1,
          (now() at time zone 'Asia/Dhaka')::date + 1, 'Leave, other forms',
          array[gen_random_uuid()]);
  refused := false;
  begin
    perform public.act_on_approval(v_id, 'approve', null, 'EMP-C2');
  exception when others then refused := true;
  end;
  if not refused then raise exception 'FAIL: a delegation for another form was honoured'; end if;

  -- One that is current and covers this form does.
  insert into public.delegation_rules
    (delegator_id, delegate_id, start_date, end_date, reason, form_template_ids)
  values ('EMP-LM', 'EMP-EX',
          (now() at time zone 'Asia/Dhaka')::date,
          (now() at time zone 'Asia/Dhaka')::date, 'Out today',
          array['33333333-0000-4000-8000-000000000001'::uuid]);
  perform public.act_on_approval(v_id, 'approve', 'On EMP-LM''s behalf', 'EMP-EX');

  if (select status from public.approval_requests where id = v_id) <> 'approved' then
    raise exception 'FAIL: a current, in-scope delegate could not approve';
  end if;

  reset role;
  raise notice 'pass: nobody unnamed, no stranger, no expired or out-of-scope delegate may act';
  raise notice 'pass: a current delegate covering the form may';
end $$;

delete from public.tenants where slug = 'chain-t';

do $$ begin raise notice 'ALL CHAIN TESTS PASSED'; end $$;
