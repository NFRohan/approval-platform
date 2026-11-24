-- =====================================================================
-- ServiceDesk Plus, live.
--
-- On a fresh evaluation: a ticket that needs approval becomes a request
-- on its mapped form, as its requester, once; one that does not is left
-- alone; one from a stranger is refused and the desk told why. Every
-- decision is queued to be written back, and the ticket resolved and
-- closed when the request is approved, or closed as rejected. Only
-- integrations.manage may change the link.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

select set_config('app.is_staff', 'true', false);
select set_config('t.tpl', (select tenant_id::text from app.provision_demo(
  'ServiceDesk Test', 'servicedesk.test.' || substr(md5(random()::text), 1, 8), 'hash', interval '1 day')), false);
select set_config('app.is_staff', 'false', false);
select set_config('app.no_mail', 'false', false);

create or replace function pg_temp.as_emp(p_emp text) returns void language plpgsql as $$
begin
  perform set_config('app.tenant_id',   current_setting('t.tpl'), true),
          set_config('app.user_id',     '00000000-0000-4000-8000-0000000000aa', true),
          set_config('app.role',        'admin', true),
          set_config('app.is_staff',    'false', true),
          set_config('app.employee_id', coalesce(p_emp, ''), true),
          set_config('app.api_key',     '', true),
          set_config('app.mfa',         'true', true);
end $$;

