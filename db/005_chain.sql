-- =====================================================================
-- The approval chain.
--
-- Before this, "approval" meant three unrelated things. Form submissions
-- created every approver's request at once, all pending, so a CFO could
-- approve before the line manager had looked. Notices and Stationery
-- walked a hardcoded array in the frontend and never appeared in the
-- queue, the history or the timeline at all. Maintenance had no chain.
--
-- Now there is one engine, and it is here rather than in the browser for
-- two reasons: advancing a chain is several writes that must all happen
-- or none, and whose turn it is has to be decided somewhere a client
-- cannot simply skip.
--
-- SECURITY INVOKER throughout. These run as app_api like every other
-- statement, so row-level security decides which chains are even
-- visible, and a caller cannot reach another tenant's approvals.
-- =====================================================================

begin;

-- The three functions that move a chain gained a p_actor parameter.
-- `create or replace` with a different argument list makes a second
-- function beside the first rather than replacing it, and a three-
-- argument call would then go on resolving to the old one, unchecked.
drop function if exists public.act_on_approval(uuid, text, text);
drop function if exists public.reassign_approval(uuid, text, text);
drop function if exists public.add_reviewer(uuid, text, int);
-- Conditions are now judged against a set of answers rather than a
-- stored submission, so the same planner serves a preview.
drop function if exists app.condition_holds(uuid, jsonb);
drop function if exists app.answer_of(uuid, text);
-- Stage 2: the plan carries a signature requirement and a flag, and
-- approving can carry a signature. A changed return type or argument
-- list cannot be replaced in place.
drop function if exists app.plan_chain(text, uuid, text, jsonb);
drop function if exists public.act_on_approval(uuid, text, text, text);

