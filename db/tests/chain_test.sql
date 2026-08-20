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

insert into public.employees (tenant_id, employee_id, name) values
  (current_setting('t.c')::uuid, 'EMP-LM', 'Line Manager'),
  (current_setting('t.c')::uuid, 'EMP-C1', 'Controller'),
  (current_setting('t.c')::uuid, 'EMP-C2', 'Head of Finance'),
  (current_setting('t.c')::uuid, 'EMP-C3', 'Chief Financial Officer'),
  (current_setting('t.c')::uuid, 'EMP-EX', 'Extra Reviewer');

insert into public.form_templates (id, tenant_id, name, status)
values ('33333333-0000-4000-8000-000000000001', current_setting('t.c')::uuid, 'Claim', 'published');

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

insert into public.form_submissions (id, tenant_id, form_template_id, submitted_by, status) values
  ('44444444-0000-4000-8000-000000000001', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-LM', 'in_progress'),
  ('44444444-0000-4000-8000-000000000002', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-LM', 'in_progress'),
  ('44444444-0000-4000-8000-000000000003', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-LM', 'in_progress'),
  ('44444444-0000-4000-8000-000000000004', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-LM', 'in_progress'),
  ('44444444-0000-4000-8000-000000000005', current_setting('t.c')::uuid,
   '33333333-0000-4000-8000-000000000001', 'EMP-LM', 'in_progress');

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % — got %, want %', label, got, want;
  end if;
  raise notice 'pass: %', label;
end $$;

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
      '33333333-0000-4000-8000-000000000001', 620000), 4);

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
      '33333333-0000-4000-8000-000000000001', 84500), 2);

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
    perform public.act_on_approval(v_id, 'approve', 'jumping the queue');
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
  perform public.act_on_approval(v_id, 'approve', 'Checked');

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
    perform public.act_on_approval(v_id, 'approve', 'Approved');
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
    '33333333-0000-4000-8000-000000000001', 620000);

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000003' and step_index = 0;
  perform public.act_on_approval(v_id, 'approve', null);

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000003' and step_index = 1;
  perform public.act_on_approval(v_id, 'reject', 'Outside policy');

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
    '33333333-0000-4000-8000-000000000001', 84500);

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000004' and step_index = 0;

  perform public.act_on_approval(v_id, 'clarification', 'Which cost centre?');
  select status into v_status from public.form_submissions
   where id = '44444444-0000-4000-8000-000000000004';
  if v_status <> 'on_hold' then raise exception 'FAIL: submission is % not on_hold', v_status; end if;

  perform public.act_on_approval(v_id, 'resume', null);
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

  perform public.reassign_approval(v_id, 'EMP-EX', 'Away this week');

  select approver_user_id, reassigned_from into v_now, v_from
    from public.approval_requests where id = v_id;

  if v_now <> 'EMP-EX' then raise exception 'FAIL: step is with % not EMP-EX', v_now; end if;
  if v_from <> 'EMP-LM' then raise exception 'FAIL: trail says % not EMP-LM', v_from; end if;

  -- Forwarded twice, the trail still names who it was originally asked of.
  perform public.reassign_approval(v_id, 'EMP-C1', 'Also away');
  select reassigned_from into v_from from public.approval_requests where id = v_id;
  if v_from <> 'EMP-LM' then raise exception 'FAIL: second forward lost the original, says %', v_from; end if;

  reset role;
  raise notice 'pass: forwarding moves the step and keeps who it came from';
end $$;

-- =====================================================================
-- 9. A reviewer inserted mid-chain does not strand the rest
-- =====================================================================
do $$
declare v_id uuid; v_total int; v_seq text; v_dupes int;
begin
  set local role app_api;
  perform pg_temp.ctx();

  perform public.build_approval_chain('form_submission',
    '44444444-0000-4000-8000-000000000005',
    '33333333-0000-4000-8000-000000000001', 620000);

  select id into v_id from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000005' and step_index = 0;

  perform public.add_reviewer(v_id, 'EMP-EX', 3);

  select count(*)::int into v_total from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000005';
  if v_total <> 5 then raise exception 'FAIL: % steps after inserting one, expected 5', v_total; end if;

  select string_agg(approver_user_id, ',' order by step_index) into v_seq
    from public.approval_requests
   where submission_id = '44444444-0000-4000-8000-000000000005';
  if v_seq <> 'EMP-LM,EMP-EX,EMP-C1,EMP-C2,EMP-C3' then
    raise exception 'FAIL: order is % after inserting a reviewer', v_seq;
  end if;

  -- Renumbering must leave the indexes contiguous and unique, or the
  -- steps above the insertion are unreachable.
  select count(*)::int into v_dupes from (
    select step_index from public.approval_requests
     where submission_id = '44444444-0000-4000-8000-000000000005'
     group by step_index having count(*) > 1) d;
  if v_dupes <> 0 then raise exception 'FAIL: % duplicated step indexes', v_dupes; end if;

  reset role;
  raise notice 'pass: a reviewer inserted mid-chain renumbers the rest cleanly';
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
    perform public.act_on_approval(v_id, 'approve', null);
    n := n + 1;
    if n > 10 then raise exception 'FAIL: the chain does not terminate'; end if;
  end loop;

  if n <> 5 then raise exception 'FAIL: walked % steps, expected 5', n; end if;

  select status into v_status from public.form_submissions
   where id = '44444444-0000-4000-8000-000000000005';
  if v_status <> 'completed' then raise exception 'FAIL: submission is %', v_status; end if;

  reset role;
  raise notice 'pass: all five steps including the inserted one can be walked';
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
  values (current_setting('app.tenant_id')::uuid, 'Test notice', 'Body', 'General', 'draft', 'EMP-LM')
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
  perform public.act_on_approval(v_id, 'approve', null);

  select current_approver_id into v_current from public.notices where id = v_notice;
  if v_current <> 'EMP-C1' then raise exception 'FAIL: notice did not move on, it is with %', v_current; end if;

  select id into v_id from public.approval_requests
   where notice_id = v_notice and status = 'pending';
  perform public.act_on_approval(v_id, 'approve', null);

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

delete from public.tenants where slug = 'chain-t';

do $$ begin raise notice 'ALL CHAIN TESTS PASSED'; end $$;
