-- =====================================================================
-- Reports, analytics and email.
--
-- Against the seeded template, as its people: the history the analytics
-- read, the report views and who may see them, report templates and
-- their column-change approvals, every notification becoming an email,
-- and the daily round of reminders and escalation.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on


-- On a copy of the template, which is deleted at the end: these checks
-- change what they check, and against a shared database the template is
-- what every new evaluation is cloned from.
select set_config('app.is_staff', 'true', false);
select set_config('t.tpl', (select tenant_id::text from app.provision_demo(
  'Reports Test', 'reports.test.' || substr(md5(random()::text), 1, 8), 'hash', interval '1 day')), false);
select set_config('app.is_staff', 'false', false);
select set_config('app.no_mail', 'false', false);
-- Another organisation, to check the views keep to their own.
delete from public.tenants where slug = 'rep-other';
insert into public.tenants (name, slug, kind, expires_at) values ('Other', 'rep-other', 'demo', now() + interval '1 day');
insert into public.employees (tenant_id, employee_id, name, department)
select id, 'EMP-0445', 'Other Farah', 'Admin' from public.tenants where slug = 'rep-other';
insert into public.form_templates (tenant_id, name, status)
select id, 'Other form', 'published' from public.tenants where slug = 'rep-other';
insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status)
select t.id, f.id, 'EMP-0445', 'submitted'
  from public.tenants t join public.form_templates f on f.tenant_id = t.id where t.slug = 'rep-other';

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL: % — got %, want %', label, got, want; end if;
  raise notice 'pass: %', label;
end $$;

create or replace function pg_temp.as_emp(p_emp text) returns void language plpgsql as $$
begin
  perform set_config('app.tenant_id',   current_setting('t.tpl'), true),
          set_config('app.user_id',     '00000000-0000-4000-8000-0000000000aa', true),
          set_config('app.role',        'admin', true),
          set_config('app.is_staff',    'false', true),
          set_config('app.employee_id', coalesce(p_emp, ''), true),
          set_config('app.mfa',         'true', true);
end $$;

