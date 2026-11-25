-- =====================================================================
-- Who sees a request.
--
-- "Manage & maintain customizable approval flow ... with proper access
-- control" (SOW §2), and "should be visible as per the role of the user
-- and his/her division" (Role Based NFA). Until this module every member
-- of an organisation could read every request in it — an analyst could
-- open HR's exit clearances and Compliance's gift declarations — because
-- the rule was only "belongs here". Screens that looked private (My
-- Submissions) were filtering in the browser.
--
-- A request is seen by:
--   1. whoever raised it;
--   2. whoever is on its chain — an approver at any step, a current
--      delegate of one on a step still open, or anybody who has acted
--      on it (forwarded, returned, asked);
--   3. whoever is copied on it, or has been told about it (a watcher
--      under a notification rule is told, and so may open what they
--      were told about);
--      and a follow-up a request starts is seen by whoever sees that
--      request through 1-3;
--   4. whoever holds reports.view or audit.view — oversight. An API key
--      reads as the organisation and passes here too;
--   5. the head of the requester's department.
--
-- Everything that hangs off a request — its answers, documents, steps,
-- history, notes, questions, links, ticks, sums — is seen exactly when
-- the request is. The rule is in the database, so every screen, export,
-- report and the API follow it without each having to remember.
--
-- Cost: the person's own sets (2, 3 and 5) are worked out once per
-- query, as hashed lists, not once per row; at two million requests a
-- per-row lookup is what makes a screen slow.
-- Re-runnable.
-- =====================================================================

begin;

-- What the lists are looked up by.
create index if not exists form_submissions_requester_idx on public.form_submissions(tenant_id, submitted_by);
create index if not exists approval_events_actor_idx on public.approval_events(tenant_id, actor_id) where subject_type = 'form_submission';
create index if not exists submission_cc_person_idx on public.submission_cc(tenant_id, employee_id);
create index if not exists notifications_about_idx on public.notifications(tenant_id, recipient_id, entity_type);
create index if not exists form_submissions_parent_idx on public.form_submissions(parent_submission_id) where parent_submission_id is not null;

-- 4. Oversight.
-- Asked once per statement that touches a request, and each answer is two
-- role lookups (~2 ms); raising one request runs some twenty such
-- statements, triggers included. So the answer is kept for the rest of
-- the transaction, under who asked — a different employee, organisation,
-- role or sign-in strength asks afresh.
create or replace function app.sees_every_request()
returns boolean
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_who  text := concat_ws('|', app.current_employee(), app.current_tenant(),
                           current_setting('app.role', true), current_setting('app.mfa', true),
                           current_setting('app.is_staff', true));
  v_kept text := current_setting('app.sees_every_request', true);
  v_yes  boolean;
begin
  if left(v_kept, length(v_who) + 1) = v_who || '=' then
    return substr(v_kept, length(v_who) + 2)::boolean;
  end if;
  v_yes := app.has_permission('reports.view') or app.has_permission('audit.view');
  perform set_config('app.sees_every_request', v_who || '=' || v_yes::text, true);
  return v_yes;
end $$;

-- 2 and 3. The requests a person has a part in besides their own.
-- Security definer: it reads the steps and the notifications as they
-- are, so the rule never asks itself.
create or replace function app.my_request_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  with me as (
    select app.current_employee() as id, app.current_tenant() as t,
           (now() at time zone 'Asia/Dhaka')::date as today
  ),
  involved as (
  -- Their own (rule 1 again, so their follow-ups are found below).
  select s.id as submission_id
    from public.form_submissions s, me
   where s.tenant_id = me.t and s.submitted_by = me.id
  union
  -- On the chain, at any step and in any state.
  select r.submission_id
    from public.approval_requests r, me
   where r.tenant_id = me.t and r.approver_user_id = me.id and r.submission_id is not null
  union
  -- Standing in for somebody today, on a step still open — what the
  -- delegate may act on, as app.may_act says.
  select r.submission_id
    from me
    join public.delegation_rules d
      on d.tenant_id = me.t and d.delegate_id = me.id and me.today between d.start_date and d.end_date
    join public.approval_requests r
      on r.tenant_id = me.t and r.approver_user_id = d.delegator_id and r.submission_id is not null
     and r.status in ('waiting', 'pending', 'clarification')
    join public.form_submissions s on s.id = r.submission_id
   where d.form_template_ids is null or s.form_template_id = any (d.form_template_ids)
  union
  -- Acted on it: approved for someone, forwarded it on, returned it.
  select e.subject_id
    from public.approval_events e, me
   where e.tenant_id = me.t and e.actor_id = me.id and e.subject_type = 'form_submission'
  union
  -- Copied on it.
  select c.submission_id
    from public.submission_cc c, me
   where c.tenant_id = me.t and c.employee_id = me.id
  union
  -- Told about it.
  select n.entity_id
    from public.notifications n, me
   where n.tenant_id = me.t and n.recipient_id = me.id
     and n.entity_type = 'form_submission' and n.entity_id is not null
  )
  select submission_id from involved
$$;

-- 5. The people in the departments a person heads.
create or replace function app.my_department_members()
returns setof text
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select e.employee_id
    from public.departments d
    join public.employees e on e.tenant_id = d.tenant_id and e.department = d.name
   where d.tenant_id = app.current_tenant()
     and d.head_employee_id = app.current_employee()
