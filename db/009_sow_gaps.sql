-- =====================================================================
-- What the SOW still asked for.
--
--   * Clearance checklists: "checklist of handover, property recovery,
--     official portals", configured per division by authorised users.
--     A track (a lane, or a stage of one lane) with items clears only
--     once each is ticked.
--   * "T+2 working days for review with a reminder every 12 hours": a
--     step reminds its approver at its rule's interval until decided.
--   * "Manually assigning different approvers only within a hierarchy":
--     a form may keep forwarding inside the approver's reporting line.
--   * "ManageEngine notification for IT clearance, and receiving its
--     completion": a leaver's IT track raises a ticket in ServiceDesk,
--     and clears when the ticket is resolved there.
--   * The forms the SOW names that no evaluation had: SIM requisition
--     and transfer, fraud incident fund transfer, compensatory and night
--     allowance.
-- =====================================================================

begin;

do $p$
declare t text;
begin
  foreach t in array array['checklist_items', 'checklist_ticks', 'servicedesk_tasks'] loop
    execute format('drop policy if exists %1$s_member_read on public.%1$I', t);
    execute format($f$create policy %1$s_member_read on public.%1$I for select to app_api
                      using (tenant_id = (select app.current_tenant()) and (select app.is_member()))$f$, t);
  end loop;
end $p$;

-- ---------------------------------------------------------------------
-- Checklists
-- ---------------------------------------------------------------------

-- A step's track: its lane's name, or its stage's where the phase has
-- one lane.
create or replace function app.checklist_track(p_lane_label text, p_stage_label text)
returns text
language sql
immutable
as $$
  select coalesce(nullif(trim(p_lane_label), ''), nullif(trim(p_stage_label), ''))
$$;

-- The items a step's track still has open, for its request.
create or replace function app.checklist_open(p_request uuid)
returns integer
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select count(*)::int
    from public.approval_requests ar
    join public.form_submissions s on s.id = ar.submission_id and s.tenant_id = ar.tenant_id
    join public.checklist_items i on i.tenant_id = ar.tenant_id and i.form_template_id = s.form_template_id
                                 and i.active and i.track = app.checklist_track(ar.lane_label, ar.stage_label)
   where ar.id = p_request
     and not exists (select 1 from public.checklist_ticks k
                      where k.submission_id = ar.submission_id and k.item_id = i.id)
$$;

create or replace function app.assert_checklist_done(p_request uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare v_open int := app.checklist_open(p_request);
begin
  if v_open > 0 then
    raise exception 'tick the checklist first: % still open on this step',
      case when v_open = 1 then '1 item is' else v_open || ' items are' end;
  end if;
end $$;

-- Tick an item, or untick it. Whoever holds the track's open step may,
-- or their delegate; an item ticked stays with who ticked it and when.
create or replace function public.tick_checklist(p_submission uuid, p_item uuid, p_done boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_actor text := app.acting(null);
  v_item  record;
  v_step  record;
begin
  if v_actor is null then raise exception 'sign in to tick a checklist'; end if;
  select i.* into v_item
    from public.checklist_items i
    join public.form_submissions s on s.id = p_submission and s.tenant_id = i.tenant_id and s.form_template_id = i.form_template_id
   where i.id = p_item and i.tenant_id = app.current_tenant() and i.active;
  if not found then raise exception 'that is not on this request''s checklist'; end if;

  select ar.* into v_step
    from public.approval_requests ar
   where ar.tenant_id = app.current_tenant() and ar.submission_id = p_submission
     and app.checklist_track(ar.lane_label, ar.stage_label) = v_item.track
     and ar.status in ('pending', 'clarification')
     and app.may_act(ar.approver_user_id, 'form_submission', p_submission, v_actor)
   order by ar.lane_step limit 1;
  if not found then
    raise exception 'only whoever holds the % step, while it is open, ticks its checklist', v_item.track;
  end if;

  if p_done then
    insert into public.checklist_ticks (tenant_id, submission_id, item_id, done_by, note)
    values (app.current_tenant(), p_submission, p_item, v_actor, nullif(trim(p_note), ''))
    on conflict (submission_id, item_id) do nothing;
    perform app.log_event(v_step.id, 'form_submission', p_submission, v_actor, 'checklist_ticked', v_item.item);
  else
    delete from public.checklist_ticks where submission_id = p_submission and item_id = p_item;
    perform app.log_event(v_step.id, 'form_submission', p_submission, v_actor, 'checklist_unticked', v_item.item);
  end if;
  return jsonb_build_object('open', app.checklist_open(v_step.id));
end $$;

-- A request's checklists: each track of its chain that has items, what
-- is ticked, and whether the person looking may tick it now.
-- Run as the caller, so row-level security shows it to whoever may see
-- the request and nobody else, as the status page does.
create or replace function public.checklist_for(p_submission uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  with s as (
    select s.* from public.form_submissions s
     where s.id = p_submission and s.tenant_id = app.current_tenant()
  ),
  tracks as (
    select app.checklist_track(ar.lane_label, ar.stage_label) as track,
           min(ar.step_index) as step_index, min(coalesce(ar.lane, 0)) as lane,
           bool_or(ar.status in ('pending', 'clarification')
                   and app.may_act(ar.approver_user_id, 'form_submission', p_submission, app.current_employee())) as can_tick,
           case when bool_and(ar.status in ('approved', 'skipped')) then 'cleared'
                when bool_or(ar.status in ('pending', 'clarification')) then 'open'
                else 'waiting' end as state
      from public.approval_requests ar, s
     where ar.submission_id = s.id and ar.tenant_id = s.tenant_id
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'track', t.track, 'state', t.state, 'can_tick', coalesce(t.can_tick, false),
           'items', (select jsonb_agg(jsonb_build_object(
                        'id', i.id, 'item', i.item, 'done', k.item_id is not null,
                        'done_by', k.done_by, 'done_by_name', e.name, 'done_at', k.done_at, 'note', k.note)
                        order by i.position, i.created_at)
                       from public.checklist_items i
                       left join public.checklist_ticks k on k.submission_id = s.id and k.item_id = i.id
                       left join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = k.done_by
                      where i.tenant_id = s.tenant_id and i.form_template_id = s.form_template_id
                        and i.track = t.track and i.active))
           order by t.step_index, t.lane), '[]'::jsonb)
    from tracks t, s
   where t.track is not null
     and exists (select 1 from public.checklist_items i
                  where i.tenant_id = s.tenant_id and i.form_template_id = s.form_template_id
                    and i.track = t.track and i.active)
$$;

-- The tracks a form's chain has, and the items each carries.
create or replace function public.checklist_config(p_form uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  with tracks as (
    select app.checklist_track(r.lane, r.stage_label) as track, min(r.step_index) as step_index, min(r.position) as position
      from public.approval_rules r
     where r.tenant_id = app.current_tenant() and r.form_template_id = p_form
     group by 1
    union
    select i.track, 999, 999 from public.checklist_items i
     where i.tenant_id = app.current_tenant() and i.form_template_id = p_form and i.active
  ),
  t as (
    select track, min(step_index) as step_index, min(position) as position from tracks where track is not null group by track
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'track', t.track,
           'items', coalesce((select jsonb_agg(i.item order by i.position, i.created_at)
                                from public.checklist_items i
                               where i.tenant_id = app.current_tenant() and i.form_template_id = p_form
                                 and i.track = t.track and i.active), '[]'::jsonb))
           order by t.step_index, t.position, t.track), '[]'::jsonb)
    from t