create or replace function pg_temp.refused(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $$;

-- =====================================================================
-- 1. History, and the views over it
-- =====================================================================
do $$
declare v record;
begin
  select count(*) filter (where status = 'completed') completed,
         count(*) filter (where status = 'rejected')  rejected,
         count(*) filter (where status = 'in_progress') open,
         count(*) total
    into v from public.form_submissions where tenant_id = current_setting('t.tpl')::uuid;
  if v.total < 150 or v.completed < 100 or v.rejected < 5 or v.open < 3 then
    raise exception 'FAIL: the history is thin: %', row_to_json(v);
  end if;
  raise notice 'pass: the template carries months of decided and open requests';

  if (select min(submitted_at) from public.form_submissions where tenant_id = current_setting('t.tpl')::uuid)
       > now() - interval '120 days' then
    raise exception 'FAIL: the history does not reach back months';
  end if;
  raise notice 'pass: ...spread over months';

  if not exists (select 1 from public.report_steps
                  where tenant_id = current_setting('t.tpl')::uuid and on_time = false and acted_at is not null) then
    raise exception 'FAIL: nobody was ever late, which is not a demonstration of SLA tracking';
  end if;
  if not exists (select 1 from public.report_steps where tenant_id = current_setting('t.tpl')::uuid and overdue) then
    raise exception 'FAIL: nothing is overdue now';
  end if;
  raise notice 'pass: some approvals were late, and some are overdue now';
end $$;

begin;
  set local role app_api;
  select pg_temp.as_emp('EMP-0830');
  select pg_temp.check('the request view shows every raised request, and only this organisation''s',
    (select count(*)::int from public.report_requests),
    (select count(*)::int from public.form_submissions where tenant_id = current_setting('t.tpl')::uuid and status <> 'draft'));
  select pg_temp.check('a decided request has a cycle time',
    (select bool_and(cycle_days is not null) from public.report_requests where status = 'completed'), true);
  select pg_temp.check('money requests carry their amount',
    (select count(*) > 0 from public.report_requests where amount > 0), true);
commit;

-- =====================================================================
-- 2. Who may read reports
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.as_emp('EMP-2847');   -- Tom: no reporting role
  select pg_temp.check('somebody without reports.view sees no report templates',
    (select count(*)::int from public.report_templates), 0);
  select pg_temp.as_emp('EMP-0830');   -- Lena: Compliance auditor
  select pg_temp.check('...a compliance auditor sees the standard seven',
    (select count(*)::int from public.report_templates where standard), 7);
commit;

-- =====================================================================
-- 3. Templates: admins keep them, others ask for column changes
-- =====================================================================
do $$
declare v_id uuid; v_std uuid;
begin
  set local role app_api;
  perform pg_temp.as_emp('EMP-0830');
  if not pg_temp.refused($q$select public.save_report(null, 'Mine', null, 'requests', array['reference'], '{}')$q$) then
    raise exception 'FAIL: somebody without reports.manage created a report';
  end if;

  perform pg_temp.as_emp('EMP-0445');   -- Farah: System administrator
  v_id := public.save_report(null, 'By department', 'Counts', 'requests', array['reference', 'department'], '{"period": "all"}');

  -- Lena asks for another column; it waits, and the report is unchanged.
  perform pg_temp.as_emp('EMP-0830');
  perform public.request_report_change(v_id, array['reference', 'department', 'status'], 'Need the outcome');
  if (select columns from public.report_templates where id = v_id) <> array['reference', 'department'] then
    raise exception 'FAIL: a requested column change took effect before approval';
  end if;
  if not pg_temp.refused(format($q$select public.decide_report_change(%L, true)$q$, v_id)) then
    raise exception 'FAIL: somebody without reports.manage approved a column change';
  end if;
  perform pg_temp.as_emp('EMP-0445');
  perform public.decide_report_change(v_id, true);
  if (select columns from public.report_templates where id = v_id) <> array['reference', 'department', 'status'] then
    raise exception 'FAIL: an approved column change did not take effect';
  end if;

  -- An admin's own request is decided by another admin.
  perform public.request_report_change(v_id, array['reference'], null);
  if not pg_temp.refused(format($q$select public.decide_report_change(%L, true)$q$, v_id)) then
    raise exception 'FAIL: whoever asked for a column change approved it';
  end if;

  select id into v_std from public.report_templates where standard and name = 'Open approvals';
  if not pg_temp.refused(format($q$select public.delete_report(%L)$q$, v_std)) then
    raise exception 'FAIL: a standard report was deleted';
  end if;
  if not pg_temp.refused(format($q$select public.set_report_schedule(%L, 'weekly', array['NOBODY'], 'xlsx')$q$, v_id)) then
    raise exception 'FAIL: a report was scheduled to somebody who does not work here';
  end if;
  reset role;
  raise notice 'pass: admins keep report templates; others ask for column changes, which wait for an admin who did not ask';
  raise notice 'pass: standard reports cannot be deleted, and schedules go to people who work here';
end $$;

-- =====================================================================
-- 4. Every notification is an email
-- =====================================================================
do $$
declare v_before int; v record;
begin
  set local role app_api;
  perform pg_temp.as_emp('EMP-1134');
  select count(*) into v_before from public.email_outbox where tenant_id = current_setting('t.tpl')::uuid;
  perform app.notify('EMP-2847', 'note.added', 'A note was added', 'Sam added a note', 'form_submission', gen_random_uuid());
  reset role;
  select * into v from public.email_outbox where tenant_id = current_setting('t.tpl')::uuid order by created_at desc limit 1;
  if v.kind <> 'note.added' or v.status <> 'queued' or v.to_address <> 'tom.bexley@example.com' or v.context->>'title' <> 'A note was added' then
    raise exception 'FAIL: the notification was not queued as an email to the work address: %', row_to_json(v);
  end if;
  raise notice 'pass: a notification is queued as an email to the person''s work address';

  update public.employees set email = null where tenant_id = current_setting('t.tpl')::uuid and employee_id = 'EMP-9001';
  set local role app_api;
  perform pg_temp.as_emp('EMP-1134');
  perform app.notify('EMP-9001', 'note.added', 'A note was added', null, null, null);
  reset role;
  if (select status from public.email_outbox where tenant_id = current_setting('t.tpl')::uuid and recipient_id = 'EMP-9001' order by created_at desc limit 1) <> 'skipped' then
    raise exception 'FAIL: an email with nobody to send it to was not marked skipped';
  end if;
  raise notice 'pass: somebody with no work email is logged as skipped, not lost';

  set local role app_api;
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused($q$select public.save_email_template('note.added', 'x', 'y', false)$q$) then
    raise exception 'FAIL: somebody without notifications.manage changed an email template';
  end if;
  perform pg_temp.as_emp('EMP-0445');
  perform public.save_email_template('note.added', 'New note on {{ref}}', 'Hello {{recipient_name}}', false);
  select count(*) into v_before from public.email_outbox where tenant_id = current_setting('t.tpl')::uuid;
  perform app.notify('EMP-2847', 'note.added', 'Another note', null, null, null);
  reset role;
  if (select count(*) from public.email_outbox where tenant_id = current_setting('t.tpl')::uuid) <> v_before then
    raise exception 'FAIL: a kind switched off still sent email';
  end if;
  raise notice 'pass: email wording is kept per organisation, and a kind can be switched off';

  set local role app_api;
  perform pg_temp.as_emp('EMP-0445');
  perform public.queue_report_email((select id from public.report_templates where name = 'Open approvals'), array['EMP-0600', 'EMP-0700']);
  reset role;
  if (select count(*) from public.email_outbox where tenant_id = current_setting('t.tpl')::uuid and kind = 'report.sent' and status = 'queued') <> 2 then
    raise exception 'FAIL: sending a report did not queue an email per recipient';
  end if;
  raise notice 'pass: a report can be emailed to people now';
end $$;

-- Scheduled reports are queued once per period.
do $$
declare n1 int; n2 int;
begin
  update public.report_templates set last_sent_at = null where tenant_id = current_setting('t.tpl')::uuid;
  n1 := app.queue_due_reports(current_setting('t.tpl')::uuid);
  n2 := app.queue_due_reports(current_setting('t.tpl')::uuid);
  if n1 < 2 or n2 <> 0 then raise exception 'FAIL: scheduled reports queued % then %', n1, n2; end if;
  raise notice 'pass: scheduled reports are queued when due, and not again until the next period';
end $$;

-- =====================================================================
-- 5. The daily round
-- =====================================================================
do $$
declare v jsonb; v2 jsonb; v_step uuid;
begin
  perform pg_temp.as_emp(null);
  -- One step due within the day.
  select id into v_step from public.approval_requests
   where tenant_id = current_setting('t.tpl')::uuid and status = 'pending' limit 1;
  update public.approval_requests set deadline_at = now() + interval '3 hours' where id = v_step;

  v := app.daily_reminders();
  v2 := app.daily_reminders();
  if (v->>'due_soon')::int < 1 or (v->>'escalated')::int < 1 then
    raise exception 'FAIL: the daily round did nothing: %', v;
  end if;
  if (v2->>'due_soon')::int <> 0 or (v2->>'escalated')::int <> 0 then
    raise exception 'FAIL: the daily round repeated itself: %', v2;
  end if;
  if not exists (select 1 from public.notifications n
                   join public.approval_requests ar on ar.subject_id = n.entity_id and ar.status = 'pending'
                   join public.employees e on e.employee_id = ar.approver_user_id and e.tenant_id = ar.tenant_id
                  where n.tenant_id = current_setting('t.tpl')::uuid and n.kind = 'approval.escalated'
                    and n.recipient_id = e.line_manager_id) then
    raise exception 'FAIL: an escalation did not go to the approver''s line manager';
  end if;
  raise notice 'pass: a step due within a day reminds its approver, once';
  raise notice 'pass: a step two working days overdue is escalated to the approver''s manager, once';
end $$;

-- The SLA timing a step sets for itself (SOW 2.1 "after breach SLA or
-- before SLA. It can be configured").
do $$
declare v_step uuid; v_appr text; v_m1 text; v_m2 text; v jsonb; v_sub uuid;
begin
  perform pg_temp.as_emp(null);
  -- A pending step whose approver has a manager who has a manager.
  select ar.id, ar.approver_user_id, e.line_manager_id, m.line_manager_id, ar.subject_id
    into v_step, v_appr, v_m1, v_m2, v_sub
    from public.approval_requests ar
    join public.employees e on e.tenant_id = ar.tenant_id and e.employee_id = ar.approver_user_id
    join public.employees m on m.tenant_id = ar.tenant_id and m.employee_id = e.line_manager_id
   where ar.tenant_id = current_setting('t.tpl')::uuid and ar.status = 'pending'
     and m.line_manager_id is not null and m.line_manager_id <> ar.approver_user_id
     and not exists (select 1 from public.notifications n
                      where n.tenant_id = ar.tenant_id and n.entity_id = ar.subject_id
                        and n.kind in ('approval.escalated', 'approval.due_soon'))
   limit 1;
  if v_step is null then raise exception 'FAIL: no step with two managers above its approver to test with'; end if;

  -- Before: warnings off, so a step due in three hours says nothing.
  update public.approval_requests
     set deadline_at = now() + interval '3 hours', warn_hours = 0 where id = v_step;
  perform app.daily_reminders();
  if exists (select 1 from public.notifications where entity_id = v_sub and kind = 'approval.due_soon') then
    raise exception 'FAIL: a step with warnings off still warned';
  end if;
  -- A 48-hour warning: due in a day and a half, it warns.
  update public.approval_requests
     set deadline_at = now() + interval '36 hours', warn_hours = 48 where id = v_step;
  perform app.daily_reminders();
  if not exists (select 1 from public.notifications where entity_id = v_sub and kind = 'approval.due_soon'
                   and recipient_id = v_appr) then
    raise exception 'FAIL: a 48-hour warning did not come 36 hours ahead';
  end if;
  raise notice 'pass: the due-soon warning before the deadline follows the step (off, or 48 hours)';

  -- After: escalate on the deadline, two levels. Just past it, level one.
  update public.approval_requests
     set deadline_at = now() - interval '1 hour', escalate_days = 0, escalate_levels = 2 where id = v_step;
  perform app.daily_reminders();
  if not exists (select 1 from public.notifications where entity_id = v_sub and kind = 'approval.escalated' and recipient_id = v_m1) then
    raise exception 'FAIL: escalating on the deadline did not reach the manager';
  end if;
  if exists (select 1 from public.notifications where entity_id = v_sub and kind = 'approval.escalated' and recipient_id = v_m2) then
    raise exception 'FAIL: level two came before its day';
  end if;
  -- Four days late: level two, the manager's manager, once.
  update public.approval_requests set deadline_at = now() - interval '4 days' where id = v_step;
  perform app.daily_reminders();
  v := app.daily_reminders();
  if (select count(*) from public.notifications where entity_id = v_sub and kind = 'approval.escalated' and recipient_id = v_m2) <> 1 then
    raise exception 'FAIL: level two did not reach the manager''s manager exactly once';
  end if;
  if (select count(*) from public.notifications where entity_id = v_sub and kind = 'approval.escalated' and recipient_id = v_m1) <> 1 then
    raise exception 'FAIL: the manager was told twice';
  end if;

  -- Never: no levels, no escalation however late.
  delete from public.notifications where entity_id = v_sub and kind = 'approval.escalated';
  update public.approval_requests set escalate_levels = 0 where id = v_step;
  perform app.daily_reminders();
  if exists (select 1 from public.notifications where entity_id = v_sub and kind = 'approval.escalated') then
    raise exception 'FAIL: a step set never to escalate escalated';
  end if;
  raise notice 'pass: escalation after the breach follows the step: on the deadline, up two levels of the reporting line, or never';
end $$;

-- A form's step carries its timing into every request built from it.
do $$
declare v_rule uuid; v_form uuid; v_sub uuid; v record;
begin
  perform pg_temp.as_emp(null);
  select r.id, r.form_template_id into v_rule, v_form from public.approval_rules r
   where r.tenant_id = current_setting('t.tpl')::uuid and r.subject_type = 'form_submission'
     and r.step_index = 0 and r.condition is null and r.label is distinct from 'slab_finance'
   order by r.position limit 1;
  update public.approval_rules set warn_hours = 6, escalate_days = 1, escalate_levels = 3 where id = v_rule;
  select warn_hours, escalate_days, escalate_levels into v
    from app.plan_chain('form_submission', v_form, 'EMP-NOBODY', '{}'::jsonb)
   where warn_hours is not null limit 1;
  if v.warn_hours is distinct from 6 or v.escalate_days is distinct from 1 or v.escalate_levels is distinct from 3 then
    raise exception 'FAIL: the planned chain dropped the step''s SLA timing: %', v;
  end if;
  update public.approval_rules set warn_hours = null, escalate_days = null, escalate_levels = null where id = v_rule;
  raise notice 'pass: a step''s SLA timing goes from the form''s rule into the chain';
end $$;

-- A step that becomes somebody's turn records when.
do $$
declare v_step uuid;
begin
  select id into v_step from public.approval_requests
   where tenant_id = current_setting('t.tpl')::uuid and status = 'waiting' limit 1;
  update public.approval_requests set status = 'pending' where id = v_step;
  if (select opened_at from public.approval_requests where id = v_step) is null then
    raise exception 'FAIL: a step that opened did not record when';
  end if;
  raise notice 'pass: a step records when it became somebody''s turn';
end $$;

delete from public.tenants where slug = 'rep-other';

delete from public.tenants where id = current_setting('t.tpl')::uuid;

do $$ begin raise notice 'ALL REPORT TESTS PASSED'; end $$;