-- ---------------------------------------------------------------------
-- Targets land on working days.
--
-- "Three days" meaning Thursday to Sunday is the kind of detail that
-- makes a deadline useless: a third of every target used to fall on a
-- weekend nobody was working, so requests arrived already overdue.
--
-- The weekend is Friday and Saturday, and the day is the one on the wall
-- in Dhaka. It was Saturday and Sunday in UTC, which in Bangladesh meant
-- every Friday counted as a working day, every Sunday did not, and from
-- 18:00 local the server was already deciding about tomorrow.
-- ---------------------------------------------------------------------
--
-- And not on a holiday: the organisation's working calendar
-- (public.holidays) — Eid, Puja, Victory Day — is skipped as the
-- weekend is, so a three-day target set before Eid lands after it.
-- ---------------------------------------------------------------------
create or replace function app.is_working_day(p_tenant uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  -- isodow: 1 = Monday … 5 = Friday, 6 = Saturday, 7 = Sunday
  select extract(isodow from p_day) not in (5, 6)
     and not exists (select 1 from public.holidays h where h.tenant_id = p_tenant and h.on_date = p_day)
$$;

create or replace function app.add_working_days(p_from timestamptz, p_days int, p_tenant uuid)
returns timestamptz
language plpgsql
stable
as $$
declare
  d timestamptz := p_from;
  n int := 0;
begin
  if p_days is null or p_days <= 0 then
    return p_from;
  end if;
  while n < p_days loop
    d := d + interval '1 day';
    if app.is_working_day(p_tenant, (d at time zone 'Asia/Dhaka')::date) then
      n := n + 1;
    end if;
  end loop;
  return d;
end $$;

-- The organisation in context.
create or replace function app.add_working_days(p_from timestamptz, p_days int)
returns timestamptz
language sql
stable
as $$
  select app.add_working_days(p_from, p_days, app.current_tenant())
$$;

-- ---------------------------------------------------------------------
-- Whose manager is this?
--
-- Scoped to the current tenant explicitly. Under the application the
-- policies would do it anyway, but the seed runs as the owner, which
-- bypasses them — and every evaluation is a clone, so an employee id
-- alone names one person in every tenant at once.
-- ---------------------------------------------------------------------
create or replace function app.line_manager_of(p_employee text)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select e.line_manager_id
    from public.employees e
   where e.employee_id = p_employee
     and e.tenant_id = app.current_tenant()
$$;

-- ---------------------------------------------------------------------
-- May this person act on this step?
--
-- The step's own approver may, and so may somebody they have delegated
-- to — but only inside the delegation's dates, judged on the Dhaka
-- calendar, and only for the forms it names. A delegation scoped to
-- particular forms does not carry a notice or a maintenance request
-- with it. This is the same rule the approvals queue applies when it
-- decides what to show; until now it was applied nowhere else, so a
-- delegate could act outside their window by calling the endpoint.
--
-- Who is acting is still asserted by the client while one login stands
-- for a whole evaluation and the persona switcher picks the employee.
-- What this buys today is that the chain cannot be moved by the wrong
-- person through any screen; once sign-in names the employee, the same
-- check becomes the access control.
-- ---------------------------------------------------------------------
create or replace function app.may_act(
  p_approver     text,
  p_subject_type text,
  p_subject_id   uuid,
  p_actor        text
) returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select p_actor is not null and p_approver is not null and (
    p_actor = p_approver
    or exists (
      select 1
        from public.delegation_rules d
       where d.tenant_id = app.current_tenant()
         and d.delegator_id = p_approver
         and d.delegate_id  = p_actor
         and (now() at time zone 'Asia/Dhaka')::date between d.start_date and d.end_date
         and (d.form_template_ids is null
              or (p_subject_type = 'form_submission'
                  and (select s.form_template_id
                         from public.form_submissions s
                        where s.id = p_subject_id) = any (d.form_template_ids)))))
$$;

create or replace function app.assert_may_act(
  p_approver     text,
  p_subject_type text,
  p_subject_id   uuid,
  p_actor        text
) returns void
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_actor is null or p_actor = '' then
    raise exception 'say who is acting on this step';
  end if;
  if not app.may_act(p_approver, p_subject_type, p_subject_id, p_actor) then
    raise exception '% cannot act on this step: it is with %, and % holds no delegation from them that covers it today',
      p_actor, coalesce(p_approver, 'nobody'), p_actor;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Which kind of rule is this?
--
-- The builder used to save the reason it showed on screen as the label,
-- so forms built before the labels were fixed carry "Added: Employee
-- field" where the seed says line_manager. Both mean the same thing, and
-- reading both is what lets every evaluation already issued pick up the
-- new routing without its data being rewritten.
-- ---------------------------------------------------------------------
create or replace function app.rule_role(p_label text)
returns text
language sql
immutable
as $$
  select case p_label
           when 'Added: Employee field' then 'line_manager'
           when 'Added: Submitter'      then 'submitter'
           when 'Added: Form creator'   then 'creator'
           else p_label
         end
$$;

-- ---------------------------------------------------------------------
-- Who asked for this, and what is it called?
--
-- Four subject tables, four different column names for the same two
-- questions. Answered here so the notification text does not have to
-- know which kind of thing it is describing.
-- ---------------------------------------------------------------------
create or replace function app.subject_requester(p_type text, p_id uuid)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select case p_type
    when 'form_submission'     then (select submitted_by from public.form_submissions where id = p_id)
    when 'notice'              then (select created_by   from public.notices           where id = p_id)
    when 'stationery_request'  then (select requester_id from public.stationery_requests where id = p_id)
    when 'maintenance_request' then (select requester_id from public.maintenance_requests where id = p_id)
  end
$$;

-- The reference a person sees on screen, so a notification can name the
-- same thing the status page does.
create or replace function app.subject_ref(p_id uuid)
returns text
language sql
immutable
as $$
  select 'AMS-' || upper(left(p_id::text, 8))
$$;

create or replace function app.subject_label(p_type text, p_id uuid)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  -- The reference matters as much as the name. A maintenance request
  -- carries its ref_number here, so "MR-2201 is waiting on you" names one
  -- thing; a form submission carried only its template name, so somebody
  -- with two travel claims open got "Travel & Expense Reimbursement has
  -- cleared every approver" and no way to tell which. AMS- plus the head
  -- of the id is the same reference the status screen already prints.
  select coalesce(case p_type
    when 'form_submission' then (
      select coalesce('[' || fs.flag || '] ', '')
             || ft.name || ' (' || coalesce(fs.ref_number, app.subject_ref(fs.id)) || ')'
        from public.form_submissions fs
        left join public.form_templates ft
          on ft.id = fs.form_template_id and ft.tenant_id = fs.tenant_id
       where fs.id = p_id)
    when 'notice' then (select title from public.notices where id = p_id)
    when 'stationery_request' then (
      select case kind when 'business_card' then 'Business card'
                       when 'stamp_seal'    then 'Stamp and seal'
                       else coalesce(kind, 'Stationery') end
             || coalesce(' for ' || nullif(btrim(name), ''), '')
        from public.stationery_requests where id = p_id)
    when 'maintenance_request' then (select ref_number from public.maintenance_requests where id = p_id)
  end, 'a request')
$$;

-- ---------------------------------------------------------------------
-- Tell somebody.
--
-- In-app only. There is no mail or SMS gateway behind this and the
-- interface says so rather than implying one — a notification that
-- silently goes nowhere is worse than none, because people stop
-- checking the place it should have appeared.
--
-- A recipient who is not an employee of this tenant is skipped rather
-- than raised: a chain event should never fail because somebody's
-- record was removed.
-- ---------------------------------------------------------------------
create or replace function app.notify(
  p_recipient   text,
  p_kind        text,
  p_title       text,
  p_body        text default null,
  p_entity_type text default null,
  p_entity_id   uuid default null
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_recipient is null or p_recipient = '' then
    return;
  end if;
  if not exists (select 1 from public.employees where employee_id = p_recipient) then
    return;
  end if;

  insert into public.notifications (recipient_id, kind, title, body, entity_type, entity_id)
  values (p_recipient, p_kind, p_title, p_body, p_entity_type, p_entity_id);

  -- Whoever stands in for them today is told too, about a step they may
  -- now act on: otherwise a delegation works but nobody knows a step waits.
  if p_kind in ('approval.turn', 'approval.reminder', 'approval.due_soon', 'approval.overdue') then
    insert into public.notifications (recipient_id, kind, title, body, entity_type, entity_id)
    select d.delegate_id, p_kind,
           p_title || ' (standing in for ' || coalesce((select e.name from public.employees e
                                                         where e.tenant_id = d.tenant_id and e.employee_id = p_recipient), p_recipient) || ')',
           p_body, p_entity_type, p_entity_id
      from public.delegation_rules d
     where d.tenant_id = app.current_tenant() and d.delegator_id = p_recipient
       and (now() at time zone 'Asia/Dhaka')::date between d.start_date and d.end_date
       and (d.form_template_ids is null
            or (p_entity_type = 'form_submission'
                and (select s.form_template_id from public.form_submissions s where s.id = p_entity_id) = any (d.form_template_ids)));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Which approvers does an amount involve?
--
-- Cumulative. A slab is a threshold that has been crossed, not a bucket
-- that a number falls into, so 620,000 involves the Controller, the Head
-- of Finance AND the CFO — in that order. The previous build returned
-- exactly one approver, which is why a 600,000 claim skipped the two
-- people whose sign-off the policy actually requires.
-- ---------------------------------------------------------------------
create or replace function app.slab_approvers(p_form uuid, p_amount numeric)
returns table (approver_user_id text, ord int)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select s.approver_user_id,
         row_number() over (order by s.order_index)::int
    from public.approval_slabs s
   where s.form_template_id = p_form
     and p_amount >= s.min_amount
   order by s.order_index
$$;

-- ---------------------------------------------------------------------
-- A subject's status, in its own vocabulary.
--
-- Four tables, four sets of words for the same four states. The engine
-- speaks in states; this translates. It also keeps current_approver_id
-- pointing at whoever the chain is waiting on, because the notice and
-- stationery screens read that column directly.
-- ---------------------------------------------------------------------
create or replace function app.set_subject_status(
  p_type text, p_id uuid, p_state text, p_approver text default null
) returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if p_state not in ('open', 'done', 'rejected', 'held') then
    raise exception 'unknown chain state: %', p_state;
  end if;

  v_status := case p_type
    when 'form_submission' then
      case p_state when 'open' then 'in_progress' when 'done' then 'completed'
                   when 'rejected' then 'rejected' else 'on_hold' end
    when 'notice' then
      case p_state when 'open' then 'pending' when 'done' then 'published'
                   when 'rejected' then 'rejected' else 'pending' end
    when 'stationery_request' then
      case p_state when 'open' then 'open' when 'done' then 'approved'
                   when 'rejected' then 'rejected' else 'open' end
    -- Maintenance has a life after approval: once the chain finishes it
    -- is approved, and only then does anyone mark it in progress or
    -- completed. So a chain still running leaves it raised rather than
    -- claiming work has started.
    when 'maintenance_request' then
      case p_state when 'open' then 'raised' when 'done' then 'approved'
                   when 'rejected' then 'rejected' else 'on_hold' end
  end;

  if v_status is null then
    raise exception 'unknown subject type: %', p_type;
  end if;

  case p_type
    when 'form_submission' then
      update public.form_submissions set status = v_status where id = p_id;
    when 'notice' then
      update public.notices
         set status = v_status, current_approver_id = p_approver
       where id = p_id;
    when 'stationery_request' then
      update public.stationery_requests
         set status = v_status, current_approver_id = p_approver
       where id = p_id;
    when 'maintenance_request' then
      update public.maintenance_requests set status = v_status where id = p_id;
  end case;

  return v_status;
end $$;

-- ---------------------------------------------------------------------
-- The shape of a chain.
--
-- A chain is phases, run one after another (step_index). A phase runs
-- one or more lanes at the same time (lane), and a lane is steps in
-- order (lane_step). Inside a phase, the live step of every lane is
-- `pending` at once; a lane moves on when its live step is approved; the
-- phase is done when all of its lanes are — or, when the phase has a
-- quorum, when that many of them are. Then the next phase opens.
--
-- Everything built before lanes existed is one lane per phase, which is
-- the plain sequence it always was. The HR exit clearance is the shape
-- that needs all of it: the requester's division signs off LM → HoD →
-- HRBP → CXO in one lane while Finance, Supply Chain, Administration and
-- IT clear it in four others, and HR closes it only after all five.
-- ---------------------------------------------------------------------

-- The leading number in an answer stored as text: "BDT 620,000.50" is
-- 620000.50, "" is nothing.
create or replace function app.leading_number(p_text text)
returns numeric
language sql
immutable
as $$
  select nullif(substring(regexp_replace(coalesce(p_text, ''), '[^0-9.]', '', 'g')
                          from '^[0-9]*(?:\.[0-9]+)?'), '')::numeric
$$;

-- A submission's answers as {"<question label>": "<answer>"}: the shape
-- the planner reads, whether the answers are stored or still on screen.
create or replace function app.answers_of(p_submission uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(v.field_name, v.value), '{}'::jsonb)
    from (select distinct on (field_name) field_name, value
            from public.submission_values
           where submission_id = p_submission and field_name is not null
           order by field_name, id) v
$$;

-- ---------------------------------------------------------------------
-- How much is it for?
--
-- Read from the answers rather than taken from a caller. The amount
-- decides how far a claim climbs, and when it was a parameter a claim
-- could display 620,000 to everybody who opened it while being routed as
-- 50 — the CFO and the Head of Finance never asked. The first money
-- question on the form, by position, is the one that routes.
-- ---------------------------------------------------------------------
create or replace function app.amount_in(p_form_template_id uuid, p_answers jsonb)
returns numeric
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce((
    select app.leading_number(p_answers ->> f.field_name)
      from public.form_fields f
     where f.form_template_id = p_form_template_id and f.field_type = 'money'
     order by f.order_index nulls last, f.id
     limit 1), 0)
$$;

create or replace function app.submission_amount(p_submission uuid)
returns numeric
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select app.amount_in(s.form_template_id, app.answers_of(s.id))
    from public.form_submissions s where s.id = p_submission
$$;

-- ---------------------------------------------------------------------
-- Does a rule's condition hold for these answers?
--
-- {"field": "<question label>", "op": "<op>", "value": "<value>"}.
-- eq, neq and contains compare text, ignoring case and outer spaces;
-- gt, gte, lt and lte compare the leading numbers; empty and not_empty
-- ask whether it was answered at all. No condition always holds. A
-- condition on a subject with no answers — a notice, a maintenance
-- request — never does, because there is nothing for it to be about.
-- ---------------------------------------------------------------------
create or replace function app.condition_holds(p_answers jsonb, p_cond jsonb)
returns boolean
language plpgsql
stable
as $$
declare
  v_op   text;
  v_have text;
  v_want text;
  v_hn   numeric;
  v_wn   numeric;
begin
  if p_cond is null or jsonb_typeof(p_cond) = 'null' or p_cond = '{}'::jsonb then
    return true;
  end if;
  if p_answers is null then
    return false;
  end if;

  v_op   := coalesce(p_cond->>'op', 'eq');
  v_have := p_answers ->> (p_cond->>'field');
  v_want := p_cond->>'value';

  if v_op = 'empty'     then return coalesce(trim(v_have), '') = '';  end if;
  if v_op = 'not_empty' then return coalesce(trim(v_have), '') <> ''; end if;
  if v_have is null then
    return false;
  end if;

  if v_op in ('gt', 'gte', 'lt', 'lte') then
    v_hn := app.leading_number(v_have);
    v_wn := app.leading_number(v_want);
    if v_hn is null or v_wn is null then
      return false;
    end if;
    return case v_op when 'gt' then v_hn > v_wn  when 'gte' then v_hn >= v_wn
                     when 'lt' then v_hn < v_wn  else v_hn <= v_wn end;
  end if;

  if v_op = 'eq'       then return lower(trim(v_have)) =  lower(trim(coalesce(v_want, ''))); end if;
  if v_op = 'neq'      then return lower(trim(v_have)) <> lower(trim(coalesce(v_want, ''))); end if;
  if v_op = 'contains' then return position(lower(coalesce(v_want, '')) in lower(v_have)) > 0; end if;

  raise exception 'unknown condition operator: %', v_op;
end $$;

-- ---------------------------------------------------------------------
-- Who holds an organisational role for this requester?
--
-- line_manager    their own manager
-- skip_level      their manager's manager
-- department_head the head of their department
-- hrbp            their department's HR business partner
-- cxo             their department's CXO
--
-- Null when the org chart does not say; the rule's own approver is the
-- fallback then.
-- ---------------------------------------------------------------------
create or replace function app.resolve_role(p_role text, p_requester text)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select case p_role
    when 'line_manager' then app.line_manager_of(p_requester)
    when 'skip_level'   then app.line_manager_of(app.line_manager_of(p_requester))
    when 'department_head' then (
      select d.head_employee_id from public.departments d
        join public.employees e on e.department = d.name and e.tenant_id = d.tenant_id
       where e.employee_id = p_requester and e.tenant_id = app.current_tenant())
    when 'hrbp' then (
      select d.hrbp_employee_id from public.departments d
        join public.employees e on e.department = d.name and e.tenant_id = d.tenant_id
       where e.employee_id = p_requester and e.tenant_id = app.current_tenant())
    when 'cxo' then (
      select d.cxo_employee_id from public.departments d
        join public.employees e on e.department = d.name and e.tenant_id = d.tenant_id
       where e.employee_id = p_requester and e.tenant_id = app.current_tenant())
  end
$$;

create or replace function app.is_org_role(p_role text)
returns boolean
language sql
immutable
as $$
  select p_role in ('line_manager', 'skip_level', 'department_head', 'hrbp', 'cxo')
$$;

-- Record what happened. The engine's own trail; see approval_events.
create or replace function app.log_event(
  p_request uuid, p_type text, p_subject uuid, p_actor text,
  p_action text, p_comment text default null, p_target text default null
) returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  insert into public.approval_events
    (request_id, subject_type, subject_id, actor_id, action, comment, target_id)
  values (p_request, p_type, p_subject, p_actor, p_action, nullif(trim(p_comment), ''), p_target)
$$;

-- ---------------------------------------------------------------------
-- Plan the chain.
--
-- Who would be asked, and how: phases, lanes and steps, worked out from
-- the rules, the requester and a set of answers. Building a chain
-- inserts this plan; previewing one shows it, so the form's review step
-- and the chain that follows are the same thing by construction rather
-- than two pieces of code kept in step.
--
-- Rules are read in order. A rule labelled slab_finance expands into one
-- phase per threshold the amount has crossed, which is where escalation
-- happens. A rule naming an org role (line_manager, department_head, …)
-- means whoever holds it for this requester, with the person on the rule
-- as the fallback. A rule whose condition does not hold is left out.
--
-- Then three things shape it, two of them from the HR clearance flow
-- ("layers may be the same person"):
--   * nobody approves their own request;
--   * the same person twice in a row in a lane is one step — and across
--     two single-lane phases, which is how a sequence is laid out;
--   * a phase or lane left with nobody in it disappears.
-- ---------------------------------------------------------------------
create or replace function app.plan_chain(
  p_subject_type     text,
  p_form_template_id uuid,
  p_requester        text,
  p_answers          jsonb
) returns table (
  step_index  int,
  lane        int,
  lane_step   int,
  approver    text,
  days        int,
  quorum      int,
  stage_label text,
  lane_label  text,
  require_signature boolean,
  flag        text,
  remind_hours int,
  warn_hours  int,
  escalate_days int,
  escalate_levels int
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r           record;
  v_amount    numeric := 0;
  v_phase     int := 0;
  v_prev_idx  int;
  v_lanes     text[] := '{}';
  v_lane      int;
  v_approver  text;
  v_role      text;
  -- one entry per candidate step
  c_phase int[]  := '{}';
  c_lane  int[]  := '{}';
  c_appr  text[] := '{}';
  c_days  int[]  := '{}';
  c_quo   int[]  := '{}';
  c_slbl  text[] := '{}';
  c_llbl  text[] := '{}';
  c_sig   boolean[] := '{}';
  c_flag  text[] := '{}';
  c_rem   int[]  := '{}';
  c_warn  int[]  := '{}';
  c_escd  int[]  := '{}';
  c_escl  int[]  := '{}';
begin
  if p_subject_type = 'form_submission' then
    v_amount := app.amount_in(p_form_template_id, p_answers);
  end if;

  for r in
    select ar.approver_user_id, ar.deadline_days, ar.label, ar.step_index,
           ar.quorum, ar.condition, ar.stage_label, ar.lane, ar.require_signature, ar.flag,
           ar.remind_hours, ar.warn_hours, ar.escalate_days, ar.escalate_levels
      from public.approval_rules ar
     where ar.subject_type = p_subject_type
       -- This organisation's rules. Row-level security says so for the
       -- application, but the seed and the intake of tickets and mail run
       -- as the owner, which it does not bind: a notice's chain there was
       -- built from every organisation's notice rules at once.
       and ar.tenant_id = app.current_tenant()
       and (p_subject_type <> 'form_submission'
            or ar.form_template_id = p_form_template_id)
     -- position is the reading order across the whole phase; the lane
     -- name and then the id only break ties, so the layout never rests on
     -- random ids the way rule order once did.
     order by ar.step_index, ar.position, ar.lane nulls last, ar.id
  loop
    continue when not app.condition_holds(p_answers, r.condition);

    if r.label = 'slab_finance' and p_subject_type = 'form_submission' then
      -- Every threshold crossed, in order, each its own phase.
      for v_approver in
        select sa.approver_user_id from app.slab_approvers(p_form_template_id, v_amount) sa
      loop
        v_phase := v_phase + 1;
        c_phase := array_append(c_phase, v_phase);
        c_lane  := array_append(c_lane, 0);
        c_appr  := array_append(c_appr, v_approver);
        c_days  := array_append(c_days, coalesce(r.deadline_days, 7));
        c_quo   := array_append(c_quo, null::int);
        c_slbl  := array_append(c_slbl, coalesce(r.stage_label, 'Finance'));
        c_llbl  := array_append(c_llbl, null::text);
        c_sig   := array_append(c_sig, r.require_signature);
        c_flag  := array_append(c_flag, r.flag);
        c_rem   := array_append(c_rem, r.remind_hours);
        c_warn  := array_append(c_warn, r.warn_hours);
        c_escd  := array_append(c_escd, r.escalate_days);
        c_escl  := array_append(c_escl, r.escalate_levels);
      end loop;
      v_prev_idx := null;
      continue;
    end if;

    if v_prev_idx is distinct from r.step_index then
      v_phase    := v_phase + 1;
      v_prev_idx := r.step_index;
      v_lanes    := '{}';
    end if;

    -- Rules naming the same lane share it; a rule naming none has its
    -- own. Lanes are numbered in the order they first appear.
    if r.lane is not null and r.lane = any (v_lanes) then
      v_lane := array_position(v_lanes, r.lane) - 1;
    else
      v_lanes := array_append(v_lanes, coalesce(r.lane, '#' || (cardinality(v_lanes))::text || '#'));
      v_lane  := cardinality(v_lanes) - 1;
    end if;

    v_role := app.rule_role(r.label);
    -- "answer:<question>" is whoever the requester chose in that question
    -- (the Business Finance reviewer, picked from a list), if they are an
    -- active employee here; otherwise the rule's own person.
    v_approver := case when app.is_org_role(v_role)
                       then coalesce(app.resolve_role(v_role, p_requester), r.approver_user_id)
                       when v_role like 'answer:%'
                       then coalesce((select e.employee_id from public.employees e
                                       where e.tenant_id = app.current_tenant() and e.active
                                         and e.employee_id = nullif(trim(p_answers ->> substr(v_role, 8)), '')
                                         and e.employee_id <> coalesce(p_requester, '')),
                                     r.approver_user_id)
                       else r.approver_user_id end;

    c_phase := array_append(c_phase, v_phase);
    c_lane  := array_append(c_lane, v_lane);
    c_appr  := array_append(c_appr, v_approver);
    c_days  := array_append(c_days, coalesce(r.deadline_days, 7));
    c_quo   := array_append(c_quo, r.quorum);
    c_slbl  := array_append(c_slbl, r.stage_label);
    c_llbl  := array_append(c_llbl, r.lane);
    c_sig   := array_append(c_sig, r.require_signature);
    c_flag  := array_append(c_flag, r.flag);
    c_rem   := array_append(c_rem, r.remind_hours);
    c_warn  := array_append(c_warn, r.warn_hours);
    c_escd  := array_append(c_escd, r.escalate_days);
    c_escl  := array_append(c_escl, r.escalate_levels);
  end loop;

  return query
  with c as (
    select * from unnest(c_phase, c_lane, c_appr, c_days, c_quo, c_slbl, c_llbl, c_sig, c_flag, c_rem, c_warn, c_escd, c_escl)
             with ordinality as t(phase, ln, appr, dd, quo, slbl, llbl, sig, flg, rem, wrn, escd, escl, ord)
  ),
  -- A rule with no approver is configuration never finished; skipping it
  -- is better than a step nobody can act on. Nobody approves their own.
  f0 as (
    select * from c where appr is not null and appr is distinct from p_requester
  ),
  -- The same person twice in a row in a lane is one step.
  f1 as (
    select f0.*, lag(appr) over (partition by phase, ln order by ord) as prev from f0
  ),
  f as (
    select * from f1 where prev is distinct from appr
  ),
  lanes as (
    select phase, ln, min(ord) as first_ord,
           (array_agg(appr order by ord))[1]      as first_appr,
           (array_agg(appr order by ord desc))[1] as last_appr
      from f group by phase, ln
  ),
  ph as (
    select phase, count(*) as nlanes, min(first_ord) as first_ord,
           (array_agg(first_appr order by first_ord))[1] as first_appr,
           (array_agg(last_appr  order by first_ord))[1] as last_appr
      from lanes group by phase
  ),
  ph2 as (
    select ph.*, lag(nlanes)    over (order by first_ord) as prev_n,
                 lag(last_appr) over (order by first_ord) as prev_last
      from ph
  ),
  -- ...and across two single-lane phases, which is how a plain sequence
  -- is laid out: a line manager who is also the first finance level is
  -- asked once.
  dropped as (
    select ph2.first_ord as ord from ph2
     where ph2.nlanes = 1 and ph2.prev_n = 1 and ph2.prev_last = ph2.first_appr
  ),
  g as (
    select f.* from f where f.ord not in (select ord from dropped)
  ),
  num as (
    select phase, row_number() over (order by min(ord)) - 1 as idx
      from g group by phase
  ),
  lnum as (
    select phase, ln, row_number() over (partition by phase order by min(ord)) - 1 as lidx
      from g group by phase, ln
  ),
  pq as (
    select phase, min(quo) as quo, count(distinct ln) as nl,
           (array_agg(slbl order by ord) filter (where slbl is not null))[1] as slbl
      from g group by phase
  )
  select num.idx::int, lnum.lidx::int,
         (row_number() over (partition by g.phase, g.ln order by g.ord) - 1)::int,
         g.appr, g.dd,
         case when pq.quo is not null and pq.quo < pq.nl then pq.quo end,
         pq.slbl, g.llbl, coalesce(g.sig, false), g.flg, g.rem, g.wrn, g.escd, g.escl
    from g
    join num  on num.phase = g.phase
    join lnum on lnum.phase = g.phase and lnum.ln = g.ln
    join pq   on pq.phase = g.phase
   order by 1, 2, 3;
end $$;

-- ---------------------------------------------------------------------
-- What a form would ask, before it is submitted.
--
-- The review step shows the requester the ladder before they commit to
-- it. It is the planner itself, given the answers on screen — so what is
-- shown is what will happen: roles resolved for this requester, the
-- conditions their answers meet, the finance levels their amount
-- reaches, lanes at the same time. Read only; nothing is written.
-- ---------------------------------------------------------------------
create or replace function public.preview_approval_chain(
  p_form_template_id uuid,
  p_requester        text,
  p_answers          jsonb
) returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'step_index', p.step_index, 'lane', p.lane, 'lane_step', p.lane_step,
           'approver', p.approver, 'days', p.days, 'quorum', p.quorum,
           'stage_label', p.stage_label, 'lane_label', p.lane_label,
           'require_signature', p.require_signature, 'flag', p.flag, 'remind_hours', p.remind_hours)
           order by p.step_index, p.lane, p.lane_step), '[]'::jsonb)
    from app.plan_chain('form_submission', p_form_template_id, p_requester,
                        coalesce(p_answers, '{}'::jsonb)) p
