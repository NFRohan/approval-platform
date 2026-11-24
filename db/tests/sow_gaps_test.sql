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
       where t.tenant_id = current_setting('t.tpl')::uuid and t.name = 'Employee Exit Clearance') <> 6 then
    raise exception 'FAIL: the exit clearance does not carry a checklist for each of its six tracks';
  end if;
  if exists (select 1 from public.approval_rules where tenant_id = current_setting('t.tpl')::uuid
              and (label = 'business_finance' or label like 'answer:Business finance%') and remind_hours is distinct from 12) then
    raise exception 'FAIL: a Business Finance review does not remind every 12 hours';
  end if;
  raise notice 'pass: SIM requisition and transfer, fraud transfer, compensatory and night allowance are published and route; exit clearance has six checklists; Business Finance reminds every 12 hours';
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
  if (select count(*) from public.approval_events where subject_id = v_sub and action = 'checklist_ticked') <> 4 then
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
  perform public.save_checklist(v_form, 'Supply Chain', array['Assets on the inventory list returned', 'Toolkit returned']);
  if (select string_agg(item, '|' order by position) from public.checklist_items where form_template_id = v_form and track = 'Supply Chain' and active)
     <> 'Assets on the inventory list returned|Toolkit returned'
     or not exists (select 1 from public.checklist_items where form_template_id = v_form and track = 'Supply Chain'
                     and item = 'Open purchase orders handed over' and not active) then
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

-- Tidy: the evaluation goes, and everything it held with it.
delete from public.tenants where id = current_setting('t.tpl')::uuid;

do $$ begin raise notice 'ALL SOW GAP TESTS PASSED'; end $$;
