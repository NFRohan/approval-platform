-- =====================================================================
-- What the SOW still asked for (db/009_sow_gaps.sql).
--
-- On a fresh evaluation: the SOW's remaining forms are there and route;
-- an exit clearance track clears only once its checklist is ticked, by
-- whoever holds it; a step reminds at its interval, no oftener; a form
-- may keep forwarding inside the reporting line; and a leaver's IT track
-- raises a ServiceDesk ticket that clears it when resolved.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

select set_config('app.is_staff', 'true', false);
select set_config('t.tpl', (select tenant_id::text from app.provision_demo(
  'SOW Gaps Test', 'sowgaps.test.' || substr(md5(random()::text), 1, 8), 'hash', interval '1 day')), false);
select set_config('app.is_staff', 'false', false);

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

create or replace function pg_temp.raise_request(p_form text, p_by text, p_answers jsonb) returns uuid language plpgsql as $$
declare v_tpl uuid; v_sub uuid;
begin
  select id into v_tpl from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = p_form;
  insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
  values (current_setting('t.tpl')::uuid, v_tpl, p_by, 'submitted', now()) returning id into v_sub;
  insert into public.submission_values (tenant_id, submission_id, field_name, value)
  select current_setting('t.tpl')::uuid, v_sub, key, value from jsonb_each_text(p_answers);
  perform public.build_approval_chain('form_submission', v_sub, v_tpl);
  return v_sub;
end $$;

create or replace function pg_temp.step(p_sub uuid, p_track text) returns uuid language sql as $$
  select id from public.approval_requests
   where submission_id = p_sub and app.checklist_track(lane_label, stage_label) = p_track
   order by lane_step limit 1
$$;

create or replace function pg_temp.items(p_sub uuid, p_track text) returns setof uuid language sql as $$
  select i.id from public.checklist_items i join public.form_submissions s on s.form_template_id = i.form_template_id
   where s.id = p_sub and i.track = p_track and i.active order by i.position
$$;