$$;

-- ---------------------------------------------------------------------
-- Build the chain.
--
-- The plan, inserted. Every lane of the first phase is live at once; the
-- rest wait. The amount and the conditions come from the submission's
-- own stored answers — p_amount is accepted and ignored, so that an
-- older client still resolves the function.
-- ---------------------------------------------------------------------
create or replace function public.build_approval_chain(
  p_subject_type text,
  p_subject_id uuid,
  p_form_template_id uuid default null,
  p_amount numeric default null
) returns int
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r           record;
  v_requester text;
  v_answers   jsonb;
  v_approver  text;
  v_priority  text := 'normal';
  n           int;
  v_phases    int;
begin
  if p_subject_type not in ('form_submission', 'notice',
                            'stationery_request', 'maintenance_request') then
    raise exception 'unknown subject type: %', p_subject_type;
  end if;

  if exists (select 1 from public.approval_requests where subject_id = p_subject_id) then
    raise exception 'this already has an approval chain';
  end if;

  v_requester := app.subject_requester(p_subject_type, p_subject_id);
  if p_subject_type = 'form_submission' then
    v_answers := app.answers_of(p_subject_id);
    select coalesce(priority, 'normal') into v_priority
      from public.form_submissions where id = p_subject_id;
  end if;

  -- "The system can flag the items and fasten the high-priority request
  -- approval process": an urgent request gets half the time at each step,
  -- a high one a day less, never under one working day.
  insert into public.approval_requests
    (submission_id, notice_id, stationery_request_id, maintenance_request_id,
     approver_user_id, step_index, lane, lane_step, status, deadline_at, deadline_days,
     quorum, stage_label, lane_label, require_signature, remind_hours,
     warn_hours, escalate_days, escalate_levels)
  select
    case when p_subject_type = 'form_submission'     then p_subject_id end,
    case when p_subject_type = 'notice'              then p_subject_id end,
    case when p_subject_type = 'stationery_request'  then p_subject_id end,
    case when p_subject_type = 'maintenance_request' then p_subject_id end,
    p.approver, p.step_index, p.lane, p.lane_step,
    case when p.step_index = 0 and p.lane_step = 0 then 'pending' else 'waiting' end,
    app.add_working_days(now(), greatest(1, case v_priority
                                              when 'urgent' then ceil(p.days / 2.0)::int
                                              when 'high'   then p.days - 1
                                              else p.days end)),
    greatest(1, case v_priority when 'urgent' then ceil(p.days / 2.0)::int when 'high' then p.days - 1 else p.days end),
    p.quorum, p.stage_label, p.lane_label, p.require_signature, p.remind_hours,
    p.warn_hours, p.escalate_days, p.escalate_levels
  from app.plan_chain(p_subject_type, p_form_template_id, v_requester, v_answers) p;

  get diagnostics n = row_count;

  -- A rule that asks to be seen — the exceptional CXO approval — marks
  -- the request, so every notification and list can say so.
  if p_subject_type = 'form_submission' then
    update public.form_submissions
       set flag = (select p.flag from app.plan_chain(p_subject_type, p_form_template_id, v_requester, v_answers) p
                    where p.flag is not null order by p.step_index, p.lane, p.lane_step limit 1)
     where id = p_subject_id;
  end if;

  if n > 0 then
    select max(step_index) + 1 into v_phases
      from public.approval_requests where subject_id = p_subject_id;

    perform app.log_event(null, p_subject_type, p_subject_id, v_requester, 'submitted');

    -- The notification that actually matters: it is your turn. Every
    -- lane of the first phase is live at once, so each is told.
    for r in
      select approver_user_id from public.approval_requests
       where subject_id = p_subject_id and status = 'pending'
       order by lane
    loop
      perform app.notify(
        r.approver_user_id, 'approval.turn',
        'Your approval is needed',
        app.subject_label(p_subject_type, p_subject_id)
          || ' is waiting on you'
          || case when v_phases > 1 then ', stage 1 of ' || v_phases else '' end || '.',
        p_subject_type, p_subject_id);
    end loop;

    select approver_user_id into v_approver
      from public.approval_requests
     where subject_id = p_subject_id and status = 'pending'
     order by lane limit 1;
    perform app.set_subject_status(p_subject_type, p_subject_id, 'open', v_approver);

    -- Watchers configured against the form want to know it was raised.
    -- Like approvers, some are roles rather than people: the requester's
    -- line manager, the requester, the form's creator.
    if p_subject_type = 'form_submission' then
      -- Who they are, and whether they asked to hear of a request being
      -- raised and its answers meet their condition: app.watchers_for
      -- (db/009_sow_gaps.sql).
      for r in
        select w.who
          from app.watchers_for(p_subject_id, 'raised') w(who)
         where w.who is not null
           and not exists (select 1 from public.approval_requests ar
                            where ar.subject_id = p_subject_id
                              and ar.status = 'pending'
                              and ar.approver_user_id = w.who)
      loop
        perform app.notify(
          r.who, 'submission.raised',
          'New submission',
          app.subject_label(p_subject_type, p_subject_id) || ' was submitted.',
          p_subject_type, p_subject_id);
      end loop;

      -- A reviewer question can copy the reviewer's whole team: "Business
      -- Finance group to be CC'ed automatically."
      insert into public.submission_cc (tenant_id, submission_id, employee_id, added_by)
      select app.current_tenant(), p_subject_id, e.employee_id, v_requester
        from public.form_fields f
        join public.employees e
          on e.tenant_id = app.current_tenant() and e.active
         and e.department = f.field_config ->> 'team'
       where f.form_template_id = p_form_template_id
         and f.field_type = 'reviewer'
         and coalesce((f.field_config ->> 'ccTeam')::boolean, false)
         and e.employee_id <> coalesce(v_requester, '')
      on conflict do nothing;

      perform app.notify_cc(p_subject_id, 'cc.raised', 'You were copied on a request',
        app.subject_label(p_subject_type, p_subject_id) || ' was raised and you were copied on it.');
    end if;
  end if;

  return n;
