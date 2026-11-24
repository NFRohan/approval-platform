-- =====================================================================
-- Reports, analytics and email.
--
--   * When each approval step opened, so response times and the SLA can
--     be measured, and two views the report builder and the analytics
--     read: one row per request, one per approval step. Both are
--     security_invoker, so row-level security applies to them exactly as
--     to the tables beneath.
--   * Every notification is also queued as an email, unless the
--     organisation has switched that kind off. The server renders and
--     delivers it (src/server/mailer.ts) and records what happened.
--   * Report templates: kept by admins, column changes asked for by
--     anybody who reads reports and approved by an admin who did not ask.
--   * The daily round: reminders before a deadline, escalation to the
--     approver's manager after one is missed.
--   * History for a demonstration: months of decided requests, so the
--     analytics have something to say.
--
-- Re-runnable.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- When a step became somebody's turn.
-- ---------------------------------------------------------------------
create or replace function app.mark_step_opened()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'pending' and new.opened_at is null then
    new.opened_at := now();
  end if;
  return new;
end $$;

drop trigger if exists approval_requests_opened on public.approval_requests;
create trigger approval_requests_opened before insert or update of status on public.approval_requests
  for each row execute function app.mark_step_opened();

-- Steps from before this existed: opened when the phase before them was
-- last decided, or when the request was raised.
update public.approval_requests r
   set opened_at = coalesce(
         (select max(p.acted_at) from public.approval_requests p
           where p.subject_id = r.subject_id and p.tenant_id = r.tenant_id and p.step_index < r.step_index),
         (select s.submitted_at from public.form_submissions s where s.id = r.submission_id),
         r.created_at)
 where r.opened_at is null and r.status <> 'waiting';

-- ---------------------------------------------------------------------
-- Each request's steps, summed up (public.submission_stats).
--
-- Recomputed for a request whenever one of its steps is added, changed
-- or removed — a handful of rows each time — so a report over two
-- million requests joins one row each rather than aggregating some two
-- million steps on every run.
-- ---------------------------------------------------------------------
create or replace function app.refresh_submission_stats(p_submission uuid)
returns void
language sql
security definer
set search_path = public, app, pg_temp
as $$
  insert into public.submission_stats as x
    (submission_id, tenant_id, steps_total, steps_done, last_acted_at, waiting_on, waiting_since, next_deadline, current_stage, late_steps)
  select s.id, s.tenant_id,
         count(r.id) filter (where r.status <> 'skipped'),
         count(r.id) filter (where r.status in ('approved', 'rejected')),
         max(r.acted_at),
         string_agg(distinct ae.name, ', ') filter (where r.status in ('pending', 'clarification')),
         min(r.opened_at) filter (where r.status in ('pending', 'clarification')),
         min(r.deadline_at) filter (where r.status = 'pending'),
         min(coalesce(r.stage_label, r.lane_label)) filter (where r.status in ('pending', 'clarification')),
         count(r.id) filter (where r.acted_at > r.deadline_at)
    from public.form_submissions s
    left join public.approval_requests r on r.submission_id = s.id and r.tenant_id = s.tenant_id
    left join public.employees ae on ae.employee_id = r.approver_user_id and ae.tenant_id = r.tenant_id
   where s.id = p_submission
   group by s.id, s.tenant_id
  on conflict (submission_id) do update set
    steps_total = excluded.steps_total, steps_done = excluded.steps_done, last_acted_at = excluded.last_acted_at,
    waiting_on = excluded.waiting_on, waiting_since = excluded.waiting_since, next_deadline = excluded.next_deadline,
    current_stage = excluded.current_stage, late_steps = excluded.late_steps
$$;

create or replace function app.submission_stats_on_step()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if tg_op <> 'INSERT' and old.submission_id is not null then perform app.refresh_submission_stats(old.submission_id); end if;
  if tg_op <> 'DELETE' and new.submission_id is not null
     and (tg_op = 'INSERT' or new.submission_id is distinct from old.submission_id) then
    perform app.refresh_submission_stats(new.submission_id);
  end if;
  return null;
