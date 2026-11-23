-- =====================================================================
-- Integration, audit and retention.
--
-- On a fresh evaluation, as its people: the API keys, webhooks and
-- their history it is issued with, and never shares; who may make and
-- revoke keys, and that a revoked key stops at once; webhooks queued
-- from what happens to a request, and only for what they listen for;
-- the audit trail over every source, filtered and summarised, and who
-- may read it; retention archiving and purging by the policy, and the
-- records it keeps; and closed ManageEngine tickets migrated in once.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

-- On a copy of the template, deleted at the end.
select set_config('app.is_staff', 'true', false);
select set_config('t.tpl', (select tenant_id::text from app.provision_demo(
  'Integration Test', 'integration.test.' || substr(md5(random()::text), 1, 8), 'hash', interval '1 day')), false);
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

-- =====================================================================
-- 1. What a new evaluation is issued with
-- =====================================================================
do $$
declare v_t uuid := current_setting('t.tpl')::uuid; v record;
begin
  select count(*) n, count(*) filter (where revoked_at is not null) revoked into v from public.api_keys where tenant_id = v_t;
  if v.n <> 3 or v.revoked <> 1 then raise exception 'FAIL: the evaluation''s keys are not the ERP''s, Tableau''s and a revoked one: %', row_to_json(v); end if;
  if exists (select 1 from public.api_keys a join public.api_keys b on a.prefix = b.prefix and a.tenant_id <> b.tenant_id) then
    raise exception 'FAIL: two organisations share a key';
  end if;
  if (select count(*) from public.api_requests where tenant_id = v_t) < 300 then raise exception 'FAIL: no API history to show'; end if;
  if (select count(*) from public.api_requests where tenant_id = v_t and status = 401) < 1 then raise exception 'FAIL: the revoked key was never refused'; end if;
  if (select count(*) from public.webhook_deliveries where tenant_id = v_t and status = 'delivered') < 5 then raise exception 'FAIL: the webhook has no deliveries'; end if;
  if (select count(*) from public.system_runs where tenant_id = v_t and job = 'daily_round') < 50 then raise exception 'FAIL: the scheduler has no history'; end if;
  select count(*) n, count(*) filter (where archived_at is not null) archived, count(*) filter (where ref_number like 'ME-SR-%') refs
    into v from public.form_submissions where tenant_id = v_t and legacy_ref is not null;
  if v.n <> 48 or v.archived <> 48 or v.refs <> 48 then raise exception 'FAIL: the ManageEngine archive was not cloned: %', row_to_json(v); end if;
  if (select count(*) from public.activity_log where tenant_id = v_t and action = 'sign_in_failed') < 5 then raise exception 'FAIL: no failed sign-ins to monitor'; end if;
  raise notice 'pass: an evaluation has keys of its own (one revoked), sixty days of calls, deliveries, runs, sign-ins and 48 migrated tickets';
end $$;

-- =====================================================================
-- 2. Keys: who may make one, and a revoked one stops at once
-- =====================================================================
begin;
  set local role app_api;
do $$
declare v_id uuid; v_old uuid;
begin
  perform pg_temp.as_emp('EMP-2847');   -- Tom: no integrations.manage
  if not pg_temp.refused($q$select public.create_api_key('Rogue', array['requests:read'], 'abcdefgh', repeat('a', 64))$q$) then
    raise exception 'FAIL: somebody without integrations.manage made a key';
  end if;
  if exists (select 1 from public.api_keys) then
    raise exception 'FAIL: somebody without integrations.manage or audit.view can read the keys';
  end if;

  perform pg_temp.as_emp('EMP-0445');   -- Farah: System administrator
  if not pg_temp.refused($q$select public.create_api_key('Bad', array['everything'], 'abcdefgh', repeat('a', 64))$q$) then
    raise exception 'FAIL: a key was given a scope that does not exist';
  end if;
  v_id := public.create_api_key('Oracle EBS', array['requests:read', 'approvals:write'], substr(md5(random()::text), 1, 8), repeat('b', 64));
  if (select scopes from public.api_keys where id = v_id) <> array['approvals:write', 'requests:read'] then
    raise exception 'FAIL: the key does not hold the scopes it was given';
  end if;
  if not exists (select 1 from public.activity_log where action = 'api_key_created' and entity_id = v_id) then
    raise exception 'FAIL: making a key was not recorded';
  end if;

  -- The key as a session: live until it is revoked, then refused.
  perform set_config('app.user_id', v_id::text, true), set_config('app.api_key', v_id::text, true), set_config('app.employee_id', '', true);
  perform app.assert_account_live();
  perform pg_temp.as_emp('EMP-0445');
  perform public.revoke_api_key(v_id);
  perform set_config('app.user_id', v_id::text, true), set_config('app.api_key', v_id::text, true), set_config('app.employee_id', '', true);
  if not pg_temp.refused('select app.assert_account_live()') then
    raise exception 'FAIL: a revoked key still opens a session';
  end if;
  -- And a key cannot pass for somebody else's account, or another key.
  perform set_config('app.api_key', gen_random_uuid()::text, true);
  if not pg_temp.refused('select app.assert_account_live()') then
    raise exception 'FAIL: a session claiming a key that is not its own was let in';
  end if;
  perform pg_temp.as_emp('EMP-0445');
  if not pg_temp.refused(format('select public.revoke_api_key(%L)', v_id)) then
    raise exception 'FAIL: a key was revoked twice';
  end if;