end $$;

-- ---------------------------------------------------------------------
-- Is a phase done?
--
-- A lane is done when every step in it is approved. A phase is done when
-- its quorum of lanes is — all of them when it has no quorum.
-- ---------------------------------------------------------------------
create or replace function app.phase_done(p_subject uuid, p_phase int)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with l as (
    select lane, bool_and(status = 'approved') as done
      from public.approval_requests
     where subject_id = p_subject and step_index = p_phase
     group by lane
  )
  select count(*) filter (where done) >=
         coalesce((select min(quorum) from public.approval_requests
                    where subject_id = p_subject and step_index = p_phase),
                  count(*))
    from l
$$;

-- ---------------------------------------------------------------------
-- Open the next phase, or finish.
--
-- Called once a phase is done. The first waiting step of every lane in
-- the next phase goes live and its approver is told; if there is no next
-- phase the chain is complete, the requester is told, and a form whose
-- template names a follow-up starts one.
-- ---------------------------------------------------------------------
create or replace function app.advance(p_type text, p_subject uuid, p_after int)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_next  int;
  r       record;
  v_first text;
begin
  select min(step_index) into v_next
    from public.approval_requests
   where subject_id = p_subject and step_index > p_after and status = 'waiting';

  if v_next is null then
    perform app.notify(
      app.subject_requester(p_type, p_subject),
      'request.completed',
      'Fully approved',
      app.subject_label(p_type, p_subject) || ' has cleared every approver.',
      p_type, p_subject);
    perform app.log_event(null, p_type, p_subject, null, 'completed');
    if p_type = 'form_submission' then
      perform app.notify_cc(p_subject, 'cc.completed', 'Approved',
        app.subject_label(p_type, p_subject) || ', which you were copied on, has cleared every approver.');
      perform app.spawn_followup(p_subject);
    end if;
    return app.set_subject_status(p_type, p_subject, 'done', null);
  end if;

  for r in
    update public.approval_requests ar
       set status = 'pending'
     where ar.id in (
       select distinct on (lane) id
         from public.approval_requests
        where subject_id = p_subject and step_index = v_next and status = 'waiting'
        order by lane, lane_step)
    returning ar.approver_user_id, ar.lane
  loop
    perform app.notify(
      r.approver_user_id, 'approval.turn',
      'Your approval is needed',
      app.subject_label(p_type, p_subject)
        || ' has cleared the previous approver and is now with you.',
      p_type, p_subject);
    if v_first is null then
      v_first := r.approver_user_id;
    end if;
  end loop;

  return app.set_subject_status(p_type, p_subject, 'open', v_first);
end $$;