end $$;

drop trigger if exists approval_requests_submission_stats on public.approval_requests;
create trigger approval_requests_submission_stats
  after insert or update or delete on public.approval_requests
  for each row execute function app.submission_stats_on_step();

-- Every request at once: after a bulk load, and on every apply, so a
-- request from before this existed has its row.
create or replace function app.rebuild_submission_stats(p_tenant uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_n int;
begin
  insert into public.submission_stats as x
    (submission_id, tenant_id, steps_total, steps_done, last_acted_at, waiting_on, waiting_since, next_deadline, current_stage, late_steps)
  select s.id, s.tenant_id,
         count(r.id) filter (where r.status <> 'skipped'),
         count(r.id) filter (where r.status in ('approved', 'rejected')),
         max(r.acted_at),
         string_agg(distinct ae.name, ', ') filter (where r.status in ('pending', 'clarification')),
         min(r.opened_at) filter (where r.status in ('pending', 'clarification')),
         min(r.deadline_at) filter (where r.status = 'pending'),
         min(coalesce(r.stage_label, r.lane_label)) filter (where r.status in ('pending', 'clarification')),
         count(r.id) filter (where r.acted_at > r.deadline_at)
    from public.form_submissions s
    left join public.approval_requests r on r.submission_id = s.id and r.tenant_id = s.tenant_id
    left join public.employees ae on ae.employee_id = r.approver_user_id and ae.tenant_id = r.tenant_id
   where p_tenant is null or s.tenant_id = p_tenant
   group by s.id, s.tenant_id
  on conflict (submission_id) do update set
    steps_total = excluded.steps_total, steps_done = excluded.steps_done, last_acted_at = excluded.last_acted_at,
    waiting_on = excluded.waiting_on, waiting_since = excluded.waiting_since, next_deadline = excluded.next_deadline,
    current_stage = excluded.current_stage, late_steps = excluded.late_steps;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

select app.rebuild_submission_stats();

drop policy if exists submission_stats_member_read on public.submission_stats;
create policy submission_stats_member_read on public.submission_stats for select to app_api
  using (tenant_id = (select app.current_tenant()) and (select app.is_member()));

-- ---------------------------------------------------------------------
-- One row per request.
-- ---------------------------------------------------------------------
drop view if exists public.report_requests;
create view public.report_requests with (security_invoker = true) as
select s.id,
       s.tenant_id,
       s.ref_number                                       as reference,
       ft.name                                            as form,
       ft.category,
       s.submitted_by                                     as requester_id,
       e.name                                             as requester,
       e.department,
       s.status,
       s.priority,
       s.flag,
       -- The form's first money answer, as app.submission_amount reads it,
       -- without building every answer for every row; dropped by the
       -- planner when a query does not ask for the amount.
       coalesce((select app.leading_number(v.value)
                   from public.form_fields f
                   join public.submission_values v on v.submission_id = s.id and v.tenant_id = s.tenant_id and v.field_name = f.field_name
                  where f.form_template_id = s.form_template_id and f.field_type = 'money'
                  order by f.order_index nulls last, f.id limit 1), 0) as amount,
       s.submitted_at,
       -- A ticket migrated from another system was decided there.
       coalesce(case when s.status in ('completed', 'rejected') then st.last_acted_at end, s.closed_at) as decided_at,
       case when coalesce(case when s.status in ('completed', 'rejected') then st.last_acted_at end, s.closed_at) is not null
            then round(extract(epoch from coalesce(case when s.status in ('completed', 'rejected') then st.last_acted_at end, s.closed_at)
                                          - s.submitted_at) / 86400.0, 1) end
                                                          as cycle_days,
       coalesce(st.steps_total, 0)                        as steps_total,
       coalesce(st.steps_done, 0)                         as steps_done,
       st.waiting_on,
       coalesce(st.next_deadline < now(), false)          as overdue,
       coalesce(st.late_steps, 0)                         as late_steps
  from public.form_submissions s
  join public.form_templates ft on ft.id = s.form_template_id and ft.tenant_id = s.tenant_id
  left join public.employees e on e.employee_id = s.submitted_by and e.tenant_id = s.tenant_id
  -- Each request's steps, summed up as they change (submission_stats).
  left join public.submission_stats st on st.submission_id = s.id and st.tenant_id = s.tenant_id
 where s.status <> 'draft';

-- ---------------------------------------------------------------------
-- One row per approval step, of anything that goes through the chain.
-- ---------------------------------------------------------------------
drop view if exists public.report_steps;
create view public.report_steps with (security_invoker = true) as
select r.id,
       r.tenant_id,
       r.subject_id,
       r.subject_type,
       coalesce(s.ref_number, app.subject_label(r.subject_type, r.subject_id)) as reference,
       coalesce(ft.name, initcap(replace(r.subject_type, '_', ' ')))          as form,
       re.name                                                                as requester,
       re.department                                                          as requester_department,
       coalesce(r.stage_label, r.lane_label, 'Step ' || (r.step_index + 1))   as stage,
       r.approver_user_id                                                     as approver_id,
       ae.name                                                                as approver,
       ae.department                                                          as approver_department,
       r.status,
       s.priority,
       r.opened_at,
       r.deadline_at,
       r.acted_at,
       case when r.opened_at is null then null
            else round(extract(epoch from coalesce(r.acted_at, now()) - r.opened_at) / 86400.0, 1) end
                                                                              as response_days,
       case when r.acted_at is not null then r.acted_at <= coalesce(r.deadline_at, r.acted_at)
            when r.status = 'pending' and r.deadline_at < now() then false end as on_time,
       (r.status = 'pending' and r.deadline_at < now())                       as overdue,
       r.comment
  from public.approval_requests r
  left join public.form_submissions s on s.id = r.submission_id and s.tenant_id = r.tenant_id
  left join public.form_templates ft on ft.id = s.form_template_id and ft.tenant_id = r.tenant_id
  left join public.employees re on re.employee_id = s.submitted_by and re.tenant_id = r.tenant_id
  left join public.employees ae on ae.employee_id = r.approver_user_id and ae.tenant_id = r.tenant_id;

grant select on public.report_requests, public.report_steps to app_api;

-- ---------------------------------------------------------------------
-- Every notification is also an email.
-- ---------------------------------------------------------------------
create or replace function app.enqueue_email()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_addr text;
begin
  -- Cloning an evaluation or seeding one copies notifications that were
  -- never meant to be sent again.
  if coalesce(current_setting('app.no_mail', true), '') = 'true' then
    return new;
  end if;
  if exists (select 1 from public.email_templates t
              where t.tenant_id = new.tenant_id and t.kind = new.kind and not t.enabled) then
    return new;
  end if;
  select nullif(trim(email), '') into v_addr from public.employees
   where tenant_id = new.tenant_id and employee_id = new.recipient_id;

  insert into public.email_outbox
    (tenant_id, notification_id, kind, recipient_id, to_address, context, entity_type, entity_id, status, error)
  values (new.tenant_id, new.id, new.kind, new.recipient_id, v_addr,
          jsonb_build_object('title', new.title, 'body', new.body),
          new.entity_type, new.entity_id,
          case when v_addr is null then 'skipped' else 'queued' end,
          case when v_addr is null then 'no work email on record' end);
  return new;
end $$;

drop trigger if exists notifications_email on public.notifications;
create trigger notifications_email after insert on public.notifications
  for each row execute function app.enqueue_email();

-- ---------------------------------------------------------------------
-- Policies. Read here; written through the functions below or, for the
-- outbox, by the server's mailer.
-- ---------------------------------------------------------------------
do $p$
begin
  drop policy if exists email_templates_read on public.email_templates;
  create policy email_templates_read on public.email_templates
    for select to app_api using (tenant_id = (select app.current_tenant()) and (select app.is_member()));

  drop policy if exists email_outbox_read on public.email_outbox;
  create policy email_outbox_read on public.email_outbox
    for select to app_api
    using (tenant_id = (select app.current_tenant()) and (select app.is_member())
           and (recipient_id = app.current_employee()
                or app.has_permission('notifications.manage') or app.has_permission('audit.view')));

  drop policy if exists report_templates_read on public.report_templates;
  create policy report_templates_read on public.report_templates
    for select to app_api
    using (tenant_id = (select app.current_tenant()) and (select app.is_member())
           and (app.has_permission('reports.view') or app.has_permission('reports.manage')));
end $p$;

-- ---------------------------------------------------------------------
-- Report templates.
-- ---------------------------------------------------------------------
create or replace function public.save_report(
  p_id uuid, p_name text, p_description text, p_dataset text, p_columns text[], p_filters jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_id uuid;
begin
  perform app.require_permission('reports.manage');
  if coalesce(trim(p_name), '') = '' then raise exception 'a report needs a name'; end if;
  if coalesce(cardinality(p_columns), 0) = 0 then raise exception 'a report needs at least one column'; end if;
  if p_id is null then
    insert into public.report_templates (tenant_id, name, description, dataset, columns, filters, created_by, updated_by)
    values (app.current_tenant(), trim(p_name), nullif(trim(p_description), ''), p_dataset, p_columns,
            coalesce(p_filters, '{}'), app.current_employee(), app.current_employee())
    returning id into v_id;
    perform app.audit('report_created', 'report', v_id, trim(p_name));
  else
    update public.report_templates
       set name = trim(p_name), description = nullif(trim(p_description), ''), dataset = p_dataset,
           columns = p_columns, filters = coalesce(p_filters, '{}'), updated_by = app.current_employee(),
           updated_at = now()
     where id = p_id and tenant_id = app.current_tenant()
    returning id into v_id;
    if v_id is null then raise exception 'no such report'; end if;
    perform app.audit('report_changed', 'report', v_id, trim(p_name));
  end if;
  return v_id;
end $$;

create or replace function public.delete_report(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  perform app.require_permission('reports.manage');
  select name, standard into v from public.report_templates where id = p_id and tenant_id = app.current_tenant();
  if not found then raise exception 'no such report'; end if;
  if v.standard then raise exception 'a standard report can be changed but not deleted'; end if;
  delete from public.report_templates where id = p_id and tenant_id = app.current_tenant();
  perform app.audit('report_deleted', 'report', p_id, v.name);
end $$;

-- Anybody who reads reports may ask for different columns.
create or replace function public.request_report_change(p_id uuid, p_columns text[], p_note text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_name text;
begin
  if not (app.has_permission('reports.view') or app.has_permission('reports.manage')) then
    raise exception 'you need the reports.view permission for that';
  end if;
  if coalesce(cardinality(p_columns), 0) = 0 then raise exception 'a report needs at least one column'; end if;
  update public.report_templates
     set pending_columns = p_columns, change_note = nullif(trim(p_note), ''),
         change_requested_by = app.current_employee(), updated_at = now()
   where id = p_id and tenant_id = app.current_tenant()
  returning name into v_name;
  if v_name is null then raise exception 'no such report'; end if;
  perform app.audit('report_change_requested', 'report', p_id, v_name);
end $$;

-- An admin decides, and not the one who asked.
create or replace function public.decide_report_change(p_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  perform app.require_permission('reports.manage');
  select * into v from public.report_templates where id = p_id and tenant_id = app.current_tenant() for update;
  if not found then raise exception 'no such report'; end if;
  if v.pending_columns is null then raise exception 'that report has no change waiting'; end if;
  if v.change_requested_by is not distinct from app.current_employee() then
    raise exception 'a column change has to be approved by somebody other than whoever asked for it';
  end if;
  update public.report_templates
     set columns = case when p_approve then v.pending_columns else columns end,
         pending_columns = null, change_note = null, change_requested_by = null,
         approved_by = case when p_approve then app.current_employee() else approved_by end,
         updated_at = now()
   where id = p_id;
  perform app.audit(case when p_approve then 'report_change_approved' else 'report_change_rejected' end,
                    'report', p_id, v.name);
end $$;

create or replace function public.set_report_schedule(p_id uuid, p_schedule text, p_recipients text[], p_format text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_name text;
begin
  perform app.require_permission('reports.manage');
  if exists (select 1 from unnest(coalesce(p_recipients, '{}')) x
              where not exists (select 1 from public.employees e
                                 where e.tenant_id = app.current_tenant() and e.employee_id = x)) then
    raise exception 'every recipient has to be somebody here';
  end if;
  update public.report_templates
     set schedule = p_schedule, recipients = coalesce(p_recipients, '{}'), format = p_format, updated_at = now()
   where id = p_id and tenant_id = app.current_tenant()
  returning name into v_name;
  if v_name is null then raise exception 'no such report'; end if;
  perform app.audit('report_scheduled', 'report', p_id, v_name || ': ' || p_schedule);
end $$;

-- Queue a report as an email to these people. The file is made when the
-- email is delivered, so it holds the data as of then.
create or replace function public.queue_report_email(p_id uuid, p_recipients text[])
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v record; v_n int;
begin
  if not (app.has_permission('reports.view') or app.has_permission('reports.manage')) then
    raise exception 'you need the reports.view permission for that';
  end if;
  select name, format into v from public.report_templates where id = p_id and tenant_id = app.current_tenant();
  if not found then raise exception 'no such report'; end if;

  insert into public.email_outbox (tenant_id, report_id, kind, recipient_id, to_address, context, status, error)
  select app.current_tenant(), p_id, 'report.sent', e.employee_id, nullif(trim(e.email), ''),
         jsonb_build_object('title', v.name, 'format', v.format, 'sent_by', app.current_employee()),
         case when nullif(trim(e.email), '') is null then 'skipped' else 'queued' end,
         case when nullif(trim(e.email), '') is null then 'no work email on record' end
    from public.employees e
   where e.tenant_id = app.current_tenant() and e.employee_id = any (p_recipients);
  get diagnostics v_n = row_count;
  perform app.audit('report_emailed', 'report', p_id, v.name || ' to ' || v_n || ' recipient(s)');
  return v_n;
end $$;

-- The scheduled reports that are due, across every live tenant or just
-- the one named. For the daily round, which runs as the owner.
drop function if exists app.queue_due_reports();
create or replace function app.queue_due_reports(p_tenant uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare r record; v_n int := 0;
begin
  for r in
    select rt.* from public.report_templates rt
     where rt.schedule <> 'none' and cardinality(rt.recipients) > 0
       and (p_tenant is null or rt.tenant_id = p_tenant)
       and app.tenant_status(rt.tenant_id) = 'active'
       and (rt.last_sent_at is null
            or rt.last_sent_at < now() - case rt.schedule when 'weekly' then interval '7 days' else interval '1 month' end
                                     + interval '1 hour')
  loop
    insert into public.email_outbox (tenant_id, report_id, kind, recipient_id, to_address, context, status, error)
    select r.tenant_id, r.id, 'report.scheduled', e.employee_id, nullif(trim(e.email), ''),
           jsonb_build_object('title', r.name, 'format', r.format, 'schedule', r.schedule),
           case when nullif(trim(e.email), '') is null then 'skipped' else 'queued' end,
           case when nullif(trim(e.email), '') is null then 'no work email on record' end
      from public.employees e
     where e.tenant_id = r.tenant_id and e.employee_id = any (r.recipients);
    update public.report_templates set last_sent_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Email templates.
-- ---------------------------------------------------------------------
create or replace function public.save_email_template(p_kind text, p_subject text, p_body text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.require_permission('notifications.manage');
  if p_kind !~ '^[a-z]+\.[a-z_]+$' then raise exception 'no such kind of notification'; end if;
  insert into public.email_templates (tenant_id, kind, subject, body, enabled, updated_by, updated_at)
  values (app.current_tenant(), p_kind, nullif(trim(p_subject), ''), nullif(trim(p_body), ''),
          coalesce(p_enabled, true), app.current_employee(), now())
  on conflict (tenant_id, kind) do update
     set subject = excluded.subject, body = excluded.body, enabled = excluded.enabled,
         updated_by = excluded.updated_by, updated_at = now();
  perform app.audit('email_template_changed', 'email_template', null::uuid, p_kind);
end $$;

create or replace function public.reset_email_template(p_kind text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.require_permission('notifications.manage');
  delete from public.email_templates where tenant_id = app.current_tenant() and kind = p_kind;
  perform app.audit('email_template_reset', 'email_template', null::uuid, p_kind);
end $$;

-- ---------------------------------------------------------------------
-- The daily round, for the tenant in context.
--
-- "Approval notification interval (reminders, SLA auto-escalation,
-- before or after breach)." A step due within a day reminds its
-- approver once; a step two working days past its deadline is escalated
-- to the approver's line manager, once. Overdue steps already remind
-- their approver daily (remind_overdue).
-- ---------------------------------------------------------------------
create or replace function app.daily_reminders()
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare r record; v_due int := 0; v_esc int := 0; v_over int := 0; v_mgr text;
begin
  -- Overdue: a reminder a day to whoever holds it.
  for r in
    select ar.* from public.approval_requests ar
     where ar.tenant_id = app.current_tenant() and ar.status = 'pending'
       and ar.approver_user_id is not null and ar.deadline_at < now()
       and not exists (select 1 from public.notifications n
                        where n.tenant_id = ar.tenant_id and n.kind = 'approval.overdue'
                          and n.recipient_id = ar.approver_user_id and n.entity_id = ar.subject_id
                          and n.created_at > now() - interval '20 hours')
  loop
    perform app.notify(r.approver_user_id, 'approval.overdue',
      'Overdue: ' || app.subject_label(r.subject_type, r.subject_id),
      'This was due ' || to_char(r.deadline_at at time zone 'Asia/Dhaka', 'DD/MM/YYYY') || ' and is still with you.',
      r.subject_type, r.subject_id);
    v_over := v_over + 1;
  end loop;

  for r in
    select ar.* from public.approval_requests ar
     where ar.tenant_id = app.current_tenant() and ar.status = 'pending'
       and ar.deadline_at between now() and now() + interval '1 day'
       and not exists (select 1 from public.notifications n
                        where n.tenant_id = ar.tenant_id and n.kind = 'approval.due_soon'
                          and n.recipient_id = ar.approver_user_id and n.entity_id = ar.subject_id)
  loop
    perform app.notify(r.approver_user_id, 'approval.due_soon',
      'Due soon: ' || app.subject_label(r.subject_type, r.subject_id),
      'This approval is due by ' || to_char(r.deadline_at at time zone 'Asia/Dhaka', 'DD/MM/YYYY HH24:MI') || '.',
      r.subject_type, r.subject_id);
    v_due := v_due + 1;
  end loop;

  for r in
    select ar.* from public.approval_requests ar
     where ar.tenant_id = app.current_tenant() and ar.status = 'pending'
       and app.add_working_days(ar.deadline_at, 2, ar.tenant_id) < now()
  loop
    select line_manager_id into v_mgr from public.employees
     where tenant_id = r.tenant_id and employee_id = r.approver_user_id;
    continue when v_mgr is null or exists (
      select 1 from public.notifications n
       where n.tenant_id = r.tenant_id and n.kind = 'approval.escalated'
         and n.recipient_id = v_mgr and n.entity_id = r.subject_id);
    perform app.notify(v_mgr, 'approval.escalated',
      'Escalated: ' || app.subject_label(r.subject_type, r.subject_id),
      coalesce((select name from public.employees where tenant_id = r.tenant_id and employee_id = r.approver_user_id), r.approver_user_id)
        || ' has not acted on this for two working days past its deadline.',
      r.subject_type, r.subject_id);
    perform app.log_event(r.id, r.subject_type, r.subject_id, null, 'escalated', null, v_mgr);
    v_esc := v_esc + 1;
  end loop;

  return jsonb_build_object('overdue', v_over, 'due_soon', v_due, 'escalated', v_esc);
end $$;

-- ---------------------------------------------------------------------
-- History, for a demonstration.
--
-- Decided requests across the last six months — mostly approved, some
-- rejected, a few cancelled, some still open and a handful overdue —
-- routed through each requester's line manager and the form's own
-- approvers, with response times that vary by person. Deterministic, so
-- every evaluation tells the same story.
-- ---------------------------------------------------------------------
create or replace function app.generate_history(p_tenant uuid, p_count int default 180)
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_forms   uuid[];
  v_people  text[];
  v_form    uuid;
  v_req     text;
  v_mgr     text;
  v_appr    text[];
  v_when    timestamptz;
  v_open    timestamptz;
  v_act     timestamptz;
  v_dead    timestamptz;
  v_sub     uuid;
  v_fate    text;
  v_stop    int;
  v_status  text;
  v_prio    text;
  v_money   text;
  v_days    int;
  v_hours   numeric;
  v_n       int := 0;
  r         float8;
begin
  if (select history_seeded from public.tenants where id = p_tenant) then return 0; end if;
  perform set_config('app.no_mail', 'true', true);
  perform setseed(0.4242);

  select array_agg(id order by name) into v_forms
    from public.form_templates where tenant_id = p_tenant and status = 'published';
  select array_agg(employee_id order by employee_id) into v_people
    from public.employees where tenant_id = p_tenant and active;
  if v_forms is null or v_people is null then return 0; end if;

  for i in 1..p_count loop
    v_form := v_forms[1 + floor(random() * array_length(v_forms, 1))::int];
    v_req  := v_people[1 + floor(random() * array_length(v_people, 1))::int];
    -- More of them recently: an organisation adopting the system.
    v_days := 2 + floor(180 * power(random(), 1.35))::int;
    v_when := date_trunc('day', now() - make_interval(days => v_days)) + make_interval(hours => 3 + floor(random() * 9)::int);
    r := random();
    v_prio := case when r < 0.07 then 'urgent' when r < 0.25 then 'high' else 'normal' end;

    r := random();
    v_fate := case
      when v_days < 12 and r < 0.55 then 'open'
      when r < 0.80 then 'completed'
      when r < 0.92 then 'rejected'
      when r < 0.95 then 'cancelled'
      else 'open' end;

    select line_manager_id into v_mgr from public.employees where tenant_id = p_tenant and employee_id = v_req;
    v_appr := array_remove(array[v_mgr], null);
    v_appr := v_appr || array(
      select x.approver_user_id from (
        select ar.approver_user_id, min(ar.step_index) si from public.approval_rules ar
         where ar.form_template_id = v_form and ar.tenant_id = p_tenant
           and ar.approver_user_id is not null and ar.approver_user_id <> v_req
         group by ar.approver_user_id) x
       where x.approver_user_id <> all (v_appr)
       order by x.si limit 3);
    if cardinality(v_appr) = 0 then
      v_appr := array[case when v_req = 'EMP-0445' then 'EMP-0650' else 'EMP-0445' end];
    end if;
    -- Only people who work here: an organisation shaped differently from
    -- the template has fewer of them.
    v_appr := array(select x from unnest(v_appr) with ordinality u(x, o)
                     where exists (select 1 from public.employees e where e.tenant_id = p_tenant and e.employee_id = x)
                     order by o);
    continue when cardinality(v_appr) = 0;
    v_stop := 1 + floor(random() * cardinality(v_appr))::int;   -- the step a rejection or an open request stops at

    insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at, priority)
    values (p_tenant, v_form, v_req, 'submitted', v_when, v_prio)
    returning id into v_sub;

    select field_name into v_money from public.form_fields
     where form_template_id = v_form and tenant_id = p_tenant and field_type = 'money' order by order_index limit 1;
    if v_money is not null then
      insert into public.submission_values (tenant_id, submission_id, field_name, value)
      values (p_tenant, v_sub, v_money, (round(exp(8.5 + random() * 4.5) / 100) * 100)::text);
    end if;

    v_open := v_when;
    v_status := case v_fate when 'cancelled' then 'cancelled' when 'open' then 'in_progress' else 'completed' end;
    for j in 1..cardinality(v_appr) loop
      v_dead := app.add_working_days(v_open, case v_prio when 'urgent' then 1 when 'high' then 2 else 3 end, p_tenant);
      -- Some people are slower than others, consistently.
      v_hours := 2 + power(random(), 2) * 80 + (abs(hashtext(v_appr[j])) % 4) * 14;

      if v_fate = 'cancelled' and j > 1 then
        insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index, status, created_at)
        values (p_tenant, v_sub, v_appr[j], j - 1, 'skipped', v_when);
      elsif v_fate = 'cancelled' then
        insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index, status, opened_at, deadline_at, created_at)
        values (p_tenant, v_sub, v_appr[j], j - 1, 'skipped', v_open, v_dead, v_when);
      elsif v_fate = 'open' and j = v_stop then
        insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index, status, opened_at, deadline_at, created_at)
        values (p_tenant, v_sub, v_appr[j], j - 1, 'pending', v_open, v_dead, v_when);
      elsif v_fate = 'open' and j > v_stop then
        insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index, status, created_at)
        values (p_tenant, v_sub, v_appr[j], j - 1, 'waiting', v_when);
      elsif v_fate = 'rejected' and j > v_stop then
        insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index, status, created_at)
        values (p_tenant, v_sub, v_appr[j], j - 1, 'skipped', v_when);
      else
        v_act := v_open + make_interval(secs => (v_hours * 3600)::int);
        if v_act > now() then v_act := now() - interval '1 hour'; end if;
        insert into public.approval_requests
          (tenant_id, submission_id, approver_user_id, step_index, status, comment, opened_at, deadline_at, acted_at, created_at)
        values (p_tenant, v_sub, v_appr[j], j - 1,
                case when v_fate = 'rejected' and j = v_stop then 'rejected' else 'approved' end,
                case when v_fate = 'rejected' and j = v_stop then 'Not within this quarter''s budget.'
                     when random() < 0.3 then 'Looks fine.' end,
                v_open, v_dead, v_act, v_when);
        insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail, created_at)
        values (p_tenant, v_appr[j], case when v_fate = 'rejected' and j = v_stop then 'rejected' else 'approved' end,
                'form_submission', v_sub, null, v_act);
        if v_fate = 'rejected' and j = v_stop then v_status := 'rejected'; end if;
        v_open := v_act;
      end if;
    end loop;

    update public.form_submissions set status = v_status where id = v_sub;
    v_n := v_n + 1;
  end loop;

  update public.tenants set history_seeded = true where id = p_tenant;
  perform set_config('app.no_mail', 'false', true);
  return v_n;
end $$;

grant execute on function
  public.save_report(uuid, text, text, text, text[], jsonb),
  public.delete_report(uuid),
  public.request_report_change(uuid, text[], text),
  public.decide_report_change(uuid, boolean),
  public.set_report_schedule(uuid, text, text[], text),
  public.queue_report_email(uuid, text[]),
  public.save_email_template(text, text, text, boolean),
  public.reset_email_template(text)
to app_api;
grant execute on all functions in schema app to app_api;

commit;