end $$;
  reset role;
commit;
do $$ begin raise notice 'pass: keys need integrations.manage and real scopes; a revoked key stops at its next statement'; end $$;

-- =====================================================================
-- 3. Webhooks hear what they listen for
-- =====================================================================
begin;
  set local role app_api;
do $$
declare v_hook uuid; v_other uuid; v_sub uuid; v_tpl uuid; v_step uuid; v_before int; v record;
begin
  perform pg_temp.as_emp('EMP-0445');
  if not pg_temp.refused($q$select public.save_webhook(null, 'Bad', 'ftp://x', array['request.completed'], true, repeat('s', 30))$q$) then
    raise exception 'FAIL: a webhook was accepted with an address that is not http';
  end if;
  if not pg_temp.refused($q$select public.save_webhook(null, 'Bad', 'https://x.test', array['request.exploded'], true, repeat('s', 30))$q$) then
    raise exception 'FAIL: a webhook was accepted for an event that does not exist';
  end if;
  v_hook := public.save_webhook(null, 'ERP approvals', 'https://erp.example.test/hooks', array['request.submitted', 'approval.approved'], true, repeat('s', 32));
  v_other := public.save_webhook(null, 'Paused', 'https://other.example.test/hooks', array['*'], false, repeat('t', 32));

  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused(format('select public.test_webhook(%L)', v_hook)) then
    raise exception 'FAIL: somebody without integrations.manage sent a test';
  end if;

  -- Tom raises a travel claim; Sam, his manager, approves the first step.
  select id into v_tpl from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Travel & Expense Reimbursement';
  insert into public.form_submissions (form_template_id, submitted_by, status) values (v_tpl, 'EMP-2847', 'submitted') returning id into v_sub;
  insert into public.submission_values (submission_id, field_name, value) values
    (v_sub, 'Purpose of travel', 'Client visit'), (v_sub, 'Travel date', '2026-12-01'), (v_sub, 'Amount claimed', '42000');
  perform public.build_approval_chain('form_submission', v_sub, v_tpl);
  select id into v_step from public.approval_requests where submission_id = v_sub and status = 'pending' order by step_index limit 1;
  perform pg_temp.as_emp((select approver_user_id from public.approval_requests where id = v_step));
  perform public.act_on_approval(v_step, 'approve', 'Fine', null);
  reset role;

  select count(*) filter (where event = 'request.submitted') submitted, count(*) filter (where event = 'approval.approved') approved,
         count(*) filter (where webhook_id = v_other) paused, count(*) filter (where event not in ('request.submitted', 'approval.approved')) other
    into v from public.webhook_deliveries where webhook_id in (v_hook, v_other) and status = 'queued';
  if v.submitted <> 1 or v.approved <> 1 or v.paused <> 0 or v.other <> 0 then
    raise exception 'FAIL: the webhooks did not hear exactly what they listen for: %', row_to_json(v);
  end if;
  select payload into v from public.webhook_deliveries where webhook_id = v_hook and event = 'approval.approved';
  if (v.payload #>> '{data,request,reference}') is distinct from (select ref_number from public.form_submissions where id = v_sub)
     or (v.payload #>> '{data,request,answers,Amount claimed}') <> '42000'
     or (v.payload #>> '{data,approval,step}') <> '1' then
    raise exception 'FAIL: the delivery does not carry the request, its answers and the step: %', v.payload;
  end if;

  -- Seeding and cloning tell nobody.
  select count(*) into v_before from public.webhook_deliveries where webhook_id = v_hook;
  perform set_config('app.no_mail', 'true', true);
  perform app.emit_webhook(current_setting('t.tpl')::uuid, 'request.submitted', '{}'::jsonb);
  perform set_config('app.no_mail', 'false', true);
  if (select count(*) from public.webhook_deliveries where webhook_id = v_hook) <> v_before then
    raise exception 'FAIL: a webhook was queued while seeding';
  end if;
end $$;
commit;
do $$ begin raise notice 'pass: a webhook is queued for what it listens for, with the request, its answers and the step; paused ones and seeding hear nothing'; end $$;

-- =====================================================================
-- 4. The audit trail
-- =====================================================================
begin;
  set local role app_api;
do $$
declare v record; v_s jsonb; v_n int;
begin
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused('select * from public.audit_events(null, null, null, null, null, 10)') then
    raise exception 'FAIL: somebody without audit.view read the trail';
  end if;

  perform pg_temp.as_emp('EMP-0445');
  select count(distinct category) cats, count(distinct source) sources into v
    from public.audit_events(now() - interval '60 days', now(), null, null, null, 20000);
  if v.cats < 3 or v.sources < 6 then raise exception 'FAIL: the trail does not cover every source: %', row_to_json(v); end if;

  if exists (select 1 from public.audit_events(now() - interval '60 days', now(), array['database'], null, null, 500) where category <> 'database') then
    raise exception 'FAIL: the category filter let other categories through';
  end if;
  if exists (select 1 from public.audit_events(now() - interval '60 days', now(), null, 'warning', null, 500) where severity = 'info') then
    raise exception 'FAIL: the severity filter let information through';
  end if;
  select count(*) into v_n from public.audit_events(now() - interval '60 days', now(), null, null, 'raj locked', 500);
  if v_n < 1 then raise exception 'FAIL: searching the trail did not find the locked account'; end if;
  select count(*) into v_n from public.audit_events(now() - interval '60 days', now(), null, null, '%', 500);
  if v_n <> 0 then raise exception 'FAIL: a %% in the search matched everything'; end if;

  v_s := public.audit_summary(30);
  if jsonb_array_length(v_s->'daily') <> 30 or (v_s->>'total')::int < 100
     or (select sum((d->>'failed_sign_ins')::int) from jsonb_array_elements(v_s->'security') d) < 1
     or jsonb_array_length(v_s->'top_actors') < 3 or jsonb_array_length(v_s->'by_hour') <> 24
     or (v_s #>> '{after_hours,after}')::int < 1 then
    raise exception 'FAIL: the monitoring summary is missing what the charts draw: %', left(v_s::text, 400);
  end if;
end $$;
  reset role;
commit;
do $$ begin raise notice 'pass: one trail over every source, filtered by category, severity and search, summarised for monitoring, for audit.view only'; end $$;

-- =====================================================================
-- 5. Retention
-- =====================================================================
begin;
  set local role app_api;
do $$
declare v_t uuid := current_setting('t.tpl')::uuid; v_old uuid; v_new uuid; v jsonb; v_tpl uuid;
begin
  perform pg_temp.as_emp('EMP-0445');
  if not pg_temp.refused('select public.set_retention(5, 12, 120)') then
    raise exception 'FAIL: logs were allowed to outlive the records they describe';
  end if;
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused('select public.run_retention_now()') then
    raise exception 'FAIL: somebody without records.manage ran retention';
  end if;
  reset role;

  -- A claim settled two years ago, one settled last week; an email and
  -- an API call from eleven years ago, and one from yesterday.
  select id into v_tpl from public.form_templates where tenant_id = v_t and name = 'Leave Application';
  insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
  values (v_t, v_tpl, 'EMP-2847', 'completed', now() - interval '2 years') returning id into v_old;
  insert into public.approval_events (tenant_id, subject_type, subject_id, action, created_at)
  values (v_t, 'form_submission', v_old, 'completed', now() - interval '2 years');
  insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
  values (v_t, v_tpl, 'EMP-2847', 'completed', now() - interval '8 days') returning id into v_new;
  insert into public.api_requests (tenant_id, method, path, status, created_at) values
    (v_t, 'GET', '/api/v1/old', 200, now() - interval '11 years'), (v_t, 'GET', '/api/v1/new', 200, now() - interval '1 day');

  set local role app_api;
  perform pg_temp.as_emp('EMP-0445');
  v := public.retention_preview();
  if (v->>'archive')::int < 1 or (v #>> '{logs,api}')::int < 1 or (v->>'past_retention')::int < 1 then
    raise exception 'FAIL: the preview does not show what is due: %', v;
  end if;
  v := public.run_retention_now();
  reset role;
  if (select archived_at from public.form_submissions where id = v_old) is null then raise exception 'FAIL: a claim settled two years ago was not archived'; end if;
  if (select archived_at from public.form_submissions where id = v_new) is not null then raise exception 'FAIL: last week''s claim was archived'; end if;
  if exists (select 1 from public.api_requests where tenant_id = v_t and path = '/api/v1/old') then raise exception 'FAIL: an eleven-year-old log was not purged'; end if;
  if not exists (select 1 from public.api_requests where tenant_id = v_t and path = '/api/v1/new') then raise exception 'FAIL: yesterday''s log was purged'; end if;
  if (select count(*) from public.form_submissions where tenant_id = v_t and legacy_ref is not null) <> 48 then
    raise exception 'FAIL: retention deleted records — it may only archive them';
  end if;
  if not exists (select 1 from public.activity_log where tenant_id = v_t and action = 'records_archived')
     or not exists (select 1 from public.system_runs where tenant_id = v_t and job = 'retention_run') then
    raise exception 'FAIL: the run was not recorded';
  end if;

  -- Brought back, by somebody who may; a migrated ticket cannot be.
  set local role app_api;
  perform pg_temp.as_emp('EMP-0445');
  perform public.unarchive_submission(v_old);
  if not pg_temp.refused(format('select public.unarchive_submission(%L)',
       (select id from public.form_submissions where tenant_id = v_t and legacy_ref is not null limit 1))) then
    raise exception 'FAIL: a migrated ticket was brought into the working lists';
  end if;
  reset role;
  if (select archived_at from public.form_submissions where id = v_old) is not null then raise exception 'FAIL: the record did not come back'; end if;
end $$;
commit;
do $$ begin raise notice 'pass: retention archives what is settled past its age, purges old logs, keeps every record, and is recorded'; end $$;

-- =====================================================================
-- 6. Migration from ManageEngine
-- =====================================================================
begin;
  set local role app_api;
do $$
declare v jsonb; v_t uuid := current_setting('t.tpl')::uuid; v_sub record;
begin
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused($q$select public.import_legacy_tickets('ManageEngine', '[]'::jsonb)$q$) then
    raise exception 'FAIL: somebody without records.manage migrated records';
  end if;

  perform pg_temp.as_emp('EMP-0445');
  v := public.import_legacy_tickets('ManageEngine', jsonb_build_array(
    jsonb_build_object('ref', 'T-1', 'subject', 'Laptop', 'requester', 'tom.bexley@nowhere.test', 'status', 'Closed',
                       'created', '2019-03-12T04:15:00Z', 'closed', '2019-03-13T09:00:00Z', 'technician', 'Rafiq', 'resolution', 'Replaced'),
    jsonb_build_object('ref', 'T-2', 'subject', 'VPN', 'requester', 'EMP-1134', 'status', 'Open', 'created', '2024-01-01T00:00:00Z'),
    jsonb_build_object('ref', 'T-3', 'subject', '', 'status', 'Closed', 'created', '2024-01-01T00:00:00Z'),
    jsonb_build_object('ref', 'T-4', 'subject', 'Mailbox', 'requester', 'Sam Lindqvist', 'status', 'Resolved', 'created', 'not a date'),
    jsonb_build_object('ref', 'T-5', 'subject', 'Printer', 'requester', 'Sam Lindqvist', 'status', 'Cancelled', 'priority', 'High',
                       'created', '2020-06-01T05:00:00Z')));
  if (v->>'imported')::int <> 2 or (v->>'open')::int <> 1 or (v->>'invalid')::int <> 2 or (v->>'unmatched_requesters')::int <> 1 then
    raise exception 'FAIL: the import did not sort the tickets: %', v;
  end if;
  v := public.import_legacy_tickets('ManageEngine', jsonb_build_array(
    jsonb_build_object('ref', 'T-1', 'subject', 'Laptop', 'status', 'Closed', 'created', '2019-03-12T04:15:00Z')));
  if (v->>'imported')::int <> 0 or (v->>'duplicates')::int <> 1 then raise exception 'FAIL: the same ticket was imported twice: %', v; end if;

  select s.*, (select value from public.submission_values x where x.submission_id = s.id and x.field_name = 'Resolution') resolution
    into v_sub from public.form_submissions s where s.tenant_id = v_t and legacy_ref = 'T-5';
  if v_sub.status <> 'cancelled' or v_sub.submitted_by <> 'EMP-1134' or v_sub.priority <> 'high' or v_sub.archived_at is null
     or v_sub.ref_number <> 'ME-T-5' then
    raise exception 'FAIL: the migrated ticket is not what it was: %', row_to_json(v_sub);
  end if;
  if (select status from public.form_templates where id = v_sub.form_template_id) <> 'archived' then
    raise exception 'FAIL: the archive''s form is offered for new requests';
  end if;
  if (select count(*) from public.approval_events where subject_id = v_sub.id and action in ('raised_in_legacy', 'closed_in_legacy', 'migrated')) <> 3 then
    raise exception 'FAIL: the migrated ticket has no history';
  end if;
  -- A migration is not news: nothing was sent to the ERP.
  if exists (select 1 from public.webhook_deliveries d where d.payload #>> '{data,request,id}' = v_sub.id::text) then
    raise exception 'FAIL: migrating a ticket fired a webhook';
  end if;
end $$;
  reset role;
commit;
do $$ begin raise notice 'pass: settled tickets come in archived, matched to people, once; open and unreadable ones are reported, not imported'; end $$;

delete from public.tenants where id = current_setting('t.tpl')::uuid;

do $$ begin raise notice 'ALL INTEGRATION TESTS PASSED'; end $$;