-- ---------------------------------------------------------------------
-- Act on a step.
--
-- The one rule that makes this a chain: only a `pending` step can be
-- acted on. Everything not yet live is `waiting`, so there is nothing for
-- a later approver to press — the order is enforced by the data, not by
-- hiding a button.
--
-- Approving moves the lane on, then the phase when its lanes are done.
-- Rejecting by anybody ends the whole chain: a clearance one department
-- refuses is refused. Clarification pauses this step only and goes back
-- to the requester; other lanes carry on.
-- ---------------------------------------------------------------------
create or replace function public.act_on_approval(
  p_request_id uuid,
  p_action     text,
  p_comment    text default null,
  p_actor      text default null,
  p_signature  text default null
) returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_req    record;
  v_next   record;
  v_open   text;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  select * into v_req from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'no such approval step';
  end if;

  perform app.assert_may_act(v_req.approver_user_id, v_req.subject_type,
                             v_req.subject_id, p_actor);

  if p_action = 'resume' then
    if v_req.status <> 'clarification' then
      raise exception 'only a step waiting on clarification can be resumed';
    end if;
    update public.approval_requests
       set status = 'pending', acted_at = null
     where id = p_request_id;
    perform app.log_event(p_request_id, v_req.subject_type, v_req.subject_id,
                          p_actor, 'resumed', p_comment);
    return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'open',
                                  v_req.approver_user_id);
  end if;

  if v_req.status <> 'pending' then
    raise exception 'this step is not open: it is %', v_req.status;
  end if;

  if p_action = 'approve' then
    -- "When user applies, it will be asked to attach a signature if
    -- 'Signature Required' is checked for that task."
    if v_req.require_signature then
      if p_signature is null or p_signature !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' then
        raise exception 'this step needs your signature to approve';
      end if;
      if length(p_signature) > 300000 then
        raise exception 'that signature is too large';
      end if;
    end if;
    -- A track with a checklist clears only once every item is ticked
    -- (db/009_sow_gaps.sql).
    perform app.assert_checklist_done(p_request_id);

    update public.approval_requests
       set status = 'approved', acted_at = now(), comment = coalesce(p_comment, comment),
           signature = case when v_req.require_signature then p_signature end,
           signed_at = case when v_req.require_signature then now() end
     where id = p_request_id;
    perform app.log_event(p_request_id, v_req.subject_type, v_req.subject_id,
                          p_actor, 'approved', p_comment);

    -- The next step in this lane, if there is one.
    select * into v_next
      from public.approval_requests
     where subject_id = v_req.subject_id
       and step_index = v_req.step_index
       and lane = v_req.lane
       and lane_step > v_req.lane_step
       and status = 'waiting'
     order by lane_step
     limit 1;

    if found then
      update public.approval_requests set status = 'pending' where id = v_next.id;
      perform app.notify(
        v_next.approver_user_id, 'approval.turn',
        'Your approval is needed',
        app.subject_label(v_req.subject_type, v_req.subject_id)
          || ' has cleared the previous approver and is now with you.',
        v_req.subject_type, v_req.subject_id);
      return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'open',
                                    v_next.approver_user_id);
    end if;

    -- The lane is finished. "Once one division approves a ticket, the
    -- other divisions must be notified of that approval": everybody in
    -- the phase's other lanes hears that this one has cleared.
    if exists (select 1 from public.approval_requests
                where subject_id = v_req.subject_id and step_index = v_req.step_index
                  and lane <> v_req.lane) then
      for v_next in
        select distinct approver_user_id from public.approval_requests
         where subject_id = v_req.subject_id and step_index = v_req.step_index
           and lane <> v_req.lane and approver_user_id is not null
           and approver_user_id is distinct from p_actor
      loop
        perform app.notify(
          v_next.approver_user_id, 'phase.lane_cleared',
          coalesce(v_req.lane_label, 'Another department') || ' has cleared it',
          app.subject_label(v_req.subject_type, v_req.subject_id) || ' was cleared by '
            || coalesce(v_req.lane_label, 'another lane') || '.',
          v_req.subject_type, v_req.subject_id);
      end loop;
    end if;

    -- If the phase is not done, the request waits on the lanes still
    -- running.
    if not app.phase_done(v_req.subject_id, v_req.step_index) then
      select approver_user_id into v_open
        from public.approval_requests
       where subject_id = v_req.subject_id and step_index = v_req.step_index
         and status in ('pending', 'clarification')
       order by (status = 'clarification'), lane
       limit 1;
      return app.set_subject_status(
        v_req.subject_type, v_req.subject_id,
        case when exists (select 1 from public.approval_requests
                           where subject_id = v_req.subject_id
                             and status = 'clarification') then 'held' else 'open' end,
        v_open);
    end if;

    -- The phase is done. Anybody in it still asked — lanes a quorum made
    -- unnecessary — is no longer needed.
    update public.approval_requests
       set status = 'skipped'
     where subject_id = v_req.subject_id
       and step_index = v_req.step_index
       and status in ('pending', 'waiting', 'clarification');

    return app.advance(v_req.subject_type, v_req.subject_id, v_req.step_index);

  elsif p_action = 'reject' then
    update public.approval_requests
       set status = 'rejected', acted_at = now(), comment = p_comment
     where id = p_request_id;
    perform app.log_event(p_request_id, v_req.subject_type, v_req.subject_id,
                          p_actor, 'rejected', p_comment);

    -- A rejection ends the chain. Everything else still open or waiting
    -- is marked skipped rather than deleted, so the trail still shows who
    -- would have been asked.
    update public.approval_requests
       set status = 'skipped'
     where subject_id = v_req.subject_id
       and id <> p_request_id
       and status in ('waiting', 'pending', 'clarification');

    perform app.notify(
      app.subject_requester(v_req.subject_type, v_req.subject_id),
      'request.rejected',
      'Rejected',
      app.subject_label(v_req.subject_type, v_req.subject_id)
        || ' was rejected' || coalesce(': ' || p_comment, '.'),
      v_req.subject_type, v_req.subject_id);
    if v_req.subject_type = 'form_submission' then
      perform app.notify_cc(v_req.subject_id, 'cc.rejected', 'Rejected',
        app.subject_label(v_req.subject_type, v_req.subject_id)
          || ', which you were copied on, was rejected' || coalesce(': ' || p_comment, '.'));
    end if;

    return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'rejected', null);

  elsif p_action = 'clarification' then
    -- Paused, not ended. The step stays with the same approver and the
    -- chain resumes where it stopped.
    update public.approval_requests
       set status = 'clarification', acted_at = now(), comment = p_comment
     where id = p_request_id;
    perform app.log_event(p_request_id, v_req.subject_type, v_req.subject_id,
                          p_actor, 'clarification', p_comment);

    perform app.notify(
      app.subject_requester(v_req.subject_type, v_req.subject_id),
      'request.clarification',
      'Clarification needed',
      app.subject_label(v_req.subject_type, v_req.subject_id)
        || ' is on hold' || coalesce(': ' || p_comment, '.'),
      v_req.subject_type, v_req.subject_id);

    return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'held',
                                  v_req.approver_user_id);
  end if;

  raise exception 'unknown action: %', p_action;
end $$;

-- ---------------------------------------------------------------------
-- Return a request to somebody who already approved it.
--
-- "Return to a specific approver" — the Finance pain point. The step it
-- goes back to is live again; everything between it and the step doing
-- the returning goes back to waiting, so it is approved again in order.
-- Other lanes of the phase it returns to keep what they had: if Admin
-- cleared and IT is asked to look again, Admin is not asked twice.
-- The history of the first round stays in approval_events.
-- ---------------------------------------------------------------------
create or replace function public.return_to_approver(
  p_request_id uuid,
  p_target_id  uuid,
  p_comment    text default null,
  p_actor      text default null
) returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_req record;
  v_tgt record;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  select * into v_req from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'no such approval step';
  end if;
  perform app.assert_may_act(v_req.approver_user_id, v_req.subject_type,
                             v_req.subject_id, p_actor);
  if v_req.status not in ('pending', 'clarification') then
    raise exception 'only an open step can return a request: this one is %', v_req.status;
  end if;

  select * into v_tgt from public.approval_requests
   where id = p_target_id and subject_id = v_req.subject_id
     for update;
  if not found then
    raise exception 'that step is not part of this request';
  end if;
  if v_tgt.status <> 'approved' then
    raise exception 'a request can only be returned to somebody who has approved it';
  end if;
  if not (v_tgt.step_index < v_req.step_index
          or (v_tgt.step_index = v_req.step_index and v_tgt.lane = v_req.lane
              and v_tgt.lane_step < v_req.lane_step)) then
    raise exception 'a request can only be returned to an earlier approver';
  end if;

  set constraints all deferred;

  if v_tgt.step_index < v_req.step_index then
    -- Every phase after the target's, up to and including this one, is
    -- asked again from the start.
    update public.approval_requests
       set status = 'waiting', acted_at = null
     where subject_id = v_req.subject_id
       and step_index > v_tgt.step_index
       and step_index <= v_req.step_index;
    -- In the target's own phase, only its lane after it.
    update public.approval_requests
       set status = 'waiting', acted_at = null
     where subject_id = v_req.subject_id
       and step_index = v_tgt.step_index
       and lane = v_tgt.lane
       and lane_step > v_tgt.lane_step;
  else
    update public.approval_requests
       set status = 'waiting', acted_at = null
     where subject_id = v_req.subject_id
       and step_index = v_req.step_index
       and lane = v_req.lane
       and lane_step > v_tgt.lane_step
       and lane_step <= v_req.lane_step;
  end if;

  update public.approval_requests
     set status = 'pending', acted_at = null
   where id = v_tgt.id;

  perform app.log_event(p_request_id, v_req.subject_type, v_req.subject_id,
                        p_actor, 'returned', p_comment, v_tgt.approver_user_id);

  perform app.notify(
    v_tgt.approver_user_id, 'approval.returned',
    'Returned to you',
    app.subject_label(v_req.subject_type, v_req.subject_id)
      || ' was returned to you by ' || coalesce(p_actor, 'a later approver')
      || coalesce(': ' || nullif(trim(p_comment), ''), '.'),
    v_req.subject_type, v_req.subject_id);

  return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'open',
                                v_tgt.approver_user_id);
end $$;