-- =====================================================================
-- 1. The forms the SOW names
-- =====================================================================
do $$
declare v record; v_plan jsonb;
begin
  perform pg_temp.as_emp('EMP-2847');
  select count(*) as n, count(*) filter (where status = 'published') as published,
         bool_and(exists (select 1 from public.approval_rules r where r.form_template_id = t.id)) as routed,
         bool_and(exists (select 1 from public.form_fields f where f.form_template_id = t.id)) as fielded
    into v from public.form_templates t
   where tenant_id = current_setting('t.tpl')::uuid
     and name in ('New SIM Requisition', 'SIM Transfer', 'Fraud Incident Fund Transfer', 'Compensatory Allowance', 'Night Allowance');
  if v.n <> 5 or v.published <> 5 or not v.routed or not v.fielded then
    raise exception 'FAIL: the SOW''s forms are not all there, published, with fields and approvers: %', row_to_json(v);
  end if;
  v_plan := public.preview_approval_chain((select id from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Night Allowance'),
                                          'EMP-2847', '{}'::jsonb);
  if (select string_agg(e->>'approver', ',' order by (e->>'step_index')::int) from jsonb_array_elements(v_plan) e) <> 'EMP-1134,EMP-0201' then
    raise exception 'FAIL: a night allowance does not go to the line manager, then HR: %', v_plan;
  end if;
  v_plan := public.preview_approval_chain((select id from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Fraud Incident Fund Transfer'),
                                          'EMP-2847', '{"Amount": "250000"}'::jsonb);
  if (select string_agg(e->>'approver', ',' order by (e->>'step_index')::int) from jsonb_array_elements(v_plan) e) <> 'EMP-1134,EMP-0830,EMP-0312,EMP-0600' then
    raise exception 'FAIL: a 250,000 fraud transfer does not go line manager, compliance, then finance by amount: %', v_plan;
  end if;
  if (select count(distinct track) from public.checklist_items i join public.form_templates t on t.id = i.form_template_id
       where t.tenant_id = current_setting('t.tpl')::uuid and t.name = 'Employee Exit Clearance' and i.active) <> 7 then
    raise exception 'FAIL: the exit clearance does not carry a checklist for each of its seven tracks';
  end if;
  -- The SOW's own items, division by division.
  if (select string_agg(item, '|' order by position) from public.checklist_items i join public.form_templates t on t.id = i.form_template_id
       where t.tenant_id = current_setting('t.tpl')::uuid and t.name = 'Employee Exit Clearance' and i.active and i.track = 'Supply Chain')
       <> 'Mobile SIM (for merchant wallet, if applicable)'
     or (select count(*) from public.checklist_items i join public.form_templates t on t.id = i.form_template_id
          where t.tenant_id = current_setting('t.tpl')::uuid and t.name = 'Employee Exit Clearance' and i.active and i.track = 'Final settlement'
            and item in ('Security bond', 'Last LFA applied', 'Exit interview')) <> 3 then
    raise exception 'FAIL: the exit clearance checklists are not the SOW''s';
  end if;
  -- The leaver's own checklist, and Payroll after HR.
  if (select count(*) from public.form_fields f join public.form_templates t on t.id = f.form_template_id
       where t.tenant_id = current_setting('t.tpl')::uuid and t.name = 'Employee Exit Clearance' and f.field_type = 'checkbox' and f.is_required) < 5 then
    raise exception 'FAIL: the leaver does not tick their own checklist on the form';
  end if;
  v_plan := public.preview_approval_chain((select id from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Employee Exit Clearance'),
                                          'EMP-2847', '{}'::jsonb);
  if (select e->>'approver' from jsonb_array_elements(v_plan) e order by (e->>'step_index')::int desc limit 1) <> 'EMP-0661'
     or (select e->>'stage_label' from jsonb_array_elements(v_plan) e order by (e->>'step_index')::int desc limit 1) <> 'Payroll settlement' then
    raise exception 'FAIL: Payroll does not settle last: %', v_plan;
  end if;
  if exists (select 1 from public.approval_rules where tenant_id = current_setting('t.tpl')::uuid
              and (label = 'business_finance' or label like 'answer:Business finance%') and remind_hours is distinct from 12) then
    raise exception 'FAIL: a Business Finance review does not remind every 12 hours';
  end if;
  raise notice 'pass: SIM requisition and transfer, fraud transfer, compensatory and night allowance are published and route; exit clearance has the SOW''s seven checklists, the leaver''s own and Payroll last; Business Finance reminds every 12 hours';
end $$;

-- =====================================================================
-- 2. Checklists
-- =====================================================================
do $$
declare v_sub uuid; v_fin uuid; v_item uuid; v jsonb; v_form uuid;
begin
  perform pg_temp.as_emp('EMP-2847');
  v_sub := pg_temp.raise_request('Employee Exit Clearance', 'EMP-2847',
    '{"Reason for leaving": "Resignation", "Resignation date": "2026-11-20", "Last working day": "2026-12-20"}');
  v_fin := pg_temp.step(v_sub, 'Finance & Accounts');
  perform set_config('t.exit', v_sub::text, false);

  perform pg_temp.as_emp('EMP-0312');
  if not pg_temp.refused(format($q$select public.act_on_approval(%L, 'approve', null, null)$q$, v_fin)) then
    raise exception 'FAIL: Finance cleared a leaver with its checklist unticked';
  end if;
  v := public.checklist_for(v_sub);
  if (select (e->>'can_tick')::boolean from jsonb_array_elements(v) e where e->>'track' = 'Finance & Accounts') is not true
     or (select (e->>'can_tick')::boolean from jsonb_array_elements(v) e where e->>'track' = 'Supply Chain') is not false then
    raise exception 'FAIL: Raj is not offered Finance''s checklist alone: %', v;
  end if;

  select x into v_item from pg_temp.items(v_sub, 'Supply Chain') x limit 1;
  if not pg_temp.refused(format($q$select public.tick_checklist(%L, %L, true)$q$, v_sub, v_item)) then
    raise exception 'FAIL: Raj ticked Supply Chain''s checklist';
  end if;
  perform pg_temp.as_emp('EMP-2847');
  select x into v_item from pg_temp.items(v_sub, 'Finance & Accounts') x limit 1;
  if not pg_temp.refused(format($q$select public.tick_checklist(%L, %L, true)$q$, v_sub, v_item)) then
    raise exception 'FAIL: the leaver ticked their own clearance';
  end if;

  perform pg_temp.as_emp('EMP-0312');
  for v_item in select * from pg_temp.items(v_sub, 'Finance & Accounts') loop
    perform public.tick_checklist(v_sub, v_item, true, null);
  end loop;
  -- Unticked again, and the step holds.
  perform public.tick_checklist(v_sub, v_item, false, null);
  if not pg_temp.refused(format($q$select public.act_on_approval(%L, 'approve', null, null)$q$, v_fin)) then
    raise exception 'FAIL: Finance cleared with an item unticked again';
  end if;
  perform public.tick_checklist(v_sub, v_item, true, 'Card shredded');
  perform public.act_on_approval(v_fin, 'approve', 'Settled', null);
  if (select status from public.approval_requests where id = v_fin) <> 'approved' then
    raise exception 'FAIL: Finance did not clear once its checklist was ticked';
  end if;
  if (select count(*) from public.approval_events where subject_id = v_sub and action = 'checklist_ticked') <> 5 then
    raise exception 'FAIL: each tick is not on the request''s history';
  end if;
  if (select e->>'state' from jsonb_array_elements(public.checklist_for(v_sub)) e where e->>'track' = 'Finance & Accounts') <> 'cleared' then
    raise exception 'FAIL: Finance''s checklist does not read as cleared';
  end if;

  -- Configuring them.
  select id into v_form from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Employee Exit Clearance';
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused(format($q$select public.save_checklist(%L, 'Supply Chain', array['x'])$q$, v_form)) then
    raise exception 'FAIL: an employee changed a clearance checklist';
  end if;
  perform pg_temp.as_emp('EMP-0201');
  perform public.save_checklist(v_form, 'Supply Chain', array['Toolkit returned', 'Assets on the inventory list returned']);
  if (select string_agg(item, '|' order by position) from public.checklist_items where form_template_id = v_form and track = 'Supply Chain' and active)
     <> 'Toolkit returned|Assets on the inventory list returned'
     or not exists (select 1 from public.checklist_items where form_template_id = v_form and track = 'Supply Chain'
                     and item = 'Mobile SIM (for merchant wallet, if applicable)' and not active) then
    raise exception 'FAIL: saving a checklist did not keep, add and retire its items in order';
  end if;
  if (select jsonb_array_length(e->'items') from jsonb_array_elements(public.checklist_config(v_form)) e where e->>'track' = 'Supply Chain') <> 2 then
    raise exception 'FAIL: the form''s checklist settings do not show what was saved';
  end if;
  raise notice 'pass: a track clears only with its checklist ticked, by whoever holds it — not another department, not the leaver; ticks are on the history; authorised users set the items';
end $$;

-- =====================================================================
-- 3. Reminders at an interval
-- =====================================================================
do $$
declare v_step uuid; v_sub uuid; v_n int;
begin
  perform pg_temp.as_emp('EMP-2847');
  v_sub := pg_temp.raise_request('Leave Application', 'EMP-2847', '{}');
  select id into v_step from public.approval_requests where submission_id = v_sub and status = 'pending' limit 1;
  update public.approval_requests set remind_hours = 12, opened_at = now() - interval '11 hours' where id = v_step;
  perform pg_temp.as_emp('');
  v_n := app.interval_reminders();
  if exists (select 1 from public.notifications where entity_id = v_sub and kind = 'approval.reminder') then
    raise exception 'FAIL: reminded after 11 hours of 12';
  end if;
  update public.approval_requests set opened_at = now() - interval '12 hours' where id = v_step;
  perform app.interval_reminders();
  perform app.interval_reminders();
  if (select count(*) from public.notifications where entity_id = v_sub and kind = 'approval.reminder') <> 1 then
    raise exception 'FAIL: not reminded exactly once at 12 hours';
  end if;
  update public.notifications set created_at = now() - interval '12 hours' where entity_id = v_sub and kind = 'approval.reminder';
  perform app.interval_reminders();
  if (select count(*) from public.notifications where entity_id = v_sub and kind = 'approval.reminder') <> 2 then
    raise exception 'FAIL: not reminded again 12 hours after the last reminder';
  end if;
  raise notice 'pass: a step reminds at its interval — not before, once, then again an interval after the last';
end $$;

-- =====================================================================
-- 4. Forwarding within the reporting line
-- =====================================================================
do $$
declare v_sub uuid; v_step uuid; v jsonb;
begin
  perform pg_temp.as_emp('EMP-2847');
  v_sub := pg_temp.raise_request('Fraud Incident Fund Transfer', 'EMP-2847', '{"Amount": "5000"}');
  select id into v_step from public.approval_requests where submission_id = v_sub and status = 'pending' limit 1;
  perform pg_temp.as_emp('EMP-1134');
  v := public.forward_candidates(v_step);
  if not (v->>'restricted')::boolean or not (v->'ids') ? 'EMP-0201' or (v->'ids') ? 'EMP-0410' then
    raise exception 'FAIL: Sam''s choices are not his reporting line: %', v;
  end if;
  if not pg_temp.refused(format($q$select public.reassign_approval(%L, 'EMP-0410', null, null)$q$, v_step)) then
    raise exception 'FAIL: a fraud transfer was forwarded outside the reporting line';
  end if;
  perform public.reassign_approval(v_step, 'EMP-0201', 'Over to you', null);
  if (select approver_user_id from public.approval_requests where id = v_step) <> 'EMP-0201' then
    raise exception 'FAIL: forwarding to Sam''s own manager was refused';
  end if;

  v_sub := pg_temp.raise_request('Leave Application', 'EMP-2847', '{}');
  select id into v_step from public.approval_requests where submission_id = v_sub and status = 'pending' limit 1;
  if (public.forward_candidates(v_step)->>'restricted')::boolean then
    raise exception 'FAIL: a form that forwards to anyone is restricted';
  end if;
  raise notice 'pass: a form kept to the reporting line forwards up or down it and nowhere else; others forward to anyone';
end $$;

-- =====================================================================
-- 5. IT clearance through ServiceDesk
-- =====================================================================
do $$
declare v_sub uuid; v_tech uuid; k record; e record; v jsonb;
begin
  perform pg_temp.as_emp('EMP-0445');
  perform public.save_servicedesk(true, 'https://sd.example.test', 'v1.sealed', false, null,
    '[{"match": "Access", "form": "IT System Access Request"}]', 'Success', 'Rejected', null);
  if not (select clearance_enabled from public.servicedesk_links where tenant_id = current_setting('t.tpl')::uuid) then
    raise exception 'FAIL: an evaluation does not start with IT clearance through ServiceDesk on';
  end if;

  perform pg_temp.as_emp('EMP-2847');
  v_sub := pg_temp.raise_request('Employee Exit Clearance', 'EMP-2847',
    '{"Reason for leaving": "Resignation", "Resignation date": "2026-11-20", "Last working day": "2026-12-20"}');
  v_tech := pg_temp.step(v_sub, 'Product & Technology');
  select * into k from public.servicedesk_tasks where submission_id = v_sub;
  select * into e from public.servicedesk_events where submission_id = v_sub and kind = 'create';
  if k.status <> 'opening' or k.approval_request_id <> v_tech or e.status <> 'queued'
     or e.payload #>> '{request,subject}' not like 'IT clearance: Tom Bexley (EMP-2847), last working day 2026-12-20'
     or e.payload #>> '{request,requester,email_id}' <> 'tom.bexley@example.com' then
    raise exception 'FAIL: the IT track opening did not queue a ServiceDesk ticket for the leaver: % %', row_to_json(k), e.payload;
  end if;
  -- Earlier exit clearances, raised before the link was connected, raised nothing.
  if (select count(*) from public.servicedesk_tasks where tenant_id = current_setting('t.tpl')::uuid) <> 1 then
    raise exception 'FAIL: a ticket was raised for a clearance from before the link';
  end if;

  perform app.servicedesk_task_opened(k.id, '9001');
  perform pg_temp.as_emp('');
  v := app.servicedesk_clearance_update('9001', 'Open');
  if v->>'outcome' <> 'still open' or (select status from public.approval_requests where id = v_tech) <> 'pending' then
    raise exception 'FAIL: an open ticket cleared the track: %', v;
  end if;
  if app.servicedesk_clearance_update('9999', 'Resolved') is not null then
    raise exception 'FAIL: a ticket that is not a clearance was taken for one';
  end if;
  v := app.servicedesk_clearance_update('9001', 'Resolved');
  if v->>'outcome' <> 'cleared' or (select status from public.approval_requests where id = v_tech) <> 'approved'
     or (select status from public.servicedesk_tasks where id = k.id) <> 'cleared' then
    raise exception 'FAIL: the resolved ticket did not clear the IT track: %', v;
  end if;
  if exists (select 1 from pg_temp.items(v_sub, 'Product & Technology') i
              where not exists (select 1 from public.checklist_ticks t where t.submission_id = v_sub and t.item_id = i
                                 and t.done_by = 'EMP-0520' and t.note = 'Cleared in ServiceDesk #9001')) then
    raise exception 'FAIL: the IT checklist is not ticked in Omar''s name, from the ticket';
  end if;
  if not exists (select 1 from public.approval_events where subject_id = v_sub and action = 'clearance_ticket' and comment = 'ServiceDesk #9001')
     or not exists (select 1 from public.approval_events where request_id = v_tech and action = 'approved' and comment like 'IT clearance completed in ServiceDesk (#9001, Resolved)') then
    raise exception 'FAIL: the history does not show the ticket raised and the clearance it gave';
  end if;
  if app.servicedesk_clearance_update('9001', 'Closed')->>'outcome' <> 'cleared already' then
    raise exception 'FAIL: closing the ticket after it was resolved cleared it twice';
  end if;

  -- Returned and reopened, the track keeps its one ticket.
  update public.approval_requests set status = 'pending' where id = v_tech;
  if (select count(*) from public.servicedesk_tasks where submission_id = v_sub) <> 1 then
    raise exception 'FAIL: reopening the IT track raised a second ticket';
  end if;

  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused($q$select public.save_servicedesk_clearance(false, null, null, null)$q$) then
    raise exception 'FAIL: an employee turned IT clearance off';
  end if;
  raise notice 'pass: a leaver''s IT track raises one ServiceDesk ticket; resolved there, its checklist is ticked and the track clears';
end $$;

-- =====================================================================
-- 6. Passwords apart from application data
-- =====================================================================
do $$
declare v_user uuid; v_old text; v_refused boolean := false;
begin
  select id into v_user from public.app_users where tenant_id = current_setting('t.tpl')::uuid limit 1;
  if not exists (select 1 from vault.credentials where user_id = v_user and password_hash = 'hash') then
    raise exception 'FAIL: the account''s password is not kept in the vault';
  end if;
  begin
    set local role app_api;
    perform 1 from vault.credentials limit 1;
  exception when insufficient_privilege then
    v_refused := true;
  end;
  reset role;
  if not v_refused then raise exception 'FAIL: the application''s role can read the vault'; end if;

  -- Registering and resetting go through the vault, the old one into the history.
  perform pg_temp.as_emp('EMP-0445');
  update public.app_users set password_hash = 'hash-2', password_history = array['hash'] where id = v_user;
  if (select row(password_hash, password_history) from vault.credentials where user_id = v_user) <> row('hash-2'::text, array['hash']::text[]) then
    raise exception 'FAIL: a changed password did not reach the vault with its history';
  end if;
end $$;
do $$ begin raise notice 'pass: passwords and their history are kept in a vault the application''s role cannot read'; end $$;

-- =====================================================================
-- 7. Who sees a form: departments or roles
-- =====================================================================
do $$
declare v_role uuid; v_form uuid;
begin
  perform pg_temp.as_emp('');
  select id into v_role from public.roles where tenant_id = current_setting('t.tpl')::uuid and name = 'Compliance auditor';
  select id into v_form from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Night Allowance';
  update public.form_templates set audience_departments = null, audience_roles = array[v_role] where id = v_form;
  perform pg_temp.as_emp('EMP-2847');
  if app.in_audience(v_form) then raise exception 'FAIL: Tom sees a form for compliance auditors only'; end if;
  perform pg_temp.as_emp('EMP-0830');
  if not app.in_audience(v_form) then raise exception 'FAIL: Lena, a compliance auditor, does not see the form for her role'; end if;
  perform pg_temp.as_emp('');
  update public.form_templates set audience_departments = array['Operations'] where id = v_form;
  perform pg_temp.as_emp('EMP-2847');
  if not app.in_audience(v_form) then raise exception 'FAIL: Tom, in Operations, does not see a form for Operations or the auditors'; end if;
end $$;
do $$ begin raise notice 'pass: a form is seen by its departments or by whoever holds its roles, and nobody else'; end $$;

-- =====================================================================
-- 8. A role given to a department
-- =====================================================================
do $$
declare v_role uuid;
begin
  perform pg_temp.as_emp('EMP-2847');
  if app.has_permission('audit.view') then raise exception 'FAIL: Tom can read the audit trail before anybody gave him the role'; end if;
  perform pg_temp.as_emp('EMP-0445');
  select id into v_role from public.roles where tenant_id = current_setting('t.tpl')::uuid and name = 'Compliance auditor';
  perform public.assign_role_group('Operations', v_role, true);
  perform pg_temp.as_emp('EMP-2847');
  if not app.has_permission('audit.view') then raise exception 'FAIL: Tom, in Operations, does not hold the role given to Operations'; end if;
  perform pg_temp.as_emp('EMP-0445');
  if not pg_temp.refused(format($q$select public.assign_role_group('Admin', %L, true)$q$, v_role)) then
    raise exception 'FAIL: Farah gave a role to her own department';
  end if;
  perform public.assign_role_group('Operations', v_role, false);
  perform pg_temp.as_emp('EMP-2847');
  if app.has_permission('audit.view') then raise exception 'FAIL: the role stayed with Tom after it was taken from Operations'; end if;
end $$;
do $$ begin raise notice 'pass: a role given to a department is held by everyone in it, and goes when it is taken; nobody gives one to their own department'; end $$;

-- =====================================================================
-- 9. Who is told, and when
-- =====================================================================
create or replace function pg_temp.approve_all(p_sub uuid) returns void language plpgsql as $$
declare r record;
begin
  for i in 1..20 loop
    select id, approver_user_id into r from public.approval_requests where submission_id = p_sub and status = 'pending' order by step_index limit 1;
    exit when not found;
    perform pg_temp.as_emp(r.approver_user_id);
    perform public.act_on_approval(r.id, 'approve', 'Fine', null, case when (select require_signature from public.approval_requests where id = r.id)
                                                                 then 'data:image/png;base64,AAAA' end);
  end loop;
end $$;

do $$
declare v_big uuid; v_small uuid;
begin
  perform pg_temp.as_emp('EMP-2847');
  v_big := pg_temp.raise_request('Capital Expenditure Request', 'EMP-2847',
    '{"Project": "Data centre", "Classification": "Budgetary", "Amount": "2000000", "Justification": "Capacity"}');
  v_small := pg_temp.raise_request('Capital Expenditure Request', 'EMP-2847',
    '{"Project": "Printers", "Classification": "Budgetary", "Amount": "400000", "Justification": "Old ones"}');
  if exists (select 1 from public.notifications where entity_id in (v_big, v_small) and recipient_id = 'EMP-0700' and kind = 'submission.raised') then
    raise exception 'FAIL: the CFO, who asked to hear of approvals only, was told a request was raised';
  end if;
  perform pg_temp.approve_all(v_big);
  perform pg_temp.approve_all(v_small);
  if (select status from public.form_submissions where id = v_big) <> 'completed' then raise exception 'FAIL: the large request did not complete'; end if;
  if not exists (select 1 from public.notifications where entity_id = v_big and recipient_id = 'EMP-0700' and kind = 'watch.approved') then
    raise exception 'FAIL: the CFO was not told a 2,000,000 capital expenditure was approved';
  end if;
  if exists (select 1 from public.notifications where entity_id = v_small and recipient_id = 'EMP-0700' and kind = 'watch.approved') then
    raise exception 'FAIL: the CFO was told of a 400,000 one, below his condition';
  end if;
end $$;
do $$ begin raise notice 'pass: a watcher is told on the events they name, and only when the answers meet their condition'; end $$;

-- =====================================================================
-- 10. Trackers
-- =====================================================================
do $$
declare v_id uuid; v_sub uuid; v_n int;
begin
  if (select count(*) from public.trackers where tenant_id = current_setting('t.tpl')::uuid) <> 3 then
    raise exception 'FAIL: an evaluation does not start with its three trackers';
  end if;
  perform pg_temp.as_emp('EMP-2847');
  select count(*) into v_n from public.tracker_rows('{"forms": ["Employee Exit Clearance"]}');
  if v_n < 1 or exists (select 1 from public.tracker_rows('{"forms": ["Employee Exit Clearance"]}') r where r.form <> 'Employee Exit Clearance') then
    raise exception 'FAIL: a tracker for one form shows others, or none';
  end if;
  if exists (select 1 from public.tracker_rows('{"overdue": true}') r where not r.overdue) then
    raise exception 'FAIL: the overdue tracker shows something not overdue';
  end if;

  v_id := public.save_tracker(null, 'My leave', null, 'me', '{"forms": ["Leave Application"]}');
  select id into v_sub from public.form_submissions where tenant_id = current_setting('t.tpl')::uuid and submitted_by = 'EMP-2847' order by submitted_at desc limit 1;
  perform public.set_tracker_reminder(v_sub, (now() at time zone 'Asia/Dhaka')::date, 'Chase finance');
  if (select remind_on from public.tracker_rows('{}') r where r.id = v_sub) is null then
    raise exception 'FAIL: the tracker does not show Tom his reminder';
  end if;
  perform pg_temp.as_emp('EMP-1134');
  if not pg_temp.refused(format($q$select public.save_tracker(%L, 'Mine now', null, 'everyone', '{}')$q$, v_id)) then
    raise exception 'FAIL: Sam changed Tom''s tracker';
  end if;
  if (select remind_on from public.tracker_rows('{}') r where r.id = v_sub) is not null then
    raise exception 'FAIL: Sam sees Tom''s reminder';
  end if;

  perform pg_temp.as_emp('');
  v_n := app.tracker_reminders_due();
  if v_n < 1 or not exists (select 1 from public.notifications where recipient_id = 'EMP-2847' and kind = 'tracker.reminder' and entity_id = v_sub
                                                                  and body = 'Chase finance') then
    raise exception 'FAIL: the reminder due today did not reach Tom';
  end if;
  if app.tracker_reminders_due() <> 0 then raise exception 'FAIL: a reminder was sent twice'; end if;
end $$;
begin;
  set local role app_api;
  select pg_temp.as_emp('EMP-1134');
  do $$ begin
    if exists (select 1 from public.trackers where name = 'My leave') then raise exception 'FAIL: Sam can see a tracker Tom kept for himself'; end if;
    if (select count(*) from public.trackers where shared_with = 'everyone') <> 2 then raise exception 'FAIL: the shared trackers are not shown to everyone'; end if;
  end $$;
  select pg_temp.as_emp('EMP-0831');
  do $$ begin
    if not exists (select 1 from public.trackers where name = 'ABC declarations') then raise exception 'FAIL: Compliance cannot see its department''s tracker'; end if;
  end $$;
  reset role;
commit;
do $$ begin raise notice 'pass: trackers filter requests, are kept for their owner, department or everyone, and remind on the day asked'; end $$;

-- =====================================================================
-- 11. Push to a phone
-- =====================================================================
do $$
declare v_sub uuid; o record;
begin
  perform pg_temp.as_emp('EMP-2847');
  v_sub := pg_temp.raise_request('Leave Application', 'EMP-2847', '{}');
  if exists (select 1 from public.push_outbox where tenant_id = current_setting('t.tpl')::uuid) then
    raise exception 'FAIL: a push was queued for somebody with no device';
  end if;
  insert into public.push_subscriptions (tenant_id, employee_id, endpoint, p256dh, auth)
  values (current_setting('t.tpl')::uuid, 'EMP-1134', 'https://push.example.test/sam-phone-' || current_setting('t.tpl'), 'k', 'a');
  perform app.notify('EMP-1134', 'approval.turn', 'Your approval is needed', 'Leave Application is waiting on you.', 'form_submission', v_sub);
  perform app.notify('EMP-1134', 'note.added', 'A note on a request', 'Tom added a note.', 'form_submission', v_sub);
  select * into o from public.push_outbox where employee_id = 'EMP-1134' and url = '/approvals';
  if not found or o.status <> 'queued' or o.title <> 'Your approval is needed' then
    raise exception 'FAIL: an approval waiting was not queued for Sam''s phone, opening his queue';
  end if;
  if not exists (select 1 from public.push_outbox where employee_id = 'EMP-1134' and url = '/status/' || v_sub) then
    raise exception 'FAIL: a note was not queued for Sam''s phone, opening the request';
  end if;
  begin
    set local role app_api;
    perform 1 from public.push_subscriptions;
    if found then raise exception 'FAIL: the application''s role reads devices'; end if;
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;
do $$ begin raise notice 'pass: a notification is queued for the recipient''s phone, opening what it is about; nobody without a device gets one'; end $$;

-- =====================================================================
-- 12. Each request's steps, summed up, stay true
-- =====================================================================
do $$
declare v_bad int;
begin
  -- After everything above: raised, approved, rejected, forwarded,
  -- returned, cleared from ServiceDesk. The kept sums are what the steps say.
  select count(*) into v_bad
    from public.form_submissions s
    left join public.submission_stats st on st.submission_id = s.id
    left join lateral (
      select count(*) filter (where r.status <> 'skipped') total,
             count(*) filter (where r.status in ('approved', 'rejected')) done,
             max(r.acted_at) last_acted,
             min(r.deadline_at) filter (where r.status = 'pending') next_deadline
        from public.approval_requests r where r.submission_id = s.id
    ) a on true
   where s.tenant_id = current_setting('t.tpl')::uuid
     -- A request with no steps (a migrated ticket) needs no row: it reads as none.
     and ((st.submission_id is null and a.total + a.done > 0)
          or st.steps_total <> a.total or st.steps_done <> a.done
          or st.last_acted_at is distinct from a.last_acted or st.next_deadline is distinct from a.next_deadline);
  if v_bad > 0 then raise exception 'FAIL: % requests'' step sums disagree with their steps', v_bad; end if;
end $$;
do $$ begin raise notice 'pass: every request''s step sums, kept as its steps change, agree with the steps'; end $$;

-- =====================================================================
-- 13. Passwords live in the vault only
-- =====================================================================
do $$
declare v uuid;
begin
  if exists (select 1 from public.app_users where password_hash is not null or cardinality(password_history) > 0) then
    raise exception 'FAIL: an account row still holds a password hash';
  end if;
  -- A throwaway account in this test's own organisation.
  insert into public.app_users (tenant_id, username, password_hash, full_name, role)
  values (current_setting('t.tpl')::uuid, 'vault.test.' || substr(md5(random()::text), 1, 8), 'scrypt$00$11', 'Vault Test', 'admin')
  returning id into v;
  if (select password_hash from public.app_users where id = v) is not null then
    raise exception 'FAIL: a new account kept its password on the account row';
  end if;
  update public.app_users set password_hash = 'scrypt$22$33', password_history = array['scrypt$00$11'] where id = v;
  if (select password_hash from public.app_users where id = v) is not null then
    raise exception 'FAIL: a changed password stayed on the account row';
  end if;
  if (select password_hash from vault.credentials where user_id = v) is distinct from 'scrypt$22$33'
     or not (select password_history from vault.credentials where user_id = v) @> array['scrypt$00$11'] then
    raise exception 'FAIL: a new password and its history did not reach the vault';
  end if;
  delete from public.app_users where id = v;
end $$;
do $$ begin raise notice 'pass: a password is kept in the vault only; the account row holds no copy'; end $$;

-- =====================================================================
-- 14. Notices are posted by leadership
-- =====================================================================
do $$
declare v uuid;
begin
  set local role app_api;
  perform pg_temp.as_emp('EMP-2847');   -- an analyst
  if public.may_post_notice() then raise exception 'FAIL: an analyst may post notices'; end if;
  begin
    insert into public.notices (title, content, category, status, created_by)
    values ('Analyst notice', 'x', 'General', 'pending', 'EMP-2847');
    raise exception 'FAIL: an analyst posted a notice';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  perform pg_temp.as_emp('EMP-1134');   -- head of Operations
  if not public.may_post_notice() then raise exception 'FAIL: a department head may not post notices'; end if;
  insert into public.notices (title, content, category, status, created_by)
  values ('Head notice', 'x', 'General', 'pending', 'EMP-1134') returning id into v;
  perform pg_temp.as_emp('EMP-0661');   -- HR, not a head: posting notices is HR's job
  if not public.may_post_notice() then raise exception 'FAIL: somebody in HR may not post notices'; end if;
  perform pg_temp.as_emp('EMP-0445');   -- system administrator
  if not public.may_post_notice() then raise exception 'FAIL: an administrator may not post notices'; end if;
end $$;
do $$ begin raise notice 'pass: notices are posted by HR, department heads, CXOs and administrators, not by everybody'; end $$;

-- Tidy: the evaluation goes, and everything it held with it.
-- Removing an organisation is platform staff's to do (row security on tenants).
select set_config('app.is_staff', 'true', false);
delete from public.tenants where id = current_setting('t.tpl')::uuid;
select set_config('app.is_staff', 'false', false);

do $$ begin raise notice 'ALL SOW GAP TESTS PASSED'; end $$;
