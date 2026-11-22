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
create or replace function app.add_working_days(p_from timestamptz, p_days int)
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
    -- isodow: 1 = Monday … 5 = Friday, 6 = Saturday, 7 = Sunday
    if extract(isodow from (d at time zone 'Asia/Dhaka')) not in (5, 6) then
      n := n + 1;
    end if;
  end loop;
  return d;
end $$;

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
-- How much is this submission for?
--
-- Read from the submission's own money answer rather than taken from the
-- caller. The amount decides how far a claim climbs, and when it was a
-- parameter a claim could display 620,000 to everybody who opened it
-- while being routed as 50 — the CFO and the Head of Finance never asked.
--
-- The first money field on the form, by position, is the one that
-- routes. Answers are stored as text and may carry separators or a
-- currency mark, so only the leading number survives.
-- ---------------------------------------------------------------------
create or replace function app.submission_amount(p_submission uuid)
returns numeric
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce((
    select nullif(substring(regexp_replace(v.value, '[^0-9.]', '', 'g')
                            from '^[0-9]*(?:\.[0-9]+)?'), '')::numeric
      from public.form_submissions s
      join public.form_fields f
        on f.form_template_id = s.form_template_id and f.field_type = 'money'
      join public.submission_values v
        on v.submission_id = s.id and v.field_name = f.field_name
     where s.id = p_submission
     order by f.order_index nulls last, f.id
     limit 1), 0)
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
      select ft.name || ' (' || app.subject_ref(fs.id) || ')'
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
-- Build the chain.
--
-- Steps are created for every level at once, but only the first is
-- `pending`. The rest are `waiting`, which is what makes the queue
-- honest: an approver sees a request when it is their turn and not
-- before.
--
-- A rule labelled slab_finance is not one step. It expands into one step
-- per threshold the amount has crossed, which is where escalation
-- actually happens. The amount is the submission's own, read here; the
-- p_amount parameter is accepted and ignored, so that a client deployed
-- before this change still resolves the function.
--
-- A rule labelled line_manager means the requester's own line manager,
-- whoever raised it. The approver stored on the rule is only the
-- fallback for somebody with no manager on record. It used to be the
-- whole answer, so every request in the organisation went to one person.
--
-- Two rules then shape the ladder, both of which the HR clearance flow
-- in the scope of work asks for in as many words ("layers may be the
-- same person"):
--   * nobody approves their own request — a step that would land on the
--     requester is left out, and the chain goes on to the next level;
--   * the same person twice in a row is one step, not two.
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
  v_step      int := 0;
  v_approver  text;
  v_last      text;
  v_requester text;
  v_amount    numeric := 0;
  v_cands     text[] := '{}';
  v_days      int[]  := '{}';
  i           int;
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
    v_amount := app.submission_amount(p_subject_id);
  end if;

  -- First, who would be asked, in order.
  for r in
    select ar.approver_user_id, ar.deadline_days, ar.label, ar.step_index
      from public.approval_rules ar
     where ar.subject_type = p_subject_type
       and (p_subject_type <> 'form_submission'
            or ar.form_template_id = p_form_template_id)
     order by ar.step_index, ar.id
  loop
    if r.label = 'slab_finance' and p_subject_type = 'form_submission' then
      -- Every threshold crossed, in order, each its own step.
      for v_approver in
        select sa.approver_user_id from app.slab_approvers(p_form_template_id, v_amount) sa
      loop
        v_cands := array_append(v_cands, v_approver);
        v_days  := array_append(v_days, coalesce(r.deadline_days, 7));
      end loop;
    elsif app.rule_role(r.label) = 'line_manager' then
      v_cands := array_append(v_cands,
                   coalesce(app.line_manager_of(v_requester), r.approver_user_id));
      v_days  := array_append(v_days, coalesce(r.deadline_days, 7));
    else
      v_cands := array_append(v_cands, r.approver_user_id);
      v_days  := array_append(v_days, coalesce(r.deadline_days, 7));
    end if;
  end loop;

  -- Then the steps.
  for i in 1 .. coalesce(array_length(v_cands, 1), 0) loop
    v_approver := v_cands[i];
    -- A rule with no approver is configuration that was never finished.
    -- Skipping it is better than creating a step nobody can act on,
    -- which would stall the chain forever.
    continue when v_approver is null;
    continue when v_approver = v_requester;
    continue when v_approver = v_last;

    insert into public.approval_requests
      (submission_id, notice_id, stationery_request_id, maintenance_request_id,
       approver_user_id, step_index, status, deadline_at)
    values (
      case when p_subject_type = 'form_submission'     then p_subject_id end,
      case when p_subject_type = 'notice'              then p_subject_id end,
      case when p_subject_type = 'stationery_request'  then p_subject_id end,
      case when p_subject_type = 'maintenance_request' then p_subject_id end,
      v_approver, v_step,
      case when v_step = 0 then 'pending' else 'waiting' end,
      app.add_working_days(now(), v_days[i]));
    v_last := v_approver;
    v_step := v_step + 1;
  end loop;

  if v_step > 0 then
    select approver_user_id into v_approver
      from public.approval_requests
     where subject_id = p_subject_id and step_index = 0;

    perform app.set_subject_status(p_subject_type, p_subject_id, 'open', v_approver);

    -- The notification that actually matters: it is your turn.
    perform app.notify(
      v_approver, 'approval.turn',
      'Your approval is needed',
      app.subject_label(p_subject_type, p_subject_id)
        || ' is waiting on you, step 1 of ' || v_step || '.',
      p_subject_type, p_subject_id);

    -- Watchers configured against the form want to know it was raised.
    -- Like approvers, some are roles rather than people: the requester's
    -- line manager, the requester, the form's creator.
    if p_subject_type = 'form_submission' then
      for r in
        select distinct w.who
          from (
            select case app.rule_role(nr.label)
                     when 'line_manager' then coalesce(app.line_manager_of(v_requester),
                                                       nr.notifyee_user_id)
                     when 'submitter'    then v_requester
                     when 'creator'      then coalesce(
                                                (select ft.created_by
                                                   from public.form_templates ft
                                                  where ft.id = p_form_template_id),
                                                nr.notifyee_user_id)
                     else nr.notifyee_user_id
                   end as who
              from public.notification_rules nr
             where nr.form_template_id = p_form_template_id
          ) w
         where w.who is not null
           and w.who <> coalesce(v_approver, '')
      loop
        perform app.notify(
          r.who, 'submission.raised',
          'New submission',
          app.subject_label(p_subject_type, p_subject_id) || ' was submitted.',
          p_subject_type, p_subject_id);
      end loop;
    end if;
  end if;

  return v_step;
end $$;

-- ---------------------------------------------------------------------
-- Act on a step.
--
-- The one rule that makes this a chain: only a `pending` step can be
-- acted on. Everything above the live step is `waiting`, so there is
-- nothing for a later approver to press — the order is enforced by the
-- data, not by hiding a button.
-- ---------------------------------------------------------------------
create or replace function public.act_on_approval(
  p_request_id uuid,
  p_action     text,
  p_comment    text default null,
  p_actor      text default null
) returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_req    record;
  v_next   record;
begin
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
    return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'open',
                                  v_req.approver_user_id);
  end if;

  if v_req.status <> 'pending' then
    raise exception 'this step is not open: it is %', v_req.status;
  end if;

  if p_action = 'approve' then
    update public.approval_requests
       set status = 'approved', acted_at = now(), comment = coalesce(p_comment, comment)
     where id = p_request_id;

    select * into v_next
      from public.approval_requests
     where subject_id = v_req.subject_id
       and step_index > v_req.step_index
       and status = 'waiting'
     order by step_index
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

    -- Nothing above it: the chain is finished.
    perform app.notify(
      app.subject_requester(v_req.subject_type, v_req.subject_id),
      'request.completed',
      'Fully approved',
      app.subject_label(v_req.subject_type, v_req.subject_id)
        || ' has cleared every approver.',
      v_req.subject_type, v_req.subject_id);

    return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'done', null);

  elsif p_action = 'reject' then
    update public.approval_requests
       set status = 'rejected', acted_at = now(), comment = p_comment
     where id = p_request_id;

    -- A rejection ends the chain. The steps above it are marked skipped
    -- rather than deleted, so the trail still shows who would have been
    -- asked next.
    update public.approval_requests
       set status = 'skipped'
     where subject_id = v_req.subject_id
       and step_index > v_req.step_index
       and status = 'waiting';

    perform app.notify(
      app.subject_requester(v_req.subject_type, v_req.subject_id),
      'request.rejected',
      'Rejected',
      app.subject_label(v_req.subject_type, v_req.subject_id)
        || ' was rejected' || coalesce(': ' || p_comment, '.'),
      v_req.subject_type, v_req.subject_id);

    return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'rejected', null);

  elsif p_action = 'clarification' then
    -- Paused, not ended. The step stays with the same approver and the
    -- chain resumes where it stopped.
    update public.approval_requests
       set status = 'clarification', acted_at = now(), comment = p_comment
     where id = p_request_id;

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

  update public.approval_requests
     set approver_user_id = p_to,
         reassigned_from  = coalesce(v_req.reassigned_from, v_req.approver_user_id),
         comment          = coalesce(p_comment, comment)
   where id = p_request_id;

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
-- Add a reviewer to a chain already in flight.
--
-- The new step goes immediately after the one it is added from, and
-- everything above shuffles up. That renumbering passes through states
-- where two rows share an index, which is why the step-order constraint
-- is deferrable.
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
  select * into v_req from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'no such approval step';
  end if;
  perform app.assert_may_act(v_req.approver_user_id, v_req.subject_type,
                             v_req.subject_id, p_actor);
  if v_req.status not in ('pending', 'clarification') then
    raise exception 'a reviewer can only be added to an open step';
  end if;
  if not exists (select 1 from public.employees where employee_id = p_employee) then
    raise exception 'no employee with id %', p_employee;
  end if;

  set constraints all deferred;

  update public.approval_requests
     set step_index = step_index + 1
   where subject_id = v_req.subject_id
     and step_index > v_req.step_index;

  insert into public.approval_requests
    (submission_id, notice_id, stationery_request_id, maintenance_request_id,
     approver_user_id, step_index, status, deadline_at)
  values (v_req.submission_id, v_req.notice_id, v_req.stationery_request_id,
          v_req.maintenance_request_id,
          p_employee, v_req.step_index + 1, 'waiting',
          app.add_working_days(now(), coalesce(p_deadline_days, 7)))
  returning id into v_new;

  return v_new;
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
      'This was due ' || to_char(r.deadline_at, 'Mon DD') || ' and is still with you.',
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
  public.act_on_approval(uuid, text, text, text),
  public.reassign_approval(uuid, text, text, text),
  public.add_reviewer(uuid, text, int, text),
  app.slab_approvers(uuid, numeric),
  app.set_subject_status(text, uuid, text, text),
  app.line_manager_of(text),
  app.submission_amount(uuid),
  app.may_act(text, text, uuid, text),
  app.assert_may_act(text, text, uuid, text),
  app.rule_role(text)
to app_api;

commit;