-- ---------------------------------------------------------------------
-- Forward a step to somebody else.
--
-- The step keeps its place in the chain; only who owns it changes.
-- reassigned_from records who it was originally asked of, and holds the
-- first answer if it is forwarded more than once.
-- ---------------------------------------------------------------------
create or replace function public.reassign_approval(
  p_request_id  uuid,
  p_to          text,
  p_comment     text default null,
  p_actor       text default null
) returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_req record;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  select * into v_req from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'no such approval step';
  end if;
  perform app.assert_may_act(v_req.approver_user_id, v_req.subject_type,
                             v_req.subject_id, p_actor);
  if v_req.status not in ('pending', 'clarification') then
    raise exception 'only an open step can be forwarded: it is %', v_req.status;
  end if;
  if p_to is null or p_to = '' then
    raise exception 'forwarding needs somebody to forward to';
  end if;
  if p_to = v_req.approver_user_id then
    raise exception 'that step is already theirs';
  end if;
  if not exists (select 1 from public.employees where employee_id = p_to) then
    raise exception 'no employee with id %', p_to;
  end if;
  -- Some forms forward only within the approver's reporting line
  -- (db/009_sow_gaps.sql).
  perform app.assert_forward_allowed(p_request_id, p_to);

  update public.approval_requests
     set approver_user_id = p_to,
         reassigned_from  = coalesce(v_req.reassigned_from, v_req.approver_user_id),
         comment          = coalesce(p_comment, comment)
   where id = p_request_id;

  perform app.log_event(p_request_id, v_req.subject_type, v_req.subject_id,
                        p_actor, 'forwarded', p_comment, p_to);

  perform app.notify(
    p_to, 'approval.turn',
    'An approval was forwarded to you',
    app.subject_label(v_req.subject_type, v_req.subject_id)
      || ' was forwarded by ' || coalesce(v_req.approver_user_id, 'another approver') || '.',
    v_req.subject_type, v_req.subject_id);

  perform app.set_subject_status(v_req.subject_type, v_req.subject_id,
                                 case when v_req.status = 'pending' then 'open' else 'held' end,
                                 p_to);
  return p_to;
end $$;

