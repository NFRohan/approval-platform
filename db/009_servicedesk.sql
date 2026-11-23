-- =====================================================================
-- ServiceDesk Plus, live.
--
-- In: a ticket that needs approval — an access request, a purchase —
-- arrives from ServiceDesk (its webhook, or this side fetching new
-- tickets through its API) and becomes a request here on the form its
-- category or template is mapped to, raised as the ticket's requester.
--
-- Out: what happens to the request is written back to the ticket — a
-- note as each step decides, then a resolution and the ticket closed
-- when it is approved, or closed as rejected. Queued here, sent by the
-- server (src/server/servicedesk.ts), every exchange kept.
-- =====================================================================

begin;

do $p$
declare t text;
begin
  foreach t in array array['servicedesk_links', 'servicedesk_events'] loop
    execute format('drop policy if exists %1$s_read on public.%1$I', t);
    execute format($f$create policy %1$s_read on public.%1$I for select to app_api
                      using (tenant_id = app.current_tenant() and app.is_member()
                             and (app.has_permission('integrations.manage') or app.has_permission('audit.view')))$f$, t);
  end loop;
end $p$;

-- An organisation starts with a link that is not connected, mapped for
-- the two kinds of ticket that need an approval chain.
create or replace function app.seed_servicedesk(p_tenant uuid)
returns void
language sql
security definer
set search_path = public, app, pg_temp
as $$
  insert into public.servicedesk_links (tenant_id, enabled, inbound_secret, form_map)
  values (p_tenant, false, encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'),
          '[{"match": "Access", "form": "IT System Access Request"},
            {"match": "Purchase Request", "form": "Capital Expenditure Request"}]'::jsonb)
  on conflict (tenant_id) do nothing
$$;

