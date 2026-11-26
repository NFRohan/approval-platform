-- =====================================================================
-- Tickets suite — what a request carries besides its route.
--
-- Reference numbers, priority, the exceptional flag, signatures, notes,
-- people copied, links, copying, a department hearing that another has
-- cleared, and handing a leaver's work over.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

delete from public.tenants where slug in ('tick-t', 'tick-u');

insert into public.tenants (name, slug, kind, expires_at) values
  ('Ticket Tenant', 'tick-t', 'demo', now() + interval '1 day'),
  ('Other Tenant',  'tick-u', 'demo', now() + interval '1 day');
select set_config('t.k', (select id::text from public.tenants where slug = 'tick-t'), false);
select set_config('t.u', (select id::text from public.tenants where slug = 'tick-u'), false);

insert into public.app_users (tenant_id, username, password_hash, full_name)
values (current_setting('t.k')::uuid, 'k.eval', 'x', 'K Evaluator');
select set_config('u.k', (select id::text from public.app_users where username = 'k.eval'), false);

insert into public.employees (tenant_id, employee_id, name) values
  (current_setting('t.k')::uuid, 'MG', 'Manager'),
  (current_setting('t.k')::uuid, 'FI', 'Finance'),
  (current_setting('t.k')::uuid, 'IT', 'Technology'),
  (current_setting('t.k')::uuid, 'HR', 'HR'),
  (current_setting('t.k')::uuid, 'CC1', 'Copied One'),
  (current_setting('t.k')::uuid, 'NEW', 'Successor'),
  (current_setting('t.k')::uuid, 'OUT', 'Outsider');
insert into public.employees (tenant_id, employee_id, name, line_manager_id) values
  (current_setting('t.k')::uuid, 'RQ', 'Requester', 'MG'),
  (current_setting('t.k')::uuid, 'R2', 'Reports to MG', 'MG');
insert into public.departments (tenant_id, name, head_employee_id) values
  (current_setting('t.k')::uuid, 'Ops', 'MG');

insert into public.form_templates (id, tenant_id, name, status) values
  ('c0000000-0000-4000-8000-000000000001', current_setting('t.k')::uuid, 'Plain', 'published'),
  ('c0000000-0000-4000-8000-000000000002', current_setting('t.k')::uuid, 'Clearance', 'published'),
  ('c0000000-0000-4000-8000-000000000003', current_setting('t.k')::uuid, 'Campaign', 'published');
insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, order_index) values
  (current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000003', 'select', 'Route', 0);

-- Plain: the line manager, then finance, which needs a signature.
insert into public.approval_rules (tenant_id, form_template_id, approver_user_id, label, step_index, deadline_days, require_signature) values
  (current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000001', 'MG', 'line_manager', 0, 4, false),
  (current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000001', 'FI', 'finance',      1, 4, true);
-- Clearance: Finance and IT at once, then HR.
insert into public.approval_rules (tenant_id, form_template_id, approver_user_id, label, step_index, position, lane) values
  (current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000002', 'FI', 'finance', 0, 0, 'Finance'),
  (current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000002', 'IT', 'it',      0, 1, 'Technology'),
  (current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000002', 'HR', 'hr',      1, 0, null);
-- Campaign: the exceptional route goes to MG first and says so.
insert into public.approval_rules (tenant_id, form_template_id, approver_user_id, label, step_index, condition, flag) values
  (current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000003', 'MG', 'cxo_exception', 0,
   '{"field": "Route", "op": "eq", "value": "Exceptional"}', 'Exceptional'),
  (current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000003', 'FI', 'finance', 1, null, null);

-- One request in the other tenant, so numbering can be seen to be per tenant.
insert into public.form_templates (id, tenant_id, name, status) values
  ('c0000000-0000-4000-8000-0000000000ff', current_setting('t.u')::uuid, 'Other', 'published');
insert into public.employees (tenant_id, employee_id, name) values (current_setting('t.u')::uuid, 'RQ', 'Elsewhere');
insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status)
values (current_setting('t.u')::uuid, 'c0000000-0000-4000-8000-0000000000ff', 'RQ', 'submitted');

insert into public.form_submissions (id, tenant_id, form_template_id, submitted_by, status, priority) values
  ('d0000000-0000-4000-8000-000000000001', current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000001', 'RQ', 'submitted', 'normal'),
  ('d0000000-0000-4000-8000-000000000002', current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000001', 'RQ', 'submitted', 'urgent'),
  ('d0000000-0000-4000-8000-000000000003', current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000002', 'RQ', 'submitted', 'normal'),
  ('d0000000-0000-4000-8000-000000000004', current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000003', 'RQ', 'submitted', 'normal'),
  ('d0000000-0000-4000-8000-000000000005', current_setting('t.k')::uuid, 'c0000000-0000-4000-8000-000000000001', 'RQ', 'submitted', 'high');
insert into public.submission_values (tenant_id, submission_id, field_name, value) values
  (current_setting('t.k')::uuid, 'd0000000-0000-4000-8000-000000000004', 'Route', 'Exceptional'),
  (current_setting('t.k')::uuid, 'd0000000-0000-4000-8000-000000000005', 'Purpose', 'Kept on copy');
insert into public.attachments (tenant_id, submission_id, field_name, file_name, size_bytes, data, version, superseded_at) values
  (current_setting('t.k')::uuid, 'd0000000-0000-4000-8000-000000000005', 'Receipt', 'old.pdf', 3, '\x616263', 1, now()),
  (current_setting('t.k')::uuid, 'd0000000-0000-4000-8000-000000000005', 'Receipt', 'new.pdf', 3, '\x646566', 2, null);

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % — got %, want %', label, got, want;
  end if;
  raise notice 'pass: %', label;
end $$;

create or replace function pg_temp.ctx() returns void language plpgsql as $$
begin
  perform set_config('app.tenant_id', current_setting('t.k'), true),
          set_config('app.user_id',   current_setting('u.k'), true),
          set_config('app.role',      'admin', true),
          set_config('app.is_staff',  'false', true);
end $$;

create or replace function pg_temp.step(p_sub uuid, p_who text) returns uuid language sql as $$
  select id from public.approval_requests where submission_id = p_sub and approver_user_id = p_who
   order by step_index, lane, lane_step limit 1
$$;

-- =====================================================================
-- 1. Reference numbers
-- =====================================================================
begin;
  set local role app_api;
  select pg_temp.ctx();

  select pg_temp.check('every request has a reference shaped AMS-YYYY-NNNNN',
    (select count(*)::int from public.form_submissions
      where tenant_id = current_setting('t.k')::uuid and ref_number !~ '^AMS-[0-9]{4}-[0-9]{5}$'), 0);
  select pg_temp.check('...numbered in the order they were raised, from one',
    (select string_agg(right(ref_number, 5), ',' order by ref_number) from public.form_submissions
      where tenant_id = current_setting('t.k')::uuid),
    '00001,00002,00003,00004,00005'::text);
commit;

-- The other tenant counts its own, from one.
select pg_temp.check('each tenant counts its own',
  (select right(ref_number, 5) from public.form_submissions where tenant_id = current_setting('t.u')::uuid),
  '00001'::text);

-- =====================================================================
-- 2. Priority shortens every deadline; the flag marks the request
-- =====================================================================
do $$
declare v_normal timestamptz; v_urgent timestamptz;
begin
  set local role app_api;
  perform pg_temp.ctx();
  perform public.build_approval_chain('form_submission', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001');
  perform public.build_approval_chain('form_submission', 'd0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001');
  select deadline_at into v_normal from public.approval_requests where id = pg_temp.step('d0000000-0000-4000-8000-000000000001', 'MG');
  select deadline_at into v_urgent from public.approval_requests where id = pg_temp.step('d0000000-0000-4000-8000-000000000002', 'MG');
  if v_urgent >= v_normal then
    raise exception 'FAIL: an urgent request is due % — no sooner than a normal one, %', v_urgent, v_normal;
  end if;

  perform public.build_approval_chain('form_submission', 'd0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000003');
  if (select flag from public.form_submissions where id = 'd0000000-0000-4000-8000-000000000004') <> 'Exceptional' then
    raise exception 'FAIL: the exceptional route did not flag the request';
  end if;
  if not exists (select 1 from public.notifications
                  where recipient_id = 'MG' and entity_id = 'd0000000-0000-4000-8000-000000000004'
                    and body like '[Exceptional]%') then
    raise exception 'FAIL: the approver was not told it is exceptional';
  end if;
  reset role;
  raise notice 'pass: an urgent request is due sooner at every step';
  raise notice 'pass: the exceptional route marks the request, and the approver is told so';
end $$;

-- =====================================================================
-- 3. A step that needs a signature
-- =====================================================================
do $$
declare v_id uuid; refused boolean := false;
begin
  set local role app_api;
  perform pg_temp.ctx();
  perform public.act_on_approval(pg_temp.step('d0000000-0000-4000-8000-000000000001', 'MG'), 'approve', null, 'MG');
  v_id := pg_temp.step('d0000000-0000-4000-8000-000000000001', 'FI');

  begin
    perform public.act_on_approval(v_id, 'approve', null, 'FI');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: a step that needs a signature was approved without one'; end if;

  refused := false;
  begin
    perform public.act_on_approval(v_id, 'approve', null, 'FI', 'not a picture');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: something that is not a signature was accepted'; end if;

  perform public.act_on_approval(v_id, 'approve', null, 'FI', 'data:image/png;base64,iVBORw0KGgo=');
  if (select signature from public.approval_requests where id = v_id) <> 'data:image/png;base64,iVBORw0KGgo='
     or (select signed_at from public.approval_requests where id = v_id) is null then
    raise exception 'FAIL: the signature was not kept with the step';
  end if;
  reset role;
  raise notice 'pass: a step that needs a signature takes one, and keeps it';
end $$;

-- =====================================================================
-- 4. One department clearing tells the others
-- =====================================================================
do $$
begin
  set local role app_api;
  perform pg_temp.ctx();
  perform public.build_approval_chain('form_submission', 'd0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000002');
  perform public.act_on_approval(pg_temp.step('d0000000-0000-4000-8000-000000000003', 'FI'), 'approve', null, 'FI');
  if not exists (select 1 from public.notifications
                  where recipient_id = 'IT' and kind = 'phase.lane_cleared'
                    and entity_id = 'd0000000-0000-4000-8000-000000000003') then
    raise exception 'FAIL: Technology was not told Finance had cleared it';
  end if;
  reset role;
  raise notice 'pass: when one department clears, the others in the phase are told';
end $$;

-- =====================================================================
-- 5. Notes
-- =====================================================================
do $$
declare s uuid := 'd0000000-0000-4000-8000-000000000003'; refused boolean := false; n int;
begin
  set local role app_api;
  perform pg_temp.ctx();

  begin perform public.add_note(s, 'I have opinions', 'OUT');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: somebody off the request added a note'; end if;

  perform public.add_note(s, 'Asset register checked', 'IT');
  if (select count(*) from public.notifications where kind = 'note.added' and entity_id = s
        and recipient_id in ('RQ', 'FI', 'HR')) <> 3 then
    raise exception 'FAIL: the requester and every approver were not all told about the note';
  end if;

  update public.ticket_notes set body = 'rewritten';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a note was rewritten'; end if;
  reset role;
  raise notice 'pass: anybody on a request can add a note, everybody else on it hears, and notes cannot be rewritten';
end $$;

-- =====================================================================
-- 6. People copied
-- =====================================================================
do $$
declare s uuid := 'd0000000-0000-4000-8000-000000000005'; refused boolean := false;
begin
  set local role app_api;
  perform pg_temp.ctx();

  begin perform public.set_cc(s, array['CC1'], 'MG');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: somebody other than the requester changed who is copied'; end if;

  perform public.set_cc(s, array['CC1'], 'RQ');
  perform public.build_approval_chain('form_submission', s, 'c0000000-0000-4000-8000-000000000001');
  if not exists (select 1 from public.notifications where recipient_id = 'CC1' and entity_id = s and kind in ('cc.added', 'cc.raised')) then
    raise exception 'FAIL: the person copied was not told';
  end if;

  perform public.act_on_approval(pg_temp.step(s, 'MG'), 'approve', null, 'MG');
  perform public.act_on_approval(pg_temp.step(s, 'FI'), 'approve', null, 'FI', 'data:image/png;base64,iVBORw0KGgo=');
  if not exists (select 1 from public.notifications where recipient_id = 'CC1' and entity_id = s and kind = 'cc.completed') then
    raise exception 'FAIL: the person copied was not told it finished';
  end if;

  perform public.set_cc(s, array[]::text[], 'RQ');
  if exists (select 1 from public.submission_cc where submission_id = s) then
    raise exception 'FAIL: an emptied CC list still copies somebody';
  end if;
  reset role;
  raise notice 'pass: only the requester sets the CC list, and those copied hear when it is raised and when it finishes';
end $$;

-- =====================================================================
-- 7. Links and copies
-- =====================================================================
do $$
declare v_new uuid; refused boolean := false; v_ref text;
begin
  set local role app_api;
  perform pg_temp.ctx();

  select ref_number into v_ref from public.form_submissions where id = 'd0000000-0000-4000-8000-000000000002';
  perform public.link_submissions('d0000000-0000-4000-8000-000000000001', lower(v_ref), 'Same trip', 'RQ');
  begin perform public.link_submissions('d0000000-0000-4000-8000-000000000002',
          (select ref_number from public.form_submissions where id = 'd0000000-0000-4000-8000-000000000001'), null, 'RQ');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: the same pair was linked twice, the other way round'; end if;

  refused := false;
  begin perform public.link_submissions('d0000000-0000-4000-8000-000000000001', v_ref, null, 'OUT');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: somebody off the request linked it'; end if;

  perform public.unlink_submissions('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'RQ');
  if exists (select 1 from public.submission_links) then raise exception 'FAIL: unlinking left the link'; end if;

  v_new := public.copy_submission('d0000000-0000-4000-8000-000000000005', 'R2');
  if (select status || '/' || submitted_by || '/' || priority from public.form_submissions where id = v_new) <> 'draft/R2/high' then
    raise exception 'FAIL: the copy is not a draft of the copier''s with the same priority';
  end if;
  if (select value from public.submission_values where submission_id = v_new and field_name = 'Purpose') <> 'Kept on copy' then
    raise exception 'FAIL: the answers were not copied';
  end if;
  if (select string_agg(file_name, ',') from public.attachments where submission_id = v_new) <> 'new.pdf' then
    raise exception 'FAIL: the copy should carry only the current version of each document';
  end if;
  if not exists (select 1 from public.submission_links where from_id = v_new and to_id = 'd0000000-0000-4000-8000-000000000005') then
    raise exception 'FAIL: the copy is not linked back to its original';
  end if;

  -- A draft nobody will finish can be thrown away, by whoever started it.
  refused := false;
  begin perform public.delete_draft(v_new, 'RQ');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: somebody else deleted a draft'; end if;
  refused := false;
  begin perform public.delete_draft('d0000000-0000-4000-8000-000000000005', 'RQ');
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: a submitted request was deleted as if it were a draft'; end if;
  perform public.delete_draft(v_new, 'R2');
  if exists (select 1 from public.form_submissions where id = v_new)
     or exists (select 1 from public.submission_values where submission_id = v_new)
     or exists (select 1 from public.attachments where submission_id = v_new)
     or exists (select 1 from public.submission_links where from_id = v_new) then
    raise exception 'FAIL: the deleted draft, or what it carried, is still there';
  end if;
  if not exists (select 1 from public.form_submissions where id = 'd0000000-0000-4000-8000-000000000005') then
    raise exception 'FAIL: deleting the copy took its original with it';
  end if;
  reset role;
  raise notice 'pass: requests link by reference, once, by somebody on them; a copy is a linked draft with the current documents';
  raise notice 'pass: whoever started a draft can delete it, with its answers and documents; nobody else, and nothing already submitted';
end $$;

-- =====================================================================
-- 8. A leaver hands everything over
-- =====================================================================
do $$
declare s uuid := 'd0000000-0000-4000-8000-000000000002';
begin
  set local role app_api;
  perform pg_temp.ctx();

  insert into public.delegation_rules (delegator_id, delegate_id, start_date, end_date)
  values ('MG', 'FI', current_date, current_date + 3);

  perform public.hand_over('MG', 'NEW', 'HR');

  if (select approver_user_id || '/' || reassigned_from from public.approval_requests where id = pg_temp.step(s, 'NEW')) <> 'NEW/MG' then
    raise exception 'FAIL: the open step did not move to the successor with the trail kept';
  end if;
  if exists (select 1 from public.approval_rules where approver_user_id = 'MG') then
    raise exception 'FAIL: a rule still names the leaver';
  end if;
  if (select head_employee_id from public.departments where name = 'Ops') <> 'NEW' then
    raise exception 'FAIL: the department is still headed by the leaver';
  end if;
  if (select line_manager_id from public.employees where employee_id = 'R2') <> 'NEW' then
    raise exception 'FAIL: the leaver''s reports did not move to the successor';
  end if;
  if (select active from public.employees where employee_id = 'MG') then
    raise exception 'FAIL: the leaver is still active';
  end if;
  if exists (select 1 from public.delegation_rules where delegator_id = 'MG') then
    raise exception 'FAIL: the leaver''s delegation outlived them';
  end if;
  reset role;
  raise notice 'pass: a leaver''s open steps, rules, department roles and reports all pass to the successor';
end $$;

delete from public.tenants where slug in ('tick-t', 'tick-u');

do $$ begin raise notice 'ALL TICKET TESTS PASSED'; end $$;