create or replace function pg_temp.refused(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $$;

create or replace function pg_temp.ticket(p_id text, p_email text, p_category text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'subject', 'Access to the finance ledger', 'description', 'Quarter-end close needs read access.',
                            'requester_email', p_email, 'category', p_category, 'priority', 'High',
                            'fields', jsonb_build_object('System', 'Finance ledger', 'Access level', 'Read only'))
$$;

-- Approve whatever is open on a request, as whoever holds it, until nothing is.
create or replace function pg_temp.approve_all(p_sub uuid) returns void language plpgsql as $$
declare r record;
begin
  for i in 1..10 loop
    select id, approver_user_id into r from public.approval_requests where submission_id = p_sub and status = 'pending' order by step_index limit 1;
    exit when not found;
    perform pg_temp.as_emp(r.approver_user_id);
    perform public.act_on_approval(r.id, 'approve', 'Fine by me', null);
  end loop;
end $$;

-- =====================================================================
-- 1. Tickets in
-- =====================================================================
begin;
  set local role app_api;
do $$
declare v jsonb; v_sub uuid; s record; v_n int;
begin
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused($q$select public.receive_servicedesk_ticket('{"id": "1"}'::jsonb)$q$) then
    raise exception 'FAIL: somebody without integrations.manage put a ticket in';
  end if;

  perform pg_temp.as_emp('EMP-0445');
  if (select jsonb_array_length(form_map) from public.servicedesk_links) <> 2 or (select enabled from public.servicedesk_links) then
    raise exception 'FAIL: the evaluation''s link is not the mapped, unconnected one it starts with';
  end if;

  v := public.receive_servicedesk_ticket(pg_temp.ticket('5101', 'TOM.BEXLEY@example.com', 'Access'));
  if v->>'outcome' <> 'raised' or v->>'form' <> 'IT System Access Request' then raise exception 'FAIL: an access ticket was not raised: %', v; end if;
  v_sub := (v->>'submission_id')::uuid;
  select * into s from public.form_submissions where id = v_sub;
  if s.submitted_by <> 'EMP-2847' or s.priority <> 'high' or s.external_ref <> '5101' then
    raise exception 'FAIL: the request is not Tom''s, high priority, linked to #5101: %', row_to_json(s);
  end if;
  if (select string_agg(field_name || '=' || value, '; ' order by field_name) from public.submission_values where submission_id = v_sub)
     not like '%Access level=Read only%Justification=Quarter-end close needs read access.%ServiceDesk ticket=#5101%System=Finance ledger%' then
    raise exception 'FAIL: the form was not answered from the ticket: %',
      (select string_agg(field_name || '=' || value, '; ' order by field_name) from public.submission_values where submission_id = v_sub);
  end if;
  if not exists (select 1 from public.approval_requests where submission_id = v_sub and status = 'pending') then
    raise exception 'FAIL: the request has no approval chain';
  end if;
  if not exists (select 1 from public.servicedesk_events where submission_id = v_sub and direction = 'out' and kind = 'note' and status = 'queued'
                  and payload #>> '{note,description}' like 'Raised for approval in the Approval Management System as ' || s.ref_number || '%Waiting on Sam Lindqvist%') then
    raise exception 'FAIL: the ticket is not told its request''s reference and who it waits on';
  end if;

  v := public.receive_servicedesk_ticket(pg_temp.ticket('5101', 'tom.bexley@example.com', 'Access'));
  if v->>'outcome' <> 'duplicate' or (select count(*) from public.form_submissions where external_ref = '5101') <> 1 then
    raise exception 'FAIL: the same ticket was raised twice: %', v;
  end if;

  v := public.receive_servicedesk_ticket(pg_temp.ticket('5102', 'tom.bexley@example.com', 'Printer'));
  if v->>'outcome' <> 'ignored' or exists (select 1 from public.form_submissions where external_ref = '5102') then
    raise exception 'FAIL: a ticket needing no approval was raised: %', v;
  end if;

  v := public.receive_servicedesk_ticket(pg_temp.ticket('5103', 'stranger@elsewhere.test', 'Access'));
  if v->>'outcome' <> 'refused' or exists (select 1 from public.form_submissions where external_ref = '5103') then
    raise exception 'FAIL: a stranger''s ticket was raised: %', v;
  end if;
  if not exists (select 1 from public.servicedesk_events where ticket_id = '5103' and direction = 'out' and kind = 'note'
                  and payload #>> '{note,description}' like '%stranger@elsewhere.test is not in the org chart%') then
    raise exception 'FAIL: the desk is not told why the ticket was refused';
  end if;

  -- A template name wins over the category it sits in.
  v := public.receive_servicedesk_ticket(pg_temp.ticket('5104', 'tom.bexley@example.com', 'Hardware')
         || '{"template": "Purchase Request"}'::jsonb);
  if v->>'form' <> 'Capital Expenditure Request' then raise exception 'FAIL: the template''s mapping was not used: %', v; end if;

  select count(*) into v_n from public.servicedesk_events where direction = 'in';
  if v_n <> 5 then raise exception 'FAIL: % tickets logged, not 5', v_n; end if;
end $$;
  reset role;
commit;
do $$ begin raise notice 'pass: a mapped ticket becomes a request as its requester, answered from the ticket and told its reference — once; others are left alone, strangers refused and the desk told why'; end $$;

-- =====================================================================
-- 2. Written back
-- =====================================================================
begin;
  set local role app_api;
do $$
declare v_sub uuid; v_other uuid; v_kinds text; v_close jsonb; v_steps int;
begin
  perform pg_temp.as_emp('EMP-0445');
  select id into v_sub from public.form_submissions where external_ref = '5101';
  select count(*) into v_steps from public.approval_requests where submission_id = v_sub;
  perform pg_temp.approve_all(v_sub);
  if v_sub is null or (select status from public.form_submissions where id = v_sub) is distinct from 'completed' then raise exception 'FAIL: the request did not complete'; end if;
  perform pg_temp.as_emp('EMP-0445');   -- who may read the exchanges
  select string_agg(kind, ',' order by seq) into v_kinds
    from public.servicedesk_events where submission_id = v_sub and direction = 'out';
  if v_kinds is distinct from 'note' || repeat(',note', v_steps) || ',resolution,close' then
    raise exception 'FAIL: the ticket was not told of each approval, then resolved and closed: %', v_kinds;
  end if;
  if not exists (select 1 from public.servicedesk_events where submission_id = v_sub and kind = 'note' and payload #>> '{note,description}' like '%approved by Sam Lindqvist%') then
    raise exception 'FAIL: an approval note does not say who approved: %', (select string_agg(payload #>> '{note,description}', ' | ') from public.servicedesk_events where submission_id = v_sub and kind = 'note');
  end if;
  select payload into v_close from public.servicedesk_events where submission_id = v_sub and kind = 'close';
  if v_close #>> '{request,closure_info,closure_code,name}' <> 'Success' then raise exception 'FAIL: the approved ticket closes as %', v_close; end if;
  if not exists (select 1 from public.servicedesk_events where submission_id = v_sub and kind = 'resolution'
                  and payload #>> '{resolution,content}' like '%Approved by:%Sam Lindqvist%') then
    raise exception 'FAIL: the resolution does not list who approved';
  end if;

  -- The purchase, rejected at its first step.
  select id into v_other from public.form_submissions where external_ref = '5104';
  perform pg_temp.as_emp((select approver_user_id from public.approval_requests where submission_id = v_other and status = 'pending' order by step_index limit 1));
  perform public.act_on_approval((select id from public.approval_requests where submission_id = v_other and status = 'pending' order by step_index limit 1),
                                 'reject', 'Not this quarter', null);
  perform pg_temp.as_emp('EMP-0445');
  select payload into v_close from public.servicedesk_events where submission_id = v_other and kind = 'close';
  if v_close #>> '{request,closure_info,closure_code,name}' <> 'Rejected'
     or v_close #>> '{request,closure_info,closure_comments}' not like '%Not this quarter%' then
    raise exception 'FAIL: the rejected ticket is not closed as rejected, with why: %', v_close;
  end if;
end $$;
  reset role;
commit;
do $$ begin raise notice 'pass: each decision is queued for the ticket; approved, it is resolved with who approved and closed as Success; rejected, closed as Rejected with the reason'; end $$;

-- =====================================================================
-- 3. Keeping the link
-- =====================================================================
begin;
  set local role app_api;
do $$
begin
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused($q$select public.save_servicedesk(false, '', null, false, null, '[]', 'Success', 'Rejected', null)$q$) then
    raise exception 'FAIL: somebody without integrations.manage changed the link';
  end if;
  if exists (select 1 from public.servicedesk_links) or exists (select 1 from public.servicedesk_events) then
    raise exception 'FAIL: somebody without integrations.manage or audit.view can read the link or its log';
  end if;

  perform pg_temp.as_emp('EMP-0445');
  if not pg_temp.refused($q$select public.save_servicedesk(true, 'https://sd.example.test', null, false, null, '[]', 'Success', 'Rejected', null)$q$) then
    raise exception 'FAIL: the link was connected without a technician key';
  end if;
  if not pg_temp.refused($q$select public.save_servicedesk(false, 'https://sd.example.test/?redirect=x', null, false, null, '[]', 'Success', 'Rejected', null)$q$) then
    raise exception 'FAIL: an address with a query string was taken';
  end if;
  if not pg_temp.refused($q$select public.save_servicedesk(false, '', null, false, null, '[{"match": "Access", "form": "No such form"}]', 'Success', 'Rejected', null)$q$) then
    raise exception 'FAIL: a mapping to a form that does not exist was taken';
  end if;
  perform public.save_servicedesk(true, 'https://sd.example.test:8080/', 'v1.sealed', true, 'Leave Application',
                                  '[{"match": "Access", "form": "IT System Access Request"}]', 'Resolved OK', 'Denied', null);
  if (select row(enabled, base_url, allow_self_signed, default_form, approved_closure) from public.servicedesk_links)
     is distinct from row(true, 'https://sd.example.test:8080'::text, true, 'Leave Application'::text, 'Resolved OK'::text) then
    raise exception 'FAIL: the link was not saved as given';
  end if;
  if not exists (select 1 from public.activity_log where action = 'servicedesk_changed') then raise exception 'FAIL: changing the link was not recorded'; end if;

  -- The cloud: a portal under its data centre's address, signed in through Zoho.
  if not pg_temp.refused($q$select public.save_servicedesk(false, 'https://sdpondemand.manageengine.in/app/itdesk/api/v3/requests', null, false, null, '[]', 'Success', 'Rejected', null)$q$) then
    raise exception 'FAIL: an address with the API path on it was taken';
  end if;
  perform public.save_servicedesk(false, 'https://sdpondemand.manageengine.in/app/itdesk', null, false, null, '[]', 'Success', 'Rejected', null);
  if not pg_temp.refused($q$select public.save_servicedesk_oauth('https://accounts.zoho.in.evil.test', '1000.ABC', 'v1.s', 'v1.r')$q$) then
    raise exception 'FAIL: a sign-in through something other than Zoho''s accounts server was taken';
  end if;
  perform public.save_servicedesk_oauth('https://accounts.zoho.in', '1000.ABC', 'v1.secret', 'v1.refresh');
  if (select row(auth_mode, oauth_accounts_url, oauth_client_id) from public.servicedesk_links)
     is distinct from row('oauth'::text, 'https://accounts.zoho.in'::text, '1000.ABC'::text) then
    raise exception 'FAIL: the Zoho sign-in was not kept';
  end if;
  -- Signed in, it may connect with no technician key at all.
  perform public.save_servicedesk(true, 'https://sdpondemand.manageengine.in/app/itdesk', null, false, null, '[]', 'Success', 'Rejected', null);
  if not (select enabled and auth_mode = 'oauth' from public.servicedesk_links) then
    raise exception 'FAIL: a cloud link signed in through Zoho could not be connected';
  end if;
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused($q$select public.save_servicedesk_oauth('https://accounts.zoho.in', '1000.ABC', 'v1.s', 'v1.r')$q$) then
    raise exception 'FAIL: somebody without integrations.manage signed the link in';
  end if;
end $$;
  reset role;
commit;
do $$ begin raise notice 'pass: only integrations.manage changes the link, with an address, a key or a Zoho sign-in through Zoho''s own servers, and real forms; the change is recorded'; end $$;

delete from public.tenants where id = current_setting('t.tpl')::uuid;

do $$ begin raise notice 'ALL SERVICEDESK TESTS PASSED'; end $$;