$$;

-- Set a track's items, in order. An item no longer listed is retired
-- rather than deleted, so a request that ticked it keeps the record.
create or replace function public.save_checklist(p_form uuid, p_track text, p_items text[])
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_items text[]; v_i int; v_name text;
begin
  if not (app.has_permission('forms.settings') or app.has_permission('org.manage')) then
    raise exception 'changing checklists needs the workflow settings or organisation permission';
  end if;
  select name into v_name from public.form_templates where id = p_form and tenant_id = app.current_tenant();
  if not found then raise exception 'no such form'; end if;
  if coalesce(trim(p_track), '') = '' then raise exception 'say which track the checklist is for'; end if;
  select coalesce(array_agg(x order by o), '{}') into v_items
    from (select distinct on (lower(trim(x))) trim(x) as x, o
            from unnest(coalesce(p_items, '{}')) with ordinality as u(x, o)
           where trim(x) <> '' order by lower(trim(x)), o) d;
  if cardinality(v_items) > 30 then raise exception 'a checklist holds at most 30 items'; end if;
  if exists (select 1 from unnest(v_items) x where length(x) > 200) then raise exception 'an item is at most 200 characters'; end if;

  update public.checklist_items set active = false
   where tenant_id = app.current_tenant() and form_template_id = p_form and track = p_track and active
     and not (item = any (v_items));
  for v_i in 1 .. cardinality(v_items) loop
    update public.checklist_items set position = v_i, active = true
     where tenant_id = app.current_tenant() and form_template_id = p_form and track = p_track and item = v_items[v_i];
    if not found then
      insert into public.checklist_items (tenant_id, form_template_id, track, item, position, created_by)
      values (app.current_tenant(), p_form, p_track, v_items[v_i], v_i, app.current_employee());
    end if;
  end loop;
  perform app.audit('checklist_saved', 'form_template', p_form,
    format('%s — %s: %s item(s)', v_name, p_track, cardinality(v_items)));
  return cardinality(v_items);
end $$;