create or replace function public.save_servicedesk(
  p_enabled boolean, p_base_url text, p_token_sealed text, p_allow_self_signed boolean,
  p_default_form text, p_form_map jsonb, p_approved_closure text, p_rejected_closure text, p_inbound_secret text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_bad text; e jsonb;
begin
  perform app.require_permission('integrations.manage');
  if coalesce(p_base_url, '') <> '' and p_base_url !~ '^https?://[^\s/]+(:\d+)?/?$' then
    raise exception 'the address is ServiceDesk''s own, like https://servicedesk.example.com:8080 — no path';
  end if;
  if jsonb_typeof(coalesce(p_form_map, '[]')) <> 'array' then raise exception 'the mapping must be a list'; end if;
  for e in select * from jsonb_array_elements(coalesce(p_form_map, '[]')) loop
    if coalesce(trim(e->>'match'), '') = '' then raise exception 'every mapping needs a category or template to match'; end if;
    if not exists (select 1 from public.form_templates where tenant_id = app.current_tenant() and name = e->>'form' and status = 'published') then
      raise exception 'there is no published form called %', coalesce(e->>'form', '(none)');
    end if;
  end loop;
  if coalesce(p_default_form, '') <> ''
     and not exists (select 1 from public.form_templates where tenant_id = app.current_tenant() and name = p_default_form and status = 'published') then
    raise exception 'there is no published form called %', p_default_form;
  end if;
  if p_enabled and (coalesce(p_base_url, '') = '' or (p_token_sealed is null
       and (select token_sealed from public.servicedesk_links where tenant_id = app.current_tenant()) is null)) then
    raise exception 'connecting needs ServiceDesk''s address and a technician key';
  end if;

  perform app.seed_servicedesk(app.current_tenant());
  update public.servicedesk_links
     set enabled = coalesce(p_enabled, false),
         base_url = nullif(rtrim(trim(p_base_url), '/'), ''),
         token_sealed = coalesce(p_token_sealed, token_sealed),
         allow_self_signed = coalesce(p_allow_self_signed, false),
         default_form = nullif(trim(p_default_form), ''),
         form_map = coalesce(p_form_map, '[]'),
         approved_closure = coalesce(nullif(trim(p_approved_closure), ''), 'Success'),
         rejected_closure = coalesce(nullif(trim(p_rejected_closure), ''), 'Rejected'),
         inbound_secret = coalesce(p_inbound_secret, inbound_secret),
         updated_by = app.current_employee(), updated_at = now()
   where tenant_id = app.current_tenant();
  perform app.audit(case when p_inbound_secret is not null then 'servicedesk_secret_rotated' else 'servicedesk_changed' end,
                    'tenant', null::uuid,
                    concat_ws(' · ', case when p_enabled then 'connected' else 'not connected' end, nullif(p_base_url, ''),
                              jsonb_array_length(coalesce(p_form_map, '[]')) || ' mapping(s)',
                              case when p_token_sealed is not null then 'technician key changed' end));
end $$;

-- Which form a ticket becomes: its template, then its category, matched
-- against the mapping in order; else the default form; else none, and
-- the ticket is left alone — most of a service desk's tickets need no
-- approval.
create or replace function app.servicedesk_form(p_tenant uuid, p_template text, p_category text)
returns uuid
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(
    (select t.id
       from public.servicedesk_links l,
            jsonb_array_elements(l.form_map) with ordinality m(e, ord)
       join public.form_templates t on t.tenant_id = p_tenant and t.name = m.e->>'form' and t.status = 'published'
      where l.tenant_id = p_tenant
        and lower(trim(m.e->>'match')) in (lower(trim(coalesce(p_template, ''))), lower(trim(coalesce(p_category, ''))))
      order by (lower(trim(m.e->>'match')) = lower(trim(coalesce(p_template, '')))) desc, m.ord
      limit 1),
    (select t.id from public.servicedesk_links l
       join public.form_templates t on t.tenant_id = p_tenant and t.name = l.default_form and t.status = 'published'
      where l.tenant_id = p_tenant))
$$;

-- Queue something to write back to the ticket.
create or replace function app.servicedesk_queue(p_tenant uuid, p_ticket text, p_submission uuid, p_kind text, p_payload jsonb)
returns void
language sql
security definer
set search_path = public, app, pg_temp
as $$
  insert into public.servicedesk_events (tenant_id, direction, kind, ticket_id, submission_id, status, payload)
  values (p_tenant, 'out', p_kind, p_ticket, p_submission, 'queued', p_payload)
$$;

-- One ticket, for the organisation in context. p_ticket is normalised by
-- the server: {id, subject, description, requester_email, requester_name,
-- category, template, priority, fields: {label: value}}.
create or replace function app.servicedesk_ticket(p_ticket jsonb, p_via text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_t uuid := app.current_tenant(); v_id text; v_form uuid; v_form_name text; v_req text; v_sub uuid; v_ref text;
  v_status text; v_reason text; f record; v_val text; v_first text;
begin
  v_id := nullif(trim(p_ticket->>'id'), '');
  if v_id is null then raise exception 'a ticket needs its id'; end if;

  select id, ref_number into v_sub, v_ref from public.form_submissions
   where tenant_id = v_t and external_system = 'servicedesk' and external_ref = v_id;
  if v_sub is not null then
    insert into public.servicedesk_events (tenant_id, direction, kind, ticket_id, submission_id, status, payload, error, done_at)
    values (v_t, 'in', p_via, v_id, v_sub, 'ignored', p_ticket, 'already raised here as ' || v_ref, now());
    return jsonb_build_object('outcome', 'duplicate', 'reference', v_ref, 'submission_id', v_sub);
  end if;

  v_form := app.servicedesk_form(v_t, p_ticket->>'template', p_ticket->>'category');
  select employee_id into v_req from public.employees e
   where e.tenant_id = v_t and e.active
     and ((coalesce(p_ticket->>'requester_email', '') <> '' and lower(e.email) = lower(trim(p_ticket->>'requester_email')))
          or (coalesce(p_ticket->>'requester_name', '') <> '' and lower(e.name) = lower(trim(p_ticket->>'requester_name'))))
   order by (lower(e.email) = lower(trim(coalesce(p_ticket->>'requester_email', '')))) desc nulls last
   limit 1;

  if v_form is null then
    v_status := 'ignored';
    v_reason := 'no form is mapped to ' || coalesce(nullif(p_ticket->>'template', ''), nullif(p_ticket->>'category', ''), 'tickets without a category');
  elsif v_req is null then
    v_status := 'refused';
    v_reason := coalesce(nullif(p_ticket->>'requester_email', ''), nullif(p_ticket->>'requester_name', ''), 'the requester') || ' is not in the org chart';
  end if;
  if v_status is not null then
    insert into public.servicedesk_events (tenant_id, direction, kind, ticket_id, status, payload, error, done_at)
    values (v_t, 'in', p_via, v_id, v_status, p_ticket, v_reason, now());
    if v_status = 'refused' then
      perform app.servicedesk_queue(v_t, v_id, null, 'note', jsonb_build_object('note', jsonb_build_object(
        'description', 'This ticket needs an approval, but it could not be raised in the Approval Management System: ' || v_reason || '.',
        'show_to_requester', false)));
    end if;
    return jsonb_build_object('outcome', v_status, 'reason', v_reason);
  end if;

  select name into v_form_name from public.form_templates where id = v_form;
  perform set_config('app.on_behalf', 'true', true);
  insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at, priority,
                                       external_system, external_ref)
  values (v_t, v_form, v_req, 'submitted', now(),
          case lower(coalesce(p_ticket->>'priority', '')) when 'high' then 'high' when 'urgent' then 'urgent' else 'normal' end,
          'servicedesk', v_id)
  returning id, ref_number into v_sub, v_ref;
  perform set_config('app.on_behalf', 'false', true);

  -- The form's own questions, answered from the ticket where it can:
  -- a field named like one of the ticket's, the requester's name, and
  -- the description for the first long answer left empty.
  for f in select field_name, field_type from public.form_fields
            where form_template_id = v_form and field_name is not null order by order_index loop
    v_val := case
      when f.field_type = 'gen_employee_name' then (select name from public.employees where tenant_id = v_t and employee_id = v_req)
      when f.field_type = 'gen_designation' then (select designation from public.employees where tenant_id = v_t and employee_id = v_req)
      else (select value from jsonb_each_text(coalesce(p_ticket->'fields', '{}')) where lower(key) = lower(f.field_name) limit 1) end;
    if v_val is null and f.field_type = 'textarea' and v_first is null then
      v_val := nullif(trim(coalesce(p_ticket->>'description', '')), '');
      v_first := f.field_name;
    end if;
    if coalesce(v_val, '') <> '' then
      insert into public.submission_values (tenant_id, submission_id, field_name, value) values (v_t, v_sub, f.field_name, v_val);
    end if;
  end loop;
  -- And the ticket itself, as it was raised there.
  insert into public.submission_values (tenant_id, submission_id, field_name, value)
  select v_t, v_sub, k, v from (values
    ('ServiceDesk ticket', '#' || v_id), ('Subject', p_ticket->>'subject'), ('Description', p_ticket->>'description'),
    ('ServiceDesk category', coalesce(nullif(p_ticket->>'template', ''), p_ticket->>'category'))) x(k, v)
   where coalesce(v, '') <> ''
     and not exists (select 1 from public.submission_values y where y.submission_id = v_sub and y.field_name = x.k);

  perform public.build_approval_chain('form_submission', v_sub, v_form);
  perform app.log_event(null, 'form_submission', v_sub, null, 'raised_from_servicedesk', 'ServiceDesk ticket #' || v_id, null);

  insert into public.servicedesk_events (tenant_id, direction, kind, ticket_id, submission_id, status, payload, done_at)
  values (v_t, 'in', p_via, v_id, v_sub, 'received', p_ticket, now());
  perform app.servicedesk_queue(v_t, v_id, v_sub, 'note', jsonb_build_object('note', jsonb_build_object(
    'description', 'Raised for approval in the Approval Management System as ' || v_ref || ' (' || v_form_name || '). '
      || coalesce('Waiting on ' || (select string_agg(distinct e.name, ', ') from public.approval_requests ar
                                     join public.employees e on e.employee_id = ar.approver_user_id and e.tenant_id = ar.tenant_id
                                    where ar.submission_id = v_sub and ar.status = 'pending') || '.', ''),
    'show_to_requester', true)));
  return jsonb_build_object('outcome', 'raised', 'reference', v_ref, 'submission_id', v_sub, 'form', v_form_name);
end $$;

-- A ticket typed in by hand, as ServiceDesk would send it: for trying the
-- link before ServiceDesk is connected.
create or replace function public.receive_servicedesk_ticket(p_ticket jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.require_permission('integrations.manage');
  return app.servicedesk_ticket(p_ticket, 'simulated');
end $$;

-- What happens here, written back to the ticket.
create or replace function app.servicedesk_on_event()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare s record; v_who text; v_step text; l record; v_steps text;
begin
  if new.subject_type <> 'form_submission' or coalesce(current_setting('app.no_mail', true), '') = 'true' then return new; end if;
  if new.action not in ('approved', 'rejected', 'clarification', 'completed', 'cancelled', 'recalled') then return new; end if;
  select id, tenant_id, ref_number, external_ref into s from public.form_submissions
   where id = new.subject_id and external_system = 'servicedesk';
  if not found then return new; end if;
  select * into l from public.servicedesk_links where tenant_id = s.tenant_id;

  select name into v_who from public.employees where tenant_id = s.tenant_id and employee_id = new.actor_id;
  select coalesce(ar.stage_label, ar.lane_label) into v_step from public.approval_requests ar where ar.id = new.request_id;
  v_who := coalesce(v_who, new.actor_id, 'The approval system');

  if new.action = 'approved' then
    perform app.servicedesk_queue(s.tenant_id, s.external_ref, s.id, 'note', jsonb_build_object('note', jsonb_build_object(
      'description', s.ref_number || ': approved by ' || v_who || coalesce(' (' || v_step || ')', '') || coalesce(' — "' || new.comment || '"', '') || '.',
      'show_to_requester', true)));
  elsif new.action = 'clarification' then
    perform app.servicedesk_queue(s.tenant_id, s.external_ref, s.id, 'note', jsonb_build_object('note', jsonb_build_object(
      'description', s.ref_number || ': ' || v_who || ' asked for clarification — "' || coalesce(new.comment, '') || '". Answer in the Approval Management System.',
      'show_to_requester', true)));
  elsif new.action = 'rejected' then
    perform app.servicedesk_queue(s.tenant_id, s.external_ref, s.id, 'note', jsonb_build_object('note', jsonb_build_object(
      'description', s.ref_number || ': rejected by ' || v_who || coalesce(' (' || v_step || ')', '') || coalesce(' — "' || new.comment || '"', '') || '.',
      'show_to_requester', true)));
    perform app.servicedesk_queue(s.tenant_id, s.external_ref, s.id, 'close', jsonb_build_object('request', jsonb_build_object(
      'closure_info', jsonb_build_object(
        'requester_ack_resolution', true,
        'closure_comments', 'Rejected in the Approval Management System (' || s.ref_number || ') by ' || v_who || coalesce(': ' || new.comment, '.'),
        'closure_code', jsonb_build_object('name', coalesce(l.rejected_closure, 'Rejected'))))));
  elsif new.action = 'completed' then
    select string_agg(e.name || coalesce(' (' || coalesce(ar.stage_label, ar.lane_label) || ')', '') || ', '
                      || to_char(ar.acted_at at time zone 'Asia/Dhaka', 'DD/MM/YYYY HH24:MI'), E'\n' order by ar.step_index, ar.lane, ar.lane_step)
      into v_steps
      from public.approval_requests ar join public.employees e on e.employee_id = ar.approver_user_id and e.tenant_id = ar.tenant_id
     where ar.submission_id = s.id and ar.status = 'approved';
    perform app.servicedesk_queue(s.tenant_id, s.external_ref, s.id, 'resolution', jsonb_build_object('resolution', jsonb_build_object(
      'content', 'Approved in the Approval Management System as ' || s.ref_number || E'.\n\nApproved by:\n' || coalesce(v_steps, '—'))));
    perform app.servicedesk_queue(s.tenant_id, s.external_ref, s.id, 'close', jsonb_build_object('request', jsonb_build_object(
      'closure_info', jsonb_build_object(
        'requester_ack_resolution', true,
        'closure_comments', 'Every approval given in the Approval Management System (' || s.ref_number || ').',
        'closure_code', jsonb_build_object('name', coalesce(l.approved_closure, 'Success'))))));
  else
    perform app.servicedesk_queue(s.tenant_id, s.external_ref, s.id, 'note', jsonb_build_object('note', jsonb_build_object(
      'description', s.ref_number || ': ' || case new.action when 'cancelled' then 'cancelled' else 'taken back to edit' end
        || ' by ' || v_who || coalesce(' — "' || new.comment || '"', '') || '.',
      'show_to_requester', true)));
  end if;
  return new;
end $$;

drop trigger if exists approval_events_servicedesk on public.approval_events;
create trigger approval_events_servicedesk after insert on public.approval_events
  for each row execute function app.servicedesk_on_event();

create or replace function public.retry_servicedesk_event(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.require_permission('integrations.manage');
  update public.servicedesk_events set status = 'queued', attempts = 0, next_attempt_at = now(), error = null
   where id = p_id and tenant_id = app.current_tenant() and direction = 'out' and status in ('failed', 'skipped', 'queued');
  if not found then raise exception 'no such write-back, or it was sent'; end if;
end $$;

grant execute on function
  public.save_servicedesk(boolean, text, text, boolean, text, jsonb, text, text, text),
  public.receive_servicedesk_ticket(jsonb),
  public.retry_servicedesk_event(uuid)
to app_api;
grant execute on all functions in schema app to app_api;

commit;
