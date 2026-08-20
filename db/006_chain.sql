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
-- actually happens.
-- ---------------------------------------------------------------------
create or replace function public.build_approval_chain(
  p_subject_type text,
  p_subject_id uuid,
  p_form_template_id uuid default null,
  p_amount numeric default 0
) returns int
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r          record;
  v_step     int := 0;
  v_approver text;
  v_deadline timestamptz;
begin
  if p_subject_type not in ('form_submission', 'notice',
                            'stationery_request', 'maintenance_request') then
    raise exception 'unknown subject type: %', p_subject_type;
  end if;

  if exists (select 1 from public.approval_requests where subject_id = p_subject_id) then
    raise exception 'this already has an approval chain';
  end if;

  for r in
    select ar.approver_user_id, ar.deadline_days, ar.label, ar.step_index
      from public.approval_rules ar
     where ar.subject_type = p_subject_type
       and (p_subject_type <> 'form_submission'
            or ar.form_template_id = p_form_template_id)
     order by ar.step_index, ar.id
  loop
    v_deadline := now() + make_interval(days => coalesce(r.deadline_days, 7));

    if r.label = 'slab_finance' and p_subject_type = 'form_submission' then
      -- Every threshold crossed, in order, each its own step.
      for v_approver in
        select sa.approver_user_id from app.slab_approvers(p_form_template_id, p_amount) sa
      loop
        insert into public.approval_requests
          (submission_id, approver_user_id, step_index, status, deadline_at)
        values (p_subject_id, v_approver, v_step,
                case when v_step = 0 then 'pending' else 'waiting' end, v_deadline);
        v_step := v_step + 1;
      end loop;

    else
      -- A rule with no approver is configuration that was never
      -- finished. Skipping it is better than creating a step nobody
      -- can act on, which would stall the chain forever.
      continue when r.approver_user_id is null;

      insert into public.approval_requests
        (submission_id, notice_id, stationery_request_id, maintenance_request_id,
         approver_user_id, step_index, status, deadline_at)
      values (
        case when p_subject_type = 'form_submission'     then p_subject_id end,
        case when p_subject_type = 'notice'              then p_subject_id end,
        case when p_subject_type = 'stationery_request'  then p_subject_id end,
        case when p_subject_type = 'maintenance_request' then p_subject_id end,
        r.approver_user_id, v_step,
        case when v_step = 0 then 'pending' else 'waiting' end, v_deadline);
      v_step := v_step + 1;
    end if;
  end loop;

  if v_step > 0 then
    perform app.set_subject_status(
      p_subject_type, p_subject_id, 'open',
      (select approver_user_id from public.approval_requests
        where subject_id = p_subject_id and step_index = 0));
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
  p_comment    text default null
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
      return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'open',
                                    v_next.approver_user_id);
    end if;

    -- Nothing above it: the chain is finished.
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

    return app.set_subject_status(v_req.subject_type, v_req.subject_id, 'rejected', null);

  elsif p_action = 'clarification' then
    -- Paused, not ended. The step stays with the same approver and the
    -- chain resumes where it stopped.
    update public.approval_requests
       set status = 'clarification', acted_at = now(), comment = p_comment
     where id = p_request_id;

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
  p_comment     text default null
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
  p_deadline_days int default 7
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
          now() + make_interval(days => coalesce(p_deadline_days, 7)))
  returning id into v_new;

  return v_new;
end $$;

grant execute on function
  public.build_approval_chain(text, uuid, uuid, numeric),
  public.act_on_approval(uuid, text, text),
  public.reassign_approval(uuid, text, text),
  public.add_reviewer(uuid, text, int),
  app.slab_approvers(uuid, numeric),
  app.set_subject_status(text, uuid, text, text)
to app_api;

commit;