$$;

-- The same rule for one request, for functions that run with the
-- owner's rights and are handed an id.
create or replace function app.can_see_submission(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select exists (
    select 1 from public.form_submissions s
     where s.id = p_id and s.tenant_id = app.current_tenant()
       and (app.sees_every_request()
            or s.submitted_by = app.current_employee()
            or s.id in (select app.my_request_ids())
            or s.parent_submission_id in (select app.my_request_ids())
            or s.submitted_by in (select app.my_department_members())))
$$;

grant execute on function app.sees_every_request(), app.my_request_ids(),
  app.my_department_members(), app.can_see_submission(uuid) to app_api;

-- ---------------------------------------------------------------------
-- The policies. A table's read policy, and its write policy where it has
-- one: in Postgres a policy "for all" grants reading too, so leaving the
-- write policy as it was would leave every row readable. Writing keeps
-- its check as it was (a new row only has to belong here); changing or
-- removing a row needs it to be one you can see.
-- ---------------------------------------------------------------------
do $v$
declare
  v_base constant text := 'tenant_id = (select app.current_tenant()) and (select app.is_member())';
  -- A request the person may see, by the request's id in the column given.
  v_sub  constant text := '((select app.sees_every_request()) or exists (select 1 from public.form_submissions s where s.id = %s))';
  t record;
  v_vis text;
begin
  for t in
    select * from (values
      -- table,               read policy,                     write policy,                 visible when
      ('form_submissions',  'form_submissions_member_read',  'form_submissions_member_write',
         '((select app.sees_every_request())'
         || ' or submitted_by = (select app.current_employee())'
         || ' or id in (select app.my_request_ids())'
         -- A follow-up a request starts is part of it. By its parent, not
         -- by listing children: the engine reads a new follow-up back in
         -- the statement that made it, before any list could hold it.
         || ' or parent_submission_id in (select app.my_request_ids())'
         || ' or submitted_by in (select app.my_department_members()))'),
      ('submission_values', 'submission_values_member_read', 'submission_values_member_write', format(v_sub, 'submission_values.submission_id')),
      ('attachments',       'attachments_member_read',       'attachments_member_write',       format(v_sub, 'attachments.submission_id')),
      ('submission_cc',     'submission_cc_member_read',     'submission_cc_member_write',     format(v_sub, 'submission_cc.submission_id')),
      ('ticket_notes',      'ticket_notes_member_read',      null,                             format(v_sub, 'ticket_notes.submission_id')),
      ('checklist_ticks',   'checklist_ticks_member_read',   null,                             format(v_sub, 'checklist_ticks.submission_id')),
      ('servicedesk_tasks', 'servicedesk_tasks_member_read', null,                             format(v_sub, 'servicedesk_tasks.submission_id')),
      ('submission_stats',  'submission_stats_member_read',  null,                             format(v_sub, 'submission_stats.submission_id')),
      -- Steps of notices and movement orders have no request; they are as they were.
      ('approval_requests', 'approval_requests_member_read', 'approval_requests_member_write',
         '(approval_requests.submission_id is null or ' || format(v_sub, 'approval_requests.submission_id') || ')'),
      ('approval_events',   'approval_events_member_read',   null,
         '(approval_events.subject_type <> ''form_submission'' or ' || format(v_sub, 'approval_events.subject_id') || ')'),
      ('approval_queries',  'approval_queries_member_read',  'approval_queries_member_write',
         '(approval_queries.subject_type <> ''form_submission'' or ' || format(v_sub, 'approval_queries.subject_id') || ')'),
      ('submission_links',  'submission_links_member_read',  'submission_links_member_write',
         '(' || format(v_sub, 'submission_links.from_id') || ' or ' || format(v_sub, 'submission_links.to_id') || ')'),
      ('attachment_access', 'attachment_access_member_read', null,
         '((select app.sees_every_request()) or exists (select 1 from public.attachments a where a.id = attachment_access.attachment_id))'),
      ('activity_log',      'activity_log_member_read',      null,
         '(activity_log.entity_type is distinct from ''form_submission'' or ' || format(v_sub, 'activity_log.entity_id') || ')'),
      -- Your own, or not about a request, or about one you may see.
      ('notifications',     'notifications_member_read',     'notifications_member_write',
         '(notifications.recipient_id = (select app.current_employee())'
         || ' or notifications.entity_type is distinct from ''form_submission'' or '
         || format(v_sub, 'notifications.entity_id') || ')')
    ) x(tbl, read_policy, write_policy, vis)
  loop
    execute format('drop policy if exists %I on public.%I', t.read_policy, t.tbl);
    execute format('create policy %I on public.%I for select to app_api using (%s and %s)',
                   t.read_policy, t.tbl, v_base, t.vis);
    if t.write_policy is not null then
      execute format('drop policy if exists %I on public.%I', t.write_policy, t.tbl);
      execute format('create policy %I on public.%I for all to app_api using (%s and %s) with check (%s)',
                     t.write_policy, t.tbl, v_base, t.vis, v_base);
    end if;
  end loop;
end $v$;

commit;
