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
                      using (tenant_id = app.current_tenant() and app.is_member())$f$, t);
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
  v_exit uuid;
  t      record;
  v_i    int;
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

  -- Exit clearance: what each department checks before it clears.
  select id into v_exit from public.form_templates where tenant_id = p_tenant and name = 'Employee Exit Clearance';
  if v_exit is not null and not exists (select 1 from public.checklist_items where tenant_id = p_tenant and form_template_id = v_exit) then
    for t in
      select * from (values
        ('Own division',         array['Work and files handed over', 'Open tasks reassigned']),
        ('Finance & Accounts',   array['Advances and loans settled', 'Corporate card returned or cancelled', 'Final settlement figures prepared']),
        ('Supply Chain',         array['Assets on the inventory list returned', 'Open purchase orders handed over']),
        ('Administration',       array['ID and access cards returned', 'Office keys and locker returned', 'Official SIM and handset returned']),
        ('Product & Technology', array['Laptop and accessories returned', 'Email, VPN and system accounts disabled', 'Official portal access revoked']),
        ('Final settlement',     array['Bank nomination verified', 'Every department''s clearance confirmed'])
      ) as c(track, items)
    loop
      for v_i in 1 .. cardinality(t.items) loop
        insert into public.checklist_items (tenant_id, form_template_id, track, item, position, created_by)
        values (p_tenant, v_exit, t.track, t.items[v_i], v_i, null);
      end loop;
    end loop;
  end if;

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