-- ---------------------------------------------------------------------
-- Reminders at an interval
--
-- A pending step whose rule says "every N hours" reminds whoever holds
-- it once N hours have passed since it opened or since the last such
-- reminder. Run by the daily round and the half-day one
-- (/cron/reminders); half an hour's grace so a twice-daily run keeps a
-- twelve-hour rhythm.
-- ---------------------------------------------------------------------
create or replace function app.interval_reminders()
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare r record; v_n int := 0;
begin
  for r in
    select ar.* from public.approval_requests ar
     where ar.tenant_id = app.current_tenant() and ar.status = 'pending'
       and ar.remind_hours is not null and ar.approver_user_id is not null
       and coalesce((select max(n.created_at) from public.notifications n
                      where n.tenant_id = ar.tenant_id and n.kind = 'approval.reminder'
                        and n.recipient_id = ar.approver_user_id and n.entity_id = ar.subject_id),
                    ar.opened_at, ar.created_at)
           <= now() - make_interval(hours => ar.remind_hours) + interval '30 minutes'
  loop
    perform app.notify(r.approver_user_id, 'approval.reminder',
      'Reminder: ' || app.subject_label(r.subject_type, r.subject_id),
      'This is still waiting on you. A reminder comes every ' || r.remind_hours || ' hours until it is decided'
        || coalesce('; it is due by ' || to_char(r.deadline_at at time zone 'Asia/Dhaka', 'DD/MM/YYYY HH24:MI'), '') || '.',
      r.subject_type, r.subject_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Forwarding within the reporting line
-- ---------------------------------------------------------------------

-- Is one of them above the other? Managers followed up the line from
-- each, twenty levels at most.
create or replace function app.in_reporting_line(p_a text, p_b text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  with recursive up(start, emp, depth) as (
    select x, x, 0 from unnest(array[p_a, p_b]) x
    union all
    select up.start, e.line_manager_id, up.depth + 1
      from up join public.employees e on e.tenant_id = app.current_tenant() and e.employee_id = up.emp
     where e.line_manager_id is not null and up.depth < 20
  )
  select exists (select 1 from up where start = p_a and emp = p_b and depth > 0)
      or exists (select 1 from up where start = p_b and emp = p_a and depth > 0)
$$;

create or replace function app.forward_restricted(p_request uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce((select t.forward_within_line
                     from public.approval_requests ar
                     join public.form_submissions s on s.id = ar.submission_id and s.tenant_id = ar.tenant_id
                     join public.form_templates t on t.id = s.form_template_id and t.tenant_id = s.tenant_id
                    where ar.id = p_request), false)
$$;

create or replace function app.assert_forward_allowed(p_request uuid, p_to text)
returns void
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare v_from text;
begin
  if not app.forward_restricted(p_request) then return; end if;
  select approver_user_id into v_from from public.approval_requests where id = p_request;
  if not app.in_reporting_line(v_from, p_to) then
    raise exception 'this form forwards only within the reporting line: % is neither above nor below %',
      coalesce((select name from public.employees where tenant_id = app.current_tenant() and employee_id = p_to), p_to),
      coalesce((select name from public.employees where tenant_id = app.current_tenant() and employee_id = v_from), v_from);
  end if;
end $$;

-- Who a step may go to: everyone, or only the approver's reporting line.
create or replace function public.forward_candidates(p_request uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select case when not app.forward_restricted(p_request)
              then jsonb_build_object('restricted', false)
              else jsonb_build_object('restricted', true, 'ids',
                     coalesce((select jsonb_agg(e.employee_id order by e.name)
                                 from public.employees e, public.approval_requests ar
                                where ar.id = p_request and e.tenant_id = app.current_tenant() and e.active
                                  and e.employee_id <> ar.approver_user_id
                                  and app.in_reporting_line(ar.approver_user_id, e.employee_id)), '[]'::jsonb))
         end
   where exists (select 1 from public.approval_requests where id = p_request and tenant_id = app.current_tenant())
$$;

-- ---------------------------------------------------------------------
-- IT clearance through ServiceDesk
-- ---------------------------------------------------------------------

-- When the leaver's IT track opens, a ticket is queued for ServiceDesk.
-- Once per request: a step returned and reopened keeps the ticket.
create or replace function app.servicedesk_clearance_on_step()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  l       record;
  v_sub   record;
  v_emp   record;
  v_ans   jsonb;
  v_task  uuid;
  v_ref   text;
begin
  if new.status <> 'pending' or new.submission_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'pending' then return new; end if;
  select * into l from public.servicedesk_links where tenant_id = new.tenant_id;
  if not found or not l.enabled or not l.clearance_enabled then return new; end if;
  if app.checklist_track(new.lane_label, new.stage_label) is distinct from l.clearance_track then return new; end if;
  select s.*, t.name as form_name into v_sub
    from public.form_submissions s join public.form_templates t on t.id = s.form_template_id and t.tenant_id = s.tenant_id
   where s.id = new.submission_id;
  if v_sub.form_name is distinct from l.clearance_form then return new; end if;
  if exists (select 1 from public.servicedesk_tasks where tenant_id = new.tenant_id and submission_id = new.submission_id) then
    return new;
  end if;

  select * into v_emp from public.employees where tenant_id = new.tenant_id and employee_id = v_sub.submitted_by;
  v_ans := app.answers_of(new.submission_id);
  v_ref := coalesce(v_sub.ref_number, left(new.submission_id::text, 8));

  insert into public.servicedesk_tasks (tenant_id, approval_request_id, submission_id)
  values (new.tenant_id, new.id, new.submission_id)
  returning id into v_task;

  insert into public.servicedesk_events (tenant_id, direction, kind, ticket_id, submission_id, status, payload)
  values (new.tenant_id, 'out', 'create', null, new.submission_id, 'queued', jsonb_build_object(
    'task', v_task,
    'request', jsonb_strip_nulls(jsonb_build_object(
      'subject', format('IT clearance: %s (%s), last working day %s',
                        coalesce(v_emp.name, v_sub.submitted_by), v_sub.submitted_by,
                        coalesce(nullif(v_ans ->> 'Last working day', ''), 'not given')),
      'description', format(
        '<p>%s is leaving%s. Please recover their laptop and accessories, disable their email, VPN and system accounts, and revoke official portal access.</p>'
        '<p>When this ticket is resolved, the IT clearance on %s in the Approval Management System clears on its own.</p>',
        coalesce(v_emp.name, v_sub.submitted_by),
        coalesce(' (' || nullif(v_emp.department, '') || ')', ''), v_ref),
      'requester', case when nullif(v_emp.email, '') is not null
                        then jsonb_build_object('email_id', v_emp.email, 'name', v_emp.name) end,
      'category', case when nullif(trim(l.clearance_category), '') is not null
                       then jsonb_build_object('name', trim(l.clearance_category)) end))));
  return new;
end $$;

drop trigger if exists approval_requests_servicedesk_clearance on public.approval_requests;
create trigger approval_requests_servicedesk_clearance
  after insert or update of status on public.approval_requests
  for each row execute function app.servicedesk_clearance_on_step();

-- The ticket exists: remember its number and say so on the request.
create or replace function app.servicedesk_task_opened(p_task uuid, p_ticket text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare k record;
begin
  update public.servicedesk_tasks set ticket_id = p_ticket, status = 'open'
   where id = p_task and status in ('opening', 'failed')
  returning * into k;
  if not found then return; end if;
  perform set_config('app.tenant_id', k.tenant_id::text, true);
  perform app.log_event(k.approval_request_id, 'form_submission', k.submission_id, null,
                        'clearance_ticket', 'ServiceDesk #' || p_ticket);
end $$;

create or replace function app.servicedesk_task_failed(p_task uuid)
returns void
language sql
security definer
set search_path = public, app, pg_temp
as $$
  update public.servicedesk_tasks set status = 'failed' where id = p_task and status = 'opening'
$$;

-- What ServiceDesk says of a clearance ticket. Resolved or closed: the
-- track's checklist is ticked in its approver's name and the step
-- approved, which moves the clearance on as any approval would. Null if
-- the ticket is not one of these.
create or replace function app.servicedesk_clearance_update(p_ticket text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare k record; r record; v_done boolean := coalesce(p_status, '') ~* '^(resolved|closed|completed)$';
begin
  select * into k from public.servicedesk_tasks
   where tenant_id = app.current_tenant() and ticket_id = p_ticket for update;
  if not found then return null; end if;
  update public.servicedesk_tasks set ticket_status = p_status where id = k.id;

  if k.status = 'cleared' then
    return jsonb_build_object('outcome', 'cleared already', 'submission', k.submission_id);
  end if;
  if not v_done then
    insert into public.servicedesk_events (tenant_id, direction, kind, ticket_id, submission_id, status, payload)
    values (k.tenant_id, 'in', 'clearance', p_ticket, k.submission_id, 'received',
            jsonb_build_object('status', p_status, 'outcome', 'still open'));
    return jsonb_build_object('outcome', 'still open', 'status', p_status, 'submission', k.submission_id);
  end if;

  select * into r from public.approval_requests where id = k.approval_request_id;
  if found and r.status = 'pending' then
    insert into public.checklist_ticks (tenant_id, submission_id, item_id, done_by, note)
    select k.tenant_id, k.submission_id, i.id, r.approver_user_id, 'Cleared in ServiceDesk #' || p_ticket
      from public.checklist_items i
      join public.form_submissions s on s.id = k.submission_id and s.tenant_id = i.tenant_id
     where i.tenant_id = k.tenant_id and i.form_template_id = s.form_template_id and i.active
       and i.track = app.checklist_track(r.lane_label, r.stage_label)
    on conflict (submission_id, item_id) do nothing;
    perform public.act_on_approval(r.id, 'approve',
      format('IT clearance completed in ServiceDesk (#%s, %s)', p_ticket, p_status), r.approver_user_id);
  end if;
  update public.servicedesk_tasks set status = 'cleared', cleared_at = now() where id = k.id;
  insert into public.servicedesk_events (tenant_id, direction, kind, ticket_id, submission_id, status, payload)
  values (k.tenant_id, 'in', 'clearance', p_ticket, k.submission_id, 'received',
          jsonb_build_object('status', p_status, 'outcome', case when r.status = 'pending' then 'cleared' else 'noted' end));
  return jsonb_build_object('outcome', 'cleared', 'status', p_status, 'submission', k.submission_id);
end $$;

create or replace function public.save_servicedesk_clearance(p_enabled boolean, p_form text, p_track text, p_category text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.require_permission('integrations.manage');
  if p_enabled and not exists (select 1 from public.form_templates where tenant_id = app.current_tenant() and name = p_form) then
    raise exception 'there is no form called %', p_form;
  end if;
  if p_enabled and coalesce(trim(p_track), '') = '' then raise exception 'say which track is the IT clearance'; end if;
  update public.servicedesk_links
     set clearance_enabled = coalesce(p_enabled, false), clearance_form = nullif(trim(p_form), ''),
         clearance_track = nullif(trim(p_track), ''), clearance_category = nullif(trim(p_category), '')
   where tenant_id = app.current_tenant();
  perform app.audit('servicedesk_clearance_saved', 'servicedesk', null::uuid,
    case when p_enabled then format('IT clearance tickets for %s — %s', p_form, p_track) else 'IT clearance tickets off' end);
end $$;

-- ---------------------------------------------------------------------
-- Passwords apart from application data
--
-- "Store password files separately from application data." The hashes
-- and their history are kept in vault.credentials, a schema the
-- application's role has no access to. Whatever writes a password to an
-- account (registration, a reset, a change) has it moved there by this
-- trigger. In this first step app_users keeps its copy too, so a server
-- still reading it signs people in while a release rolls out; the next
-- release clears it.
-- ---------------------------------------------------------------------
revoke all on schema vault from public;
revoke all on all tables in schema vault from public;
do $$ begin
  execute 'revoke all on schema vault from app_api';
  execute 'revoke all on all tables in schema vault from app_api';
exception when undefined_object then null; end $$;

create or replace function app.keep_credentials()
returns trigger
language plpgsql
security definer
set search_path = public, app, vault, pg_temp
as $$
begin
  if new.password_hash is not null
     and (tg_op = 'INSERT' or new.password_hash is distinct from old.password_hash
          or new.password_history is distinct from old.password_history) then
    insert into vault.credentials as c (user_id, password_hash, password_history, updated_at)
    values (new.id, new.password_hash, coalesce(new.password_history, '{}'), now())
    on conflict (user_id) do update
       set password_hash = excluded.password_hash,
           password_history = case when cardinality(excluded.password_history) > 0
                                   then excluded.password_history else c.password_history end,
           updated_at = now();
  end if;
  return new;
end $$;

drop trigger if exists app_users_keep_credentials on public.app_users;
create trigger app_users_keep_credentials
  before insert or update of password_hash, password_history on public.app_users
  for each row execute function app.keep_credentials();

-- Every account's password, moved once; a later apply leaves newer ones be.
insert into vault.credentials (user_id, password_hash, password_history)
select id, password_hash, coalesce(password_history, '{}') from public.app_users where password_hash is not null
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- The SOW's own exit clearance checklists (§2.2 "Division-Specific
-- Checklist Items"), the leaver's own checklist on the form, and the
-- Payroll settlement after HR's final clearance.
-- ---------------------------------------------------------------------
create or replace function app.sow_exit_checklists()
returns table (track text, items text[])
language sql
immutable
as $$
  values
    ('Own division', array['Handover formality and signed-off note', 'Property recovery (phone, SIM and the like)',
                           'Official social media platforms (Facebook, LinkedIn, Instagram)', 'Other officially used portals',
                           'Chat groups used for official purposes (WhatsApp, Telegram)', 'Other outstanding issue']),
    ('Finance & Accounts', array['Pending IOU or advance', 'Unsettled bills', 'Other payment or recovery', 'Other outstanding issue']),
    ('Supply Chain', array['Mobile SIM (for merchant wallet, if applicable)']),
    ('Administration', array['Property or equipment issued', 'Desk keys', 'Stationeries', 'Seal and business cards', 'Other outstanding issue']),
    ('Product & Technology', array['IT clearance completed in ManageEngine']),
    ('Final settlement', array['Access ID card returned (GD copy if lost)', 'Access card deactivated', 'Exit interview', 'Acceptance of resignation',
                               'Security bond', 'Pending domestic enquiry or investigation', 'Annual leave balance', 'Last LFA applied',
                               'Notice period', 'Other outstanding issue']),
    ('Payroll settlement', array['Clearances and annual leave balance received', 'Final settlement calculated',
                                 'Paid to the nominated bank account', 'HRBP told to issue the release letter and experience certificate'])
$$;

-- The checklists first seeded on 25 November, in our own words; an
-- organisation still on exactly these gets the SOW's.
create or replace function app.first_exit_checklists()
returns text
language sql
immutable
as $$
  select 'Administration:ID and access cards returned|Office keys and locker returned|Official SIM and handset returned;'
      || 'Final settlement:Bank nomination verified|Every department''s clearance confirmed;'
      || 'Finance & Accounts:Advances and loans settled|Corporate card returned or cancelled|Final settlement figures prepared;'
      || 'Own division:Work and files handed over|Open tasks reassigned;'
      || 'Product & Technology:Laptop and accessories returned|Email, VPN and system accounts disabled|Official portal access revoked;'
      || 'Supply Chain:Assets on the inventory list returned|Open purchase orders handed over'
$$;

create or replace function app.seed_exit_clearance(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_exit uuid;
  v_now  text;
  t      record;
  v_i    int;
  v_hr   text;
begin
  select id into v_exit from public.form_templates where tenant_id = p_tenant and name = 'Employee Exit Clearance';
  if v_exit is null then return; end if;

  -- The Payroll team: HR Operations, Payroll & HRIS, who settle last.
  if not exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = 'EMP-0661') then
    v_hr := case when exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = 'EMP-0650') then 'EMP-0650' end;
    insert into public.employees (tenant_id, employee_id, name, designation, department, line_manager_id, gate_pass_card_number, email)
    values (p_tenant, 'EMP-0661', 'Zara Ahmed', 'Payroll & HRIS Lead', 'HR', v_hr, 'CARD-0661', 'zara.ahmed@example.com');
  end if;
  if not exists (select 1 from public.approval_rules where tenant_id = p_tenant and form_template_id = v_exit and label = 'payroll') then
    insert into public.approval_rules (tenant_id, form_template_id, approver_user_id, deadline_days, is_auto_added, label,
                                       step_index, position, stage_label)
    values (p_tenant, v_exit, 'EMP-0661', 5, false, 'payroll',
            coalesce((select max(step_index) + 1 from public.approval_rules where tenant_id = p_tenant and form_template_id = v_exit), 2),
            0, 'Payroll settlement');
  end if;

  -- The SOW's checklists, where an organisation has none or is still on
  -- the first ones; one that changed them keeps its own.
  select string_agg(x.track || ':' || x.items, ';' order by x.track) into v_now
    from (select c.track, string_agg(c.item, '|' order by c.position, c.created_at) as items
            from public.checklist_items c where c.tenant_id = p_tenant and c.form_template_id = v_exit and c.active
           group by c.track) x;
  if v_now is null or v_now = app.first_exit_checklists() then
    update public.checklist_items set active = false
     where tenant_id = p_tenant and form_template_id = v_exit and active;
    for t in select * from app.sow_exit_checklists() loop
      for v_i in 1 .. cardinality(t.items) loop
        update public.checklist_items set active = true, position = v_i
         where tenant_id = p_tenant and form_template_id = v_exit and track = t.track and item = t.items[v_i];
        if not found then
          insert into public.checklist_items (tenant_id, form_template_id, track, item, position)
          values (p_tenant, v_exit, t.track, t.items[v_i], v_i);
        end if;
      end loop;
    end loop;
  elsif not exists (select 1 from public.checklist_items where tenant_id = p_tenant and form_template_id = v_exit and track = 'Payroll settlement') then
    insert into public.checklist_items (tenant_id, form_template_id, track, item, position)
    select p_tenant, v_exit, 'Payroll settlement', u.x, u.o
      from app.sow_exit_checklists() c, unnest(c.items) with ordinality as u(x, o) where c.track = 'Payroll settlement';
  end if;

  -- "The employee fills out a comprehensive checklist (Handover
  -- Formality, Property Recovery, Official Portals)": the leaver's own,
  -- before the bank details.
  if not exists (select 1 from public.form_fields where tenant_id = p_tenant and form_template_id = v_exit and field_name = 'Before you leave') then
    update public.form_fields set order_index = order_index + 6
     where tenant_id = p_tenant and form_template_id = v_exit and order_index >= 4;
    insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, order_index, is_required, field_config)
    values
      (p_tenant, v_exit, 'section_header', 'Before you leave', 4, false, '{}'),
      (p_tenant, v_exit, 'checkbox', 'I have handed over my work, with a signed-off handover note', 5, true, '{}'),
      (p_tenant, v_exit, 'checkbox', 'I have returned company property: phone, SIM, laptop, cards and keys', 6, true, '{}'),
      (p_tenant, v_exit, 'checkbox', 'I have handed over official social media and portal accounts', 7, true, '{}'),
      (p_tenant, v_exit, 'checkbox', 'I have left or handed over official chat groups', 8, true, '{}'),
      (p_tenant, v_exit, 'textarea', 'Anything still outstanding', 9, false, '{"placeholder":"Leave blank if nothing"}');
  end if;
end $$;

-- =====================================================================
-- Roles given to a group
--
-- "Roles can be created based on user group(s)." A role given to a
-- department is held by everybody in it, for as long as they are: the
-- HR file and the directory sync move people, and their roles follow.
-- =====================================================================
drop policy if exists role_groups_member_read on public.role_groups;
create policy role_groups_member_read on public.role_groups for select to app_api
  using (tenant_id = (select app.current_tenant()) and (select app.is_member()));

create or replace function app.held_roles(p_employee text, p_tenant uuid default null)
returns setof uuid
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select r.id
    from public.employee_roles er
    join public.roles r on r.id = er.role_id and r.tenant_id = er.tenant_id
   where er.tenant_id = coalesce(p_tenant, app.current_tenant())
     and er.employee_id = p_employee
     and r.status = 'active'
  union
  select r.id
    from public.role_groups g
    join public.roles r on r.id = g.role_id and r.tenant_id = g.tenant_id
    join public.employees e on e.tenant_id = g.tenant_id and e.department = g.department and e.active
   where g.tenant_id = coalesce(p_tenant, app.current_tenant())
     and e.employee_id = p_employee
     and r.status = 'active'
$$;

create or replace function public.assign_role_group(p_department text, p_role uuid, p_assign boolean)
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
  if not exists (select 1 from public.departments where tenant_id = app.current_tenant() and name = p_department)
     and not exists (select 1 from public.employees where tenant_id = app.current_tenant() and department = p_department) then
    raise exception 'there is no department called %', p_department;
  end if;
  -- The group rule mirrors the personal one: an administrator could
  -- otherwise hand their own department the role that approves roles.
  if exists (select 1 from public.employees where tenant_id = app.current_tenant()
              and employee_id = app.current_employee() and department = p_department) then
    raise exception 'nobody changes the roles of their own department';
  end if;
  if p_assign then
    if v_role.status <> 'active' then raise exception 'only an approved role can be given to a department'; end if;
    insert into public.role_groups (tenant_id, role_id, department, assigned_by)
    values (app.current_tenant(), p_role, p_department, app.current_employee())
    on conflict do nothing;
  else
    delete from public.role_groups where tenant_id = app.current_tenant() and role_id = p_role and department = p_department;
  end if;
  perform app.audit(case when p_assign then 'role_assigned' else 'role_removed' end, 'role', p_role,
                    v_role.name || case when p_assign then ' given to everyone in ' else ' taken from everyone in ' end || p_department);
end $$;

-- =====================================================================
-- Who is told, and when
--
-- "Define the criteria for sending notifications." A form's watchers are
-- told when a request is raised, approved or rejected — whichever each
-- names — and, with a condition, only when the answers meet it.
-- =====================================================================
create or replace function app.watchers_for(p_submission uuid, p_event text)
returns setof text
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select distinct w.who
    from (
      select case
               when app.rule_role(nr.label) = 'submitter' then s.submitted_by
               when app.rule_role(nr.label) = 'creator' then coalesce(t.created_by, nr.notifyee_user_id)
               when app.is_org_role(app.rule_role(nr.label))
                 then coalesce(app.resolve_role(app.rule_role(nr.label), s.submitted_by), nr.notifyee_user_id)
               else nr.notifyee_user_id
             end as who
        from public.form_submissions s
        join public.form_templates t on t.id = s.form_template_id and t.tenant_id = s.tenant_id
        join public.notification_rules nr on nr.form_template_id = s.form_template_id and nr.tenant_id = s.tenant_id
       where s.id = p_submission
         and p_event = any (coalesce(nr.events, '{raised}'))
         and (nr.condition is null or app.condition_holds(app.answers_of(s.id), nr.condition))
    ) w
   where w.who is not null
$$;

-- Approved or rejected: the watchers who asked to hear it are told.
-- The requester hears from the engine already, so not twice from here.
create or replace function app.watchers_on_event()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_event text; r record; v_requester text;
begin
  if new.subject_type <> 'form_submission' then return new; end if;
  v_event := case new.action when 'completed' then 'approved' when 'rejected' then 'rejected' end;
  if v_event is null then return new; end if;
  -- A step's rejection ends the request; one notice for it.
  if v_event = 'rejected' and exists (select 1 from public.approval_events e
                                        where e.subject_id = new.subject_id and e.action = 'rejected' and e.id <> new.id) then
    return new;
  end if;
  select submitted_by into v_requester from public.form_submissions where id = new.subject_id;
  for r in select who from app.watchers_for(new.subject_id, v_event) who where who is distinct from v_requester loop
    perform app.notify(r.who, 'watch.' || v_event,
      case v_event when 'approved' then 'A request you watch was approved' else 'A request you watch was rejected' end,
      app.subject_label('form_submission', new.subject_id)
        || case v_event when 'approved' then ' has been approved by everybody it needed.' else ' was not approved.' end,
      'form_submission', new.subject_id);
  end loop;
  return new;
end $$;

drop trigger if exists approval_events_watchers on public.approval_events;
create trigger approval_events_watchers after insert on public.approval_events
  for each row execute function app.watchers_on_event();

-- =====================================================================
-- Trackers
-- =====================================================================
drop policy if exists trackers_member_read on public.trackers;
create policy trackers_member_read on public.trackers for select to app_api
  using (tenant_id = (select app.current_tenant()) and (select app.is_member())
         and (shared_with = 'everyone' or owner_id = app.current_employee()
              or (shared_with = 'department' and department = (select e.department from public.employees e
                                                                 where e.tenant_id = trackers.tenant_id
                                                                   and e.employee_id = app.current_employee()))));
drop policy if exists tracker_reminders_own_read on public.tracker_reminders;
create policy tracker_reminders_own_read on public.tracker_reminders for select to app_api
  using (tenant_id = (select app.current_tenant()) and (select app.is_member()) and employee_id = app.current_employee());

-- Requests as a tracker shows them: where each is, with whom, since when,
-- and the reminder the person looking has set on it.
create or replace function public.tracker_rows(p_filters jsonb)
returns table (id uuid, reference text, form text, category text, requester text, requester_name text, department text,
               status text, priority text, flag text, submitted_at timestamptz, with_whom text, stage text,
               waiting_since timestamptz, due_at timestamptz, overdue boolean, remind_on date, reminder_note text)
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  with f as (
    select coalesce(p_filters, '{}'::jsonb) as j
  ),
  -- Where each request stands, kept current as its steps change
  -- (submission_stats, db/007_reports.sql).
  open_steps as (
    select st.submission_id, st.waiting_on as with_whom, st.current_stage as stage,
           st.waiting_since, st.next_deadline as due_at
      from public.submission_stats st
     where st.tenant_id = app.current_tenant() and st.waiting_on is not null
  )
  select s.id, s.ref_number, t.name, t.category, s.submitted_by, re.name, re.department,
         s.status, coalesce(s.priority, 'normal'), s.flag, s.submitted_at,
         o.with_whom, o.stage, o.waiting_since, o.due_at, coalesce(o.due_at < now(), false),
         tr.remind_on, tr.note
    from public.form_submissions s
    join public.form_templates t on t.id = s.form_template_id and t.tenant_id = s.tenant_id
    left join public.employees re on re.tenant_id = s.tenant_id and re.employee_id = s.submitted_by
    left join open_steps o on o.submission_id = s.id
    -- The reminders of the person looking: a handful, joined once.
    left join (select distinct on (x.submission_id) x.submission_id, x.remind_on, x.note
                 from public.tracker_reminders x
                where x.tenant_id = app.current_tenant() and x.employee_id = app.current_employee() and x.sent_at is null
                order by x.submission_id, x.remind_on) tr on tr.submission_id = s.id
    cross join f
   where s.tenant_id = app.current_tenant()
     and s.status <> 'draft' and s.archived_at is null
     and (not (f.j ? 'forms') or jsonb_array_length(f.j -> 'forms') = 0 or t.name in (select jsonb_array_elements_text(f.j -> 'forms')))
     and (not (f.j ? 'statuses') or jsonb_array_length(f.j -> 'statuses') = 0 or s.status in (select jsonb_array_elements_text(f.j -> 'statuses')))
     and (not (f.j ? 'departments') or jsonb_array_length(f.j -> 'departments') = 0 or re.department in (select jsonb_array_elements_text(f.j -> 'departments')))
     and (coalesce(f.j ->> 'priority', '') = '' or coalesce(s.priority, 'normal') = f.j ->> 'priority')
     and (not coalesce((f.j ->> 'flagged')::boolean, false) or s.flag is not null)
     and (not coalesce((f.j ->> 'overdue')::boolean, false) or coalesce(o.due_at < now(), false))
     and (coalesce(f.j ->> 'from', '') = '' or (s.submitted_at at time zone 'Asia/Dhaka')::date >= (f.j ->> 'from')::date)
     and (coalesce(f.j ->> 'to', '') = '' or (s.submitted_at at time zone 'Asia/Dhaka')::date <= (f.j ->> 'to')::date)
     and (coalesce(f.j ->> 'search', '') = ''
          or concat_ws(' ', s.ref_number, s.legacy_ref, t.name, re.name, s.submitted_by) ilike '%' || (f.j ->> 'search') || '%')
   -- Earliest deadline first: the overdue are the earliest, so they lead.
   order by o.due_at nulls last, s.submitted_at desc
   limit 1000
$$;

-- The same, as one JSON list, for the screen (the data endpoint returns
-- one value per call).
create or replace function public.tracker_list(p_filters jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from public.tracker_rows(p_filters) r
$$;

create or replace function public.save_tracker(p_id uuid, p_name text, p_description text, p_shared_with text, p_filters jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_id uuid; v_owner text; v_dept text;
begin
  if app.current_employee() is null then raise exception 'sign in to keep a tracker'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'a tracker needs a name'; end if;
  if p_shared_with not in ('me', 'department', 'everyone') then raise exception 'share it with me, my department or everyone'; end if;
  if jsonb_typeof(coalesce(p_filters, '{}')) <> 'object' then raise exception 'filters must be an object'; end if;
  select department into v_dept from public.employees where tenant_id = app.current_tenant() and employee_id = app.current_employee();
  if p_id is null then
    insert into public.trackers (tenant_id, name, description, owner_id, shared_with, department, filters)
    values (app.current_tenant(), trim(p_name), nullif(trim(p_description), ''), app.current_employee(), p_shared_with, v_dept, coalesce(p_filters, '{}'))
    returning id into v_id;
  else
    select owner_id into v_owner from public.trackers where id = p_id and tenant_id = app.current_tenant();
    if not found then raise exception 'no such tracker'; end if;
    if v_owner is distinct from app.current_employee() and not app.has_permission('reports.manage') then
      raise exception 'only whoever made a tracker changes it';
    end if;
    update public.trackers
       set name = trim(p_name), description = nullif(trim(p_description), ''), shared_with = p_shared_with,
           department = coalesce(department, v_dept), filters = coalesce(p_filters, '{}'), updated_at = now()
     where id = p_id
    returning id into v_id;
  end if;
  perform app.audit('tracker_saved', 'tracker', v_id, trim(p_name) || ' — shared with ' || p_shared_with);
  return v_id;
end $$;

create or replace function public.delete_tracker(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  select * into v from public.trackers where id = p_id and tenant_id = app.current_tenant();
  if not found then raise exception 'no such tracker'; end if;
  if v.owner_id is distinct from app.current_employee() and not app.has_permission('reports.manage') then
    raise exception 'only whoever made a tracker removes it';
  end if;
  delete from public.trackers where id = p_id;
  perform app.audit('tracker_deleted', 'tracker', p_id, v.name);
end $$;

-- "Alerts/reminders for each item": the person looking is reminded about
-- a request on the day they choose; null clears it.
create or replace function public.set_tracker_reminder(p_submission uuid, p_on date, p_note text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if app.current_employee() is null then raise exception 'sign in to set a reminder'; end if;
  -- One you can see (db/009_visibility.sql).
  if not app.can_see_submission(p_submission) then
    raise exception 'no such request';
  end if;
  delete from public.tracker_reminders
   where tenant_id = app.current_tenant() and submission_id = p_submission and employee_id = app.current_employee() and sent_at is null;
  if p_on is not null then
    if p_on < (now() at time zone 'Asia/Dhaka')::date then raise exception 'a reminder is for today or later'; end if;
    insert into public.tracker_reminders (tenant_id, submission_id, employee_id, remind_on, note)
    values (app.current_tenant(), p_submission, app.current_employee(), p_on, nullif(trim(p_note), ''));
  end if;
end $$;

-- The daily round sends the reminders due.
create or replace function app.tracker_reminders_due()
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare r record; v_n int := 0;
begin
  for r in
    select x.* from public.tracker_reminders x
     where x.tenant_id = app.current_tenant() and x.sent_at is null
       and x.remind_on <= (now() at time zone 'Asia/Dhaka')::date
  loop
    perform app.notify(r.employee_id, 'tracker.reminder',
      'Reminder: ' || app.subject_label('form_submission', r.submission_id),
      coalesce(r.note, 'You asked to be reminded about this today.'), 'form_submission', r.submission_id);
    update public.tracker_reminders set sent_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- What every organisation starts with: a tracker each for ABC, exit
-- clearance and what is overdue, and Treasury told of a large capital
-- expenditure once it is approved.
create or replace function app.seed_configuration(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_capex uuid;
begin
  if not exists (select 1 from public.trackers where tenant_id = p_tenant) then
    insert into public.trackers (tenant_id, name, description, owner_id, shared_with, department, filters) values
      (p_tenant, 'ABC declarations', 'Gift, hospitality and donation declarations, for Compliance to follow up',
       case when exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = 'EMP-0830') then 'EMP-0830' end,
       'department', 'Compliance', '{"forms": ["Gift & Hospitality Declaration"]}'),
      (p_tenant, 'Exit clearances in progress', 'Leavers whose clearance is not finished',
       case when exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = 'EMP-0650') then 'EMP-0650' end,
       'everyone', 'HR', '{"forms": ["Employee Exit Clearance"], "statuses": ["submitted", "in_progress", "on_hold"]}'),
      (p_tenant, 'Overdue approvals', 'Everything past its deadline, most overdue first',
       case when exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = 'EMP-0445') then 'EMP-0445' end,
       'everyone', 'Admin', '{"overdue": true}');
  end if;
  select id into v_capex from public.form_templates where tenant_id = p_tenant and name = 'Capital Expenditure Request';
  if v_capex is not null and exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = 'EMP-0700')
     and not exists (select 1 from public.notification_rules where tenant_id = p_tenant and form_template_id = v_capex and condition is not null) then
    insert into public.notification_rules (tenant_id, form_template_id, notifyee_user_id, is_auto_added, label, events, condition)
    values (p_tenant, v_capex, 'EMP-0700', false, 'Manually added', array['approved'],
            '{"field": "Amount", "op": "gt", "value": "1000000"}');
  end if;
end $$;

-- =====================================================================
-- Push notifications
--
-- Every notification the bell gets is queued for push as well, when its
-- recipient has a device with notifications on; src/server/push.ts sends
-- the queue. Tapping one opens what it is about.
-- =====================================================================
create or replace function app.queue_push()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if exists (select 1 from public.push_subscriptions s where s.tenant_id = new.tenant_id and s.employee_id = new.recipient_id) then
    insert into public.push_outbox (tenant_id, employee_id, notification_id, title, body, url, tag)
    values (new.tenant_id, new.recipient_id, new.id, coalesce(new.title, 'Admin Services Portal'), left(coalesce(new.body, ''), 300),
            case when new.kind like 'approval.%' and new.kind <> 'approval.escalated' then '/approvals'
                 when new.entity_type = 'form_submission' and new.entity_id is not null then '/status/' || new.entity_id
                 when new.entity_type = 'notice' and new.entity_id is not null then '/notices/' || new.entity_id
                 when new.entity_type = 'stationery_request' then '/stationery'
                 when new.entity_type = 'maintenance_request' then '/maintenance'
                 else '/' end,
            coalesce(new.entity_id::text, new.kind));
  end if;
  return new;
end $$;

drop trigger if exists notifications_queue_push on public.notifications;
create trigger notifications_queue_push after insert on public.notifications
  for each row execute function app.queue_push();

-- ---------------------------------------------------------------------
-- What every organisation starts with
-- ---------------------------------------------------------------------
create or replace function app.seed_sow_gaps(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_form uuid;
  f      record;
begin
  -- The SOW's other forms, each with its fields and its approvers.
  for f in
    select * from (values
      ('New SIM Requisition', 'Admin', 'operational', array['sim', 'mobile', 'connection', 'requisition'], 'EMP-0445', false,
       '[["gen_employee_name","Employee name",true,{}],
         ["select","SIM type",true,{"options":["Prepaid","Postpaid","eSIM"]}],
         ["number","Number of SIMs",true,{}],
         ["select","Package",true,{"options":["Voice and data","Data only","Voice only"]}],
         ["money","Monthly usage limit",true,{}],
         ["textarea","Business justification",true,{}]]',
       '[["line_manager","EMP-1134",2,true,0,null],["admin","EMP-0445",2,false,1,"SIM issuance"]]'),
      ('SIM Transfer', 'Admin', 'operational', array['sim', 'transfer', 'ownership', 'mobile'], 'EMP-0445', false,
       '[["gen_employee_name","Employee name",true,{}],
         ["phone","Mobile number",true,{}],
         ["employee","Transfer to",true,{}],
         ["select","Reason",true,{"options":["Role change","Leaving the company","Department move","Other"]}],
         ["date","Effective date",true,{}]]',
       '[["line_manager","EMP-1134",2,true,0,null],["admin","EMP-0445",2,false,1,"SIM transfer"]]'),
      ('Fraud Incident Fund Transfer', 'Finance', 'regulatory', array['fraud', 'incident', 'fund', 'transfer', 'refund', 'reversal'], 'EMP-0312', true,
       '[["gen_employee_name","Employee name",true,{}],
         ["text","Incident reference",true,{}],
         ["date","Incident date",true,{}],
         ["phone","Customer wallet number",true,{}],
         ["money","Amount",true,{}],
         ["select","Transfer type",true,{"options":["Refund to customer","Reversal","Recovery from agent"]}],
         ["textarea","What happened",true,{}],
         ["file","Evidence",false,{}]]',
       '[["line_manager","EMP-1134",1,true,0,null],["compliance","EMP-0830",1,false,1,"Fraud risk review"],["slab_finance",null,2,true,2,null]]'),
      ('Compensatory Allowance', 'HR', 'budgetary', array['allowance', 'compensatory', 'holiday duty', 'weekend'], 'EMP-0201', false,
       '[["gen_employee_name","Employee name",true,{}],
         ["date","Date worked",true,{}],
         ["select","Day type",true,{"options":["Weekend","Public holiday","Office closure"]}],
         ["number","Hours worked",true,{}],
         ["textarea","Work done",true,{}]]',
       '[["line_manager","EMP-1134",2,true,0,null],["hrbp","EMP-0201",2,false,1,"HR review"]]'),
      ('Night Allowance', 'HR', 'budgetary', array['allowance', 'night', 'shift'], 'EMP-0201', false,
       '[["gen_employee_name","Employee name",true,{}],
         ["daterange","Period",true,{}],
         ["number","Nights worked",true,{}],
         ["money","Rate per night",true,{}],
         ["calculation","Total allowance",false,{"formula":"{Nights worked} * {Rate per night}"}],
         ["textarea","Note",false,{}]]',
       '[["line_manager","EMP-1134",2,true,0,null],["hrbp","EMP-0201",2,false,1,"HR review"]]')
    ) as x(name, category, classification, keywords, created_by, within_line, fields, rules)
  loop
    continue when exists (select 1 from public.form_templates where tenant_id = p_tenant and name = f.name);
    insert into public.form_templates (tenant_id, name, category, created_by, status, classification, keywords, forward_within_line)
    values (p_tenant, f.name, f.category,
            case when exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = f.created_by) then f.created_by end,
            'published', f.classification, f.keywords, f.within_line)
    returning id into v_form;
    insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, order_index, is_required, field_config)
    select p_tenant, v_form, e ->> 0, e ->> 1, (o - 1)::int, (e ->> 2)::boolean, e -> 3
      from jsonb_array_elements(f.fields::jsonb) with ordinality as a(e, o);
    insert into public.approval_rules (tenant_id, form_template_id, approver_user_id, deadline_days, is_auto_added, label, step_index, position, stage_label)
    select p_tenant, v_form,
           case when exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = e ->> 1) then e ->> 1 end,
           (e ->> 2)::int, (e ->> 3)::boolean, e ->> 0, (e ->> 4)::int, 0, e ->> 5
      from jsonb_array_elements(f.rules::jsonb) e;
    if f.name = 'Fraud Incident Fund Transfer' then
      insert into public.approval_slabs (tenant_id, form_template_id, min_amount, max_amount, approver_user_id, order_index)
      select p_tenant, v_form, s.min_amount, null, s.emp, s.ord
        from (values (0::numeric, 'EMP-0312', 0), (100000.01, 'EMP-0600', 1), (1000000.01, 'EMP-0700', 2)) s(min_amount, emp, ord)
       where exists (select 1 from public.employees where tenant_id = p_tenant and employee_id = s.emp);
    end if;
  end loop;

  -- Exit clearance: the SOW's checklists, the leaver's own, and Payroll.
  perform app.seed_exit_clearance(p_tenant);
  -- Trackers, and a notification with a condition.
  perform app.seed_configuration(p_tenant);

  -- Business Finance reviews: T+2, with a reminder every 12 hours.
  update public.approval_rules set remind_hours = 12
   where tenant_id = p_tenant and remind_hours is null
     and (label = 'business_finance' or label like 'answer:Business finance%');
  update public.approval_requests set remind_hours = 12
   where tenant_id = p_tenant and remind_hours is null and status in ('pending', 'waiting')
     and stage_label = 'Business finance review';

  -- A leaver's IT clearance goes to ServiceDesk, once it is connected.
  update public.servicedesk_links
     set clearance_enabled = true, clearance_form = 'Employee Exit Clearance', clearance_track = 'Product & Technology'
   where tenant_id = p_tenant and clearance_form is null;
end $$;

commit;