-- ---------------------------------------------------------------------
-- Ask a reviewer before approving.
--
-- "An approver should be able to add reviewer to review the ticket
-- before s/he gives approval." The reviewer's step goes in ahead of the
-- approver's, in the same lane, and is live at once; the approver's own
-- step waits behind it and comes back when the reviewer has passed it
-- on, with the reviewer's remarks on the trail. It used to go in after
-- the approver, which asked for a review of a decision already made.
-- ---------------------------------------------------------------------
create or replace function public.add_reviewer(
  p_request_id    uuid,
  p_employee      text,
  p_deadline_days int default 7,
  p_actor         text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_req record;
  v_new uuid;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  select * into v_req from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'no such approval step';
  end if;
  perform app.assert_may_act(v_req.approver_user_id, v_req.subject_type,
                             v_req.subject_id, p_actor);
  if v_req.status <> 'pending' then
    raise exception 'a reviewer can only be added to a step that is waiting on you';
  end if;
  if not exists (select 1 from public.employees where employee_id = p_employee) then
    raise exception 'no employee with id %', p_employee;
  end if;
  if p_employee = v_req.approver_user_id then
    raise exception 'you cannot add yourself as your own reviewer';
  end if;

  set constraints all deferred;

  -- Make room: this step and everything after it in the lane move down.
  update public.approval_requests
     set lane_step = lane_step + 1
   where subject_id = v_req.subject_id
     and step_index = v_req.step_index
     and lane = v_req.lane
     and lane_step >= v_req.lane_step;

  update public.approval_requests set status = 'waiting' where id = p_request_id;

  insert into public.approval_requests
    (submission_id, notice_id, stationery_request_id, maintenance_request_id,
     approver_user_id, step_index, lane, lane_step, status, deadline_at,
     quorum, stage_label, lane_label)
  values (v_req.submission_id, v_req.notice_id, v_req.stationery_request_id,
          v_req.maintenance_request_id,
          p_employee, v_req.step_index, v_req.lane, v_req.lane_step, 'pending',
          app.add_working_days(now(), coalesce(p_deadline_days, 7)),
          v_req.quorum, v_req.stage_label, v_req.lane_label)
  returning id into v_new;

  perform app.log_event(p_request_id, v_req.subject_type, v_req.subject_id,
                        p_actor, 'reviewer_added', null, p_employee);

  perform app.notify(
    p_employee, 'approval.review',
    'Your review is requested',
    coalesce(p_actor, 'An approver') || ' asked you to review '
      || app.subject_label(v_req.subject_type, v_req.subject_id)
      || ' before they decide on it.',
    v_req.subject_type, v_req.subject_id);

  perform app.set_subject_status(v_req.subject_type, v_req.subject_id, 'open', p_employee);
  return v_new;
end $$;

-- ---------------------------------------------------------------------
-- The requester takes it back.
--
-- "The initiator can edit or cancel the request ... prior to acceptance
-- by line manager ... once the ticket is approved, the initiator can't
-- edit/reject it." So both are open to whoever raised the request, and
-- only until anybody has approved any part of it.
--
-- Recalling returns it to a draft: the chain is removed (its history
-- stays in approval_events) and the requester can edit and submit it
-- again, which builds a fresh chain. Cancelling ends it where it stands.
-- Form submissions only; notices and service requests have their own
-- screens for that.
-- ---------------------------------------------------------------------
create or replace function app.assert_requester_may_withdraw(p_submission uuid, p_actor text)
returns record
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_sub record;
begin
  select id, submitted_by, status into v_sub
    from public.form_submissions where id = p_submission for update;
  if not found then
    raise exception 'no such submission';
  end if;
  if p_actor is null or v_sub.submitted_by is distinct from p_actor then
    raise exception 'only the person who raised a request can take it back';
  end if;
  if v_sub.status not in ('submitted', 'in_progress', 'on_hold') then
    raise exception 'a request that is % cannot be taken back', v_sub.status;
  end if;
  if exists (select 1 from public.approval_requests
              where submission_id = p_submission and status = 'approved') then
    raise exception 'somebody has already approved part of this request, so it can no longer be taken back';
  end if;
  return v_sub;
end $$;

create or replace function public.recall_submission(
  p_submission_id uuid,
  p_actor         text default null
) returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  perform app.assert_requester_may_withdraw(p_submission_id, p_actor);

  for r in
    select approver_user_id from public.approval_requests
     where submission_id = p_submission_id and status in ('pending', 'clarification')
  loop
    perform app.notify(
      r.approver_user_id, 'request.recalled',
      'Taken back by the requester',
      app.subject_label('form_submission', p_submission_id)
        || ' was taken back to be edited. There is nothing for you to do.',
      'form_submission', p_submission_id);
  end loop;

  perform app.log_event(null, 'form_submission', p_submission_id, p_actor, 'recalled');
  delete from public.approval_queries where subject_id = p_submission_id;
  delete from public.approval_requests where submission_id = p_submission_id;
  update public.form_submissions set status = 'draft' where id = p_submission_id;
  return 'draft';
end $$;

create or replace function public.cancel_submission(
  p_submission_id uuid,
  p_comment       text default null,
  p_actor         text default null
) returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  perform app.assert_requester_may_withdraw(p_submission_id, p_actor);

  for r in
    select approver_user_id from public.approval_requests
     where submission_id = p_submission_id and status in ('pending', 'clarification')
  loop
    perform app.notify(
      r.approver_user_id, 'request.cancelled',
      'Cancelled by the requester',
      app.subject_label('form_submission', p_submission_id)
        || ' was cancelled' || coalesce(': ' || nullif(trim(p_comment), ''), '.')
        || ' There is nothing for you to do.',
      'form_submission', p_submission_id);
  end loop;

  update public.approval_requests
     set status = 'skipped'
   where submission_id = p_submission_id
     and status in ('waiting', 'pending', 'clarification');
  perform app.log_event(null, 'form_submission', p_submission_id, p_actor, 'cancelled', p_comment);
  update public.form_submissions set status = 'cancelled' where id = p_submission_id;
  return 'cancelled';
end $$;

-- ---------------------------------------------------------------------
-- One approver asks another.
--
-- "Approver will be able to ask specific questions or raise query at any
-- level in the approval hierarchy. (An approver can ask question only to
-- approvers in the NFA.)" Both people must be approvers on this request
-- — the asker directly or by delegation. The chain does not pause: this
-- is a conversation beside it. Asking the requester is clarification.
-- ---------------------------------------------------------------------
create or replace function public.ask_question(
  p_subject_id uuid,
  p_to         text,
  p_question   text,
  p_actor      text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_type text;
  v_id   uuid;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  select subject_type into v_type
    from public.approval_requests where subject_id = p_subject_id limit 1;
  if v_type is null then
    raise exception 'that request has no approvers to ask';
  end if;
  if p_question is null or trim(p_question) = '' then
    raise exception 'a question needs asking';
  end if;
  if p_to is null or p_to = p_actor then
    raise exception 'ask somebody other than yourself';
  end if;
  if not exists (select 1 from public.approval_requests
                  where subject_id = p_subject_id
                    and app.may_act(approver_user_id, subject_type, subject_id, p_actor)) then
    raise exception 'only an approver on this request can ask its approvers a question';
  end if;
  if not exists (select 1 from public.approval_requests
                  where subject_id = p_subject_id and approver_user_id = p_to) then
    raise exception 'questions go to approvers on this request; ask the requester for clarification instead';
  end if;

  insert into public.approval_queries (subject_type, subject_id, asked_by, asked_to, question)
  values (v_type, p_subject_id, p_actor, p_to, trim(p_question))
  returning id into v_id;

  perform app.log_event(null, v_type, p_subject_id, p_actor, 'question', p_question, p_to);
  perform app.notify(
    p_to, 'question.asked',
    'A question for you',
    p_actor || ' asked about ' || app.subject_label(v_type, p_subject_id) || ': ' || trim(p_question),
    v_type, p_subject_id);
  return v_id;
end $$;

create or replace function public.answer_question(
  p_query_id uuid,
  p_answer   text,
  p_actor    text default null
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_q record;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  select * into v_q from public.approval_queries where id = p_query_id for update;
  if not found then
    raise exception 'no such question';
  end if;
  if v_q.answer is not null then
    raise exception 'that question has already been answered';
  end if;
  if p_answer is null or trim(p_answer) = '' then
    raise exception 'an answer needs saying';
  end if;
  if not app.may_act(v_q.asked_to, v_q.subject_type, v_q.subject_id, p_actor) then
    raise exception 'the question was asked of %, not of %', v_q.asked_to, coalesce(p_actor, 'nobody');
  end if;

  update public.approval_queries
     set answer = trim(p_answer), answered_at = now()
   where id = p_query_id;

  perform app.log_event(null, v_q.subject_type, v_q.subject_id, p_actor, 'answer', p_answer, v_q.asked_by);
  perform app.notify(
    v_q.asked_by, 'question.answered',
    'Your question was answered',
    p_actor || ' answered about ' || app.subject_label(v_q.subject_type, v_q.subject_id)
      || ': ' || trim(p_answer),
    v_q.subject_type, v_q.subject_id);
end $$;

-- ---------------------------------------------------------------------
-- The ticket that follows.
--
-- "A secondary NFA ticket is automatically created upon approval of
-- previous ticket ... preloaded in the ticket." When a submission
-- finishes and its template names a follow-up, a draft of the follow-up
-- is started for the same requester, linked back to it, with every
-- answer whose question the follow-up asks too already filled in. It is
-- a draft, not a submission: somebody still has to read it and send it.
-- ---------------------------------------------------------------------
create or replace function app.spawn_followup(p_submission uuid)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_parent record;
  v_new    uuid;
begin
  select s.submitted_by, ft.followup_template_id,
         (select f2.name from public.form_templates f2 where f2.id = ft.followup_template_id) as next_name
    into v_parent
    from public.form_submissions s
    join public.form_templates ft on ft.id = s.form_template_id
   where s.id = p_submission;

  if v_parent.followup_template_id is null then
    return null;
  end if;

  -- In the requester's name, whoever approved: see app.stamp_actor().
  perform set_config('app.on_behalf', 'true', true);
  insert into public.form_submissions
    (form_template_id, submitted_by, status, parent_submission_id)
  values (v_parent.followup_template_id, v_parent.submitted_by, 'draft', p_submission)
  returning id into v_new;
  perform set_config('app.on_behalf', 'false', true);

  insert into public.submission_values (submission_id, field_name, value)
  select distinct on (f.field_name) v_new, f.field_name, pv.value
    from public.form_fields f
    join public.submission_values pv
      on pv.submission_id = p_submission and pv.field_name = f.field_name
   where f.form_template_id = v_parent.followup_template_id
     and coalesce(pv.value, '') <> ''
   order by f.field_name, pv.id;

  perform app.log_event(null, 'form_submission', p_submission, null, 'followup_created', null, v_new::text);
  perform app.notify(
    v_parent.submitted_by, 'request.followup',
    'A follow-up is ready for you',
    app.subject_label('form_submission', p_submission) || ' was approved, so '
      || coalesce(v_parent.next_name, 'its follow-up')
      || ' has been started with its details filled in. Check it and submit it.',
    'form_submission', v_new);
  return v_new;
end $$;

-- ---------------------------------------------------------------------
-- Stage 2: the ticket.
-- ---------------------------------------------------------------------

-- Tell everybody copied on a request.
create or replace function app.notify_cc(p_submission uuid, p_kind text, p_title text, p_body text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare r record;
begin
  for r in select employee_id from public.submission_cc where submission_id = p_submission loop
    perform app.notify(r.employee_id, p_kind, p_title, p_body, 'form_submission', p_submission);
  end loop;
end $$;

-- Is this person part of the request: its requester, an approver on it
-- (or a current delegate of one), or somebody copied on it?
create or replace function app.involved_in(p_submission uuid, p_actor text)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select p_actor is not null and (
    exists (select 1 from public.form_submissions where id = p_submission and submitted_by = p_actor)
    or exists (select 1 from public.approval_requests ar
                where ar.submission_id = p_submission
                  and app.may_act(ar.approver_user_id, ar.subject_type, ar.subject_id, p_actor))
    or exists (select 1 from public.submission_cc where submission_id = p_submission and employee_id = p_actor))
$$;

-- ---------------------------------------------------------------------
-- A note on a request.
--
-- "A user can add notes to a ticket after it has been approved."
-- "Notification needs to be sent to all approvers if any notes are added
-- in a ticket." Anybody involved may add one, at any stage; everybody
-- else involved — the requester, every approver on it, everyone copied —
-- hears about it.
-- ---------------------------------------------------------------------
create or replace function public.add_note(
  p_submission_id uuid,
  p_body          text,
  p_actor         text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  r    record;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  if p_body is null or trim(p_body) = '' then
    raise exception 'a note needs something in it';
  end if;
  if not app.involved_in(p_submission_id, p_actor) then
    raise exception 'only somebody on this request can add a note to it';
  end if;

  insert into public.ticket_notes (submission_id, author_id, body)
  values (p_submission_id, p_actor, trim(p_body))
  returning id into v_id;

  perform app.log_event(null, 'form_submission', p_submission_id, p_actor, 'note', p_body);

  for r in
    select distinct who from (
      select submitted_by as who from public.form_submissions where id = p_submission_id
      union select approver_user_id from public.approval_requests where submission_id = p_submission_id
      union select employee_id from public.submission_cc where submission_id = p_submission_id
    ) x
     where who is not null and who <> p_actor
  loop
    perform app.notify(r.who, 'note.added', 'A note was added',
      p_actor || ' added a note to ' || app.subject_label('form_submission', p_submission_id)
        || ': ' || left(trim(p_body), 200),
      'form_submission', p_submission_id);
  end loop;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Who is copied on a request. The requester sets it; whoever is newly
-- added is told.
-- ---------------------------------------------------------------------
create or replace function public.set_cc(
  p_submission_id uuid,
  p_people        text[],
  p_actor         text default null
) returns int
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_sub    record;
  v_who    text;
  v_status text;
  n        int := 0;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  select submitted_by, status into v_sub from public.form_submissions where id = p_submission_id;
  if not found then
    raise exception 'no such submission';
  end if;
  if v_sub.submitted_by is distinct from p_actor then
    raise exception 'only the person who raised a request decides who is copied on it';
  end if;

  delete from public.submission_cc
   where submission_id = p_submission_id
     and employee_id <> all (coalesce(p_people, '{}'));

  foreach v_who in array coalesce(p_people, '{}') loop
    continue when v_who is null or v_who = '' or v_who = p_actor;
    if not exists (select 1 from public.employees where employee_id = v_who) then
      raise exception 'no employee with id %', v_who;
    end if;
    insert into public.submission_cc (submission_id, employee_id, added_by)
    values (p_submission_id, v_who, p_actor)
    on conflict (tenant_id, submission_id, employee_id) do nothing;
    if found then
      n := n + 1;
      -- Nobody else's business until it is routed; then they hear it was
      -- raised, from the chain itself. Only somebody added afterwards is
      -- told here.
      if exists (select 1 from public.approval_requests where submission_id = p_submission_id) then
        perform app.notify(v_who, 'cc.added', 'You were copied on a request',
          p_actor || ' copied you on ' || app.subject_label('form_submission', p_submission_id) || '.',
          'form_submission', p_submission_id);
      end if;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Link two requests. The other one may be named by its reference.
-- ---------------------------------------------------------------------
create or replace function public.link_submissions(
  p_submission_id uuid,
  p_other         text,
  p_note          text default null,
  p_actor         text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_other uuid;
  v_id    uuid;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  if not app.involved_in(p_submission_id, p_actor) then
    raise exception 'only somebody on this request can link it to another';
  end if;

  -- In this tenant. Policies would say so under the application, but the
  -- seed runs as the owner, and every evaluation is a clone carrying the
  -- same references — so a reference alone names one request in every
  -- tenant at once.
  select id into v_other from public.form_submissions
   where tenant_id = app.current_tenant()
     and (ref_number = upper(trim(p_other)) or id::text = lower(trim(p_other)))
   limit 1;
  if v_other is null then
    raise exception 'there is no request %', trim(p_other);
  end if;
  if v_other = p_submission_id then
    raise exception 'a request cannot be linked to itself';
  end if;
  if exists (select 1 from public.submission_links
              where (from_id = p_submission_id and to_id = v_other)
                 or (from_id = v_other and to_id = p_submission_id)) then
    raise exception 'those two are already linked';
  end if;

  insert into public.submission_links (from_id, to_id, note, created_by)
  values (p_submission_id, v_other, nullif(trim(p_note), ''), p_actor)
  returning id into v_id;

  perform app.log_event(null, 'form_submission', p_submission_id, p_actor, 'linked', p_note,
                        (select ref_number from public.form_submissions where id = v_other));
  return v_id;
end $$;

create or replace function public.unlink_submissions(
  p_submission_id uuid,
  p_other_id      uuid,
  p_actor         text default null
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  if not app.involved_in(p_submission_id, p_actor) then
    raise exception 'only somebody on this request can unlink it';
  end if;
  delete from public.submission_links
   where (from_id = p_submission_id and to_id = p_other_id)
      or (from_id = p_other_id and to_id = p_submission_id);
  perform app.log_event(null, 'form_submission', p_submission_id, p_actor, 'unlinked', null,
                        (select ref_number from public.form_submissions where id = p_other_id));
end $$;

-- ---------------------------------------------------------------------
-- Copy a request.
--
-- "A ticket can be copied from any of the previous ticket and later it
-- can be edited according to requirement." The copy is a draft of the
-- same form for whoever is copying it, with the same answers and the
-- current version of each document, linked back to the original.
-- ---------------------------------------------------------------------
create or replace function public.copy_submission(
  p_submission_id uuid,
  p_actor         text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_src record;
  v_new uuid;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  if p_actor is null or not exists (select 1 from public.employees where employee_id = p_actor) then
    raise exception 'say who is copying it';
  end if;
  select form_template_id, priority into v_src from public.form_submissions where id = p_submission_id;
  if not found then
    raise exception 'no such submission';
  end if;

  insert into public.form_submissions (form_template_id, submitted_by, status, priority)
  values (v_src.form_template_id, p_actor, 'draft', v_src.priority)
  returning id into v_new;

  insert into public.submission_values (submission_id, field_name, value)
  select v_new, field_name, value from public.submission_values where submission_id = p_submission_id;

  insert into public.attachments
    (submission_id, field_name, file_name, content_type, size_bytes, data, uploaded_by, description, tags)
  select v_new, field_name, file_name, content_type, size_bytes, data, p_actor, description, tags
    from public.attachments
   where submission_id = p_submission_id and superseded_at is null;

  insert into public.submission_links (from_id, to_id, note, created_by)
  values (v_new, p_submission_id, 'Copied from', p_actor);

  return v_new;
end $$;

-- ---------------------------------------------------------------------
-- Throw a draft away.
--
-- "There should be provision to save any request and work later the same
-- document and submit it for approval" (SOW 2.1, Save draft). A draft
-- nobody means to finish would otherwise sit in My Submissions for
-- ever. Only its requester may delete it, and only while it is a draft:
-- nobody has seen it, so nothing of it is a record. Its answers and
-- attachments go with it; the deletion itself is in the audit trail.
-- ---------------------------------------------------------------------
create or replace function public.delete_draft(p_submission_id uuid, p_actor text default null)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  p_actor := app.acting(p_actor);
  select s.id, s.submitted_by, s.status, s.ref_number, f.name as form
    into v
    from public.form_submissions s
    left join public.form_templates f on f.id = s.form_template_id
   where s.id = p_submission_id and s.tenant_id = app.current_tenant()
   for update of s;
  if not found then raise exception 'no such draft'; end if;
  if p_actor is null or v.submitted_by is distinct from p_actor then
    raise exception 'only whoever started a draft can delete it';
  end if;
  if v.status <> 'draft' then
    raise exception 'only a draft can be deleted; this request is %', v.status;
  end if;
  delete from public.form_submissions where id = p_submission_id;
  perform app.audit('draft_deleted', 'form_submission', p_submission_id,
                    coalesce(v.form, 'Draft') || coalesce(' ' || v.ref_number, ''));
end $$;

-- ---------------------------------------------------------------------
-- Somebody is leaving: hand everything of theirs to a successor.
--
-- "Leavers' delegation." A date-ranged delegation covers a holiday; a
-- leaver needs every step waiting on them, every rule and slab that
-- names them, every department role they hold and every report who
-- reports to them handed over for good — and their own row kept, marked
-- as left, because the trail still names them.
-- ---------------------------------------------------------------------
create or replace function public.hand_over(
  p_leaver    text,
  p_successor text,
  p_actor     text default null
) returns int
language plpgsql
-- Definer: it rewrites workflow configuration and the org chart, which
-- members cannot write directly. It checks org.manage itself, and every
-- statement in it names the tenant.
security definer
set search_path = public, pg_temp
as $$
declare
  n   int := 0;
  k   int;
  r   record;
begin
  -- Who is acting is the session's to say, when there is a session.
  p_actor := app.acting(p_actor);
  perform app.require_permission('org.manage');
  if p_leaver is null or p_successor is null or p_leaver = p_successor then
    raise exception 'name somebody leaving and somebody else to take over';
  end if;
  if not exists (select 1 from public.employees where employee_id = p_leaver and tenant_id = app.current_tenant()) then
    raise exception 'no employee with id %', p_leaver;
  end if;
  if not exists (select 1 from public.employees
                  where employee_id = p_successor and active and tenant_id = app.current_tenant()) then
    raise exception '% is not an active employee', p_successor;
  end if;

  -- Steps waiting on them now or later.
  for r in
    update public.approval_requests
       set approver_user_id = p_successor,
           reassigned_from  = coalesce(reassigned_from, p_leaver)
     where approver_user_id = p_leaver
       and tenant_id = app.current_tenant()
       and status in ('pending', 'waiting', 'clarification')
    returning id, subject_type, subject_id, status
  loop
    n := n + 1;
    perform app.log_event(r.id, r.subject_type, r.subject_id, p_actor, 'handed_over', null, p_successor);
    if r.status in ('pending', 'clarification') then
      perform app.notify(p_successor, 'approval.turn', 'Handed over to you',
        app.subject_label(r.subject_type, r.subject_id) || ' was handed over to you from somebody who has left.',
        r.subject_type, r.subject_id);
    end if;
  end loop;

  -- Everywhere the configuration names them.
  -- Everything below names the tenant as well as the person: employee
  -- ids repeat in every evaluation, and run as the owner a bare id would
  -- reach into all of them.
  update public.approval_rules     set approver_user_id = p_successor where approver_user_id = p_leaver and tenant_id = app.current_tenant();
  update public.approval_slabs     set approver_user_id = p_successor where approver_user_id = p_leaver and tenant_id = app.current_tenant();
  update public.notification_rules set notifyee_user_id = p_successor where notifyee_user_id = p_leaver and tenant_id = app.current_tenant();
  update public.departments set head_employee_id = p_successor where head_employee_id = p_leaver and tenant_id = app.current_tenant();
  update public.departments set hrbp_employee_id = p_successor where hrbp_employee_id = p_leaver and tenant_id = app.current_tenant();
  update public.departments set cxo_employee_id  = p_successor where cxo_employee_id  = p_leaver and tenant_id = app.current_tenant();
  update public.employees   set line_manager_id  = p_successor
   where line_manager_id = p_leaver and employee_id <> p_successor and tenant_id = app.current_tenant();

  -- Their own delegations end with them.
  delete from public.delegation_rules
   where (delegator_id = p_leaver or delegate_id = p_leaver) and tenant_id = app.current_tenant();

  update public.employees set active = false, left_on = (now() at time zone 'Asia/Dhaka')::date
   where employee_id = p_leaver and tenant_id = app.current_tenant();

  insert into public.activity_log (actor_id, action, entity_type, entity_id, detail)
  select p_actor, 'handed_over', 'employee', e.id,
         'Handed everything of ' || e.name || ' over to '
           || coalesce((select name from public.employees
                         where employee_id = p_successor and tenant_id = app.current_tenant()), p_successor)
    from public.employees e where e.employee_id = p_leaver and e.tenant_id = app.current_tenant();

  perform app.notify(p_successor, 'handover.received', 'You have taken over from a leaver',
    coalesce((select name from public.employees
               where employee_id = p_leaver and tenant_id = app.current_tenant()), p_leaver)
      || ' has left; their approvals and responsibilities are now yours (' || n || ' open or upcoming steps).');
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Overdue reminders.
--
-- This is what turns a target from something displayed into something
-- that does anything. A pending step past its date produces one reminder
-- per day for whoever is sitting on it — once per day, not once per
-- page load, which is why the existence check looks back twenty hours.
--
-- There is no scheduler in this demo, so the approvals screen calls this
-- when it loads. In a real deployment it would be a timer.
-- ---------------------------------------------------------------------
create or replace function public.remind_overdue()
returns int
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select ar.approver_user_id, ar.subject_type, ar.subject_id, ar.deadline_at
      from public.approval_requests ar
     where ar.status = 'pending'
       and ar.approver_user_id is not null
       and ar.deadline_at is not null
       and ar.deadline_at < now()
       and not exists (
         select 1 from public.notifications nt
          where nt.recipient_id = ar.approver_user_id
            and nt.kind = 'approval.overdue'
            and nt.entity_id = ar.subject_id
            and nt.created_at > now() - interval '20 hours')
  loop
    perform app.notify(
      r.approver_user_id, 'approval.overdue',
      'Overdue: ' || app.subject_label(r.subject_type, r.subject_id),
      'This was due ' || to_char(r.deadline_at at time zone 'Asia/Dhaka', 'DD/MM/YYYY') || ' and is still with you.',
      r.subject_type, r.subject_id);
    n := n + 1;
  end loop;
  return n;
end $$;

grant execute on function
  public.remind_overdue(),
  app.add_working_days(timestamptz, int),
  app.subject_requester(text, uuid),
  app.subject_ref(uuid),
  app.subject_label(text, uuid),
  app.notify(text, text, text, text, text, uuid)
to app_api;

grant execute on function
  public.build_approval_chain(text, uuid, uuid, numeric),
  public.act_on_approval(uuid, text, text, text, text),
  public.reassign_approval(uuid, text, text, text),
  public.add_reviewer(uuid, text, int, text),
  app.slab_approvers(uuid, numeric),
  app.set_subject_status(text, uuid, text, text),
  app.line_manager_of(text),
  app.submission_amount(uuid),
  app.may_act(text, text, uuid, text),
  app.assert_may_act(text, text, uuid, text),
  app.rule_role(text),
  app.leading_number(text),
  app.answers_of(uuid),
  app.amount_in(uuid, jsonb),
  app.condition_holds(jsonb, jsonb),
  app.plan_chain(text, uuid, text, jsonb),
  public.preview_approval_chain(uuid, text, jsonb),
  app.notify_cc(uuid, text, text, text),
  app.involved_in(uuid, text),
  public.add_note(uuid, text, text),
  public.set_cc(uuid, text[], text),
  public.link_submissions(uuid, text, text, text),
  public.unlink_submissions(uuid, uuid, text),
  public.copy_submission(uuid, text),
  public.delete_draft(uuid, text),
  public.hand_over(text, text, text),
  app.resolve_role(text, text),
  app.is_org_role(text),
  app.log_event(uuid, text, uuid, text, text, text, text),
  app.phase_done(uuid, int),
  app.advance(text, uuid, int),
  app.spawn_followup(uuid),
  app.assert_requester_may_withdraw(uuid, text),
  public.return_to_approver(uuid, uuid, text, text),
  public.recall_submission(uuid, text),
  public.cancel_submission(uuid, text, text),
  public.ask_question(uuid, text, text, text),
  public.answer_question(uuid, text, text)
to app_api;

commit;
