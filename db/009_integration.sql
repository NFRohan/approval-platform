-- =====================================================================
-- Integration, audit and retention.
--
-- "Open API for ERP integration", "integration with Tableau", "user,
-- system, application and database logs ... log analysis", and
-- "retention 12 years, archiving yearly, purging at 10 years" — with the
-- tickets settled in ManageEngine brought over as archived records.
--
--   the open API     keys an organisation issues to its other systems,
--                    each with the scopes it may use; every call logged
--   webhooks         what happened, posted to those systems and signed;
--                    every delivery kept with what the other end said
--   the audit trail  one log over everything people, the application,
--                    the scheduler and the database did, by category
--   retention        decided requests archived after a year, logs
--                    purged after ten, records kept for twelve
--   migration        closed ManageEngine tickets as archived records
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- What a key may be allowed, and what a webhook may listen for.
-- ---------------------------------------------------------------------
create or replace function app.api_scopes()
returns text[]
language sql
immutable
as $$
  select array[
    'requests:read',    -- list and read requests, their answers, approvals and history
    'requests:write',   -- raise, submit, note and cancel requests for an employee
    'approvals:write',  -- approve, reject or ask for clarification, as the approver
    'forms:read',       -- the published forms and their fields
    'reports:read',     -- run saved reports, as JSON or CSV
    'campaigns:read',   -- campaigns, their budgets and what has been spent
    'audit:read'        -- the audit trail, as a feed a SIEM can pull
  ]
$$;

create or replace function app.webhook_events()
returns text[]
language sql
immutable
as $$
  select array[
    'request.submitted', 'request.completed', 'request.rejected', 'request.cancelled',
    'request.recalled', 'request.note_added',
    'approval.approved', 'approval.rejected', 'approval.clarification'
  ]
$$;

-- ---------------------------------------------------------------------
-- Policies. Read by whoever administers integrations or reads the audit
-- trail; written only through the functions below. The system's own
-- logs (system_runs, app_errors, schema_migrations) have no policy at
-- all: they are read through audit_events(), which checks who is asking.
-- ---------------------------------------------------------------------
do $p$
declare t text;
begin
  foreach t in array array['api_keys', 'webhooks', 'webhook_deliveries', 'api_requests'] loop
    execute format('drop policy if exists %1$s_read on public.%1$I', t);
    execute format($f$create policy %1$s_read on public.%1$I for select to app_api
                      using (tenant_id = app.current_tenant() and app.is_member()
                             and (app.has_permission('integrations.manage') or app.has_permission('audit.view')))$f$, t);
  end loop;
end $p$;

-- ---------------------------------------------------------------------
-- A call made with an API key runs as the key: app.user_id is the key's
-- id and app.api_key says so. assert_account_live() (006) checks app_users
-- for a person's session; for a key it checks the key instead, so a key
-- revoked mid-request stops working at its next statement.
-- ---------------------------------------------------------------------
create or replace function app.assert_account_live()
returns void
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare v record;
begin
  if app.current_user_id() is null then return; end if;
  if coalesce(current_setting('app.api_key', true), '') <> '' then
    if not exists (select 1 from public.api_keys k
                    where k.id = app.current_user_id()
                      and k.id::text = current_setting('app.api_key', true)
                      and k.tenant_id = app.current_tenant()
                      and k.revoked_at is null) then
      raise exception 'this API key has been revoked' using errcode = '28000';
    end if;
    return;
  end if;
  select status, approval_state, locked_at into v from public.app_users where id = app.current_user_id();
  if not found or v.status <> 'active' or v.approval_state <> 'approved'
     or (v.locked_at is not null and v.locked_at > now() - interval '30 minutes') then
    raise exception 'this account is no longer signed in' using errcode = '28000';
  end if;
end $$;

create or replace function app.require_permission(p_permission text)
returns void
language plpgsql
stable
as $$
begin
  if not app.has_permission(p_permission) then
    raise exception 'you need the % permission for that', p_permission;
  end if;
end $$;

-- =====================================================================
-- API keys.
--
-- The server makes the key — "ams_<prefix>_<secret>" — and hands this
-- function the prefix and a SHA-256 of the secret. The secret itself is
-- never stored, so it is shown once and cannot be shown again.
-- =====================================================================
create or replace function public.create_api_key(p_name text, p_scopes text[], p_prefix text, p_hash text)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_id uuid; v_bad text;
begin
  perform app.require_permission('integrations.manage');
  if coalesce(trim(p_name), '') = '' then raise exception 'name the key after the system that will use it'; end if;
  if cardinality(coalesce(p_scopes, '{}')) = 0 then raise exception 'a key needs at least one scope'; end if;
  select s into v_bad from unnest(p_scopes) s where s <> all (app.api_scopes()) limit 1;
  if v_bad is not null then raise exception 'there is no scope called %', v_bad; end if;
  if p_prefix !~ '^[a-z0-9]{8}$' or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'malformed key'; end if;

  insert into public.api_keys (tenant_id, name, prefix, secret_hash, scopes, created_by)
  values (app.current_tenant(), trim(p_name), p_prefix, p_hash,
          array(select distinct s from unnest(p_scopes) s order by s), app.current_employee())
  returning id into v_id;
  perform app.audit('api_key_created', 'api_key', v_id, trim(p_name) || ' — ' || array_to_string(p_scopes, ', '));
  return v_id;
end $$;

create or replace function public.revoke_api_key(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_name text;
begin
  perform app.require_permission('integrations.manage');
  update public.api_keys set revoked_at = now(), revoked_by = app.current_employee()
   where id = p_id and tenant_id = app.current_tenant() and revoked_at is null
  returning name into v_name;
  if v_name is null then raise exception 'no such key, or it is already revoked'; end if;
  perform app.audit('api_key_revoked', 'api_key', p_id, v_name);
end $$;

-- =====================================================================
-- Webhooks.
-- =====================================================================
create or replace function public.save_webhook(
  p_id uuid, p_name text, p_url text, p_events text[], p_active boolean, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_id uuid; v_bad text;
begin
  perform app.require_permission('integrations.manage');
  if coalesce(trim(p_name), '') = '' then raise exception 'name the webhook'; end if;
  -- An address on the internet, or a path on this server (the built-in
  -- receiver at /webhooks/echo, for trying it out).
  if coalesce(p_url, '') !~ '^(https?://[^\s/]+[^\s]*|/[^\s]*)$' then
    raise exception 'the address must start with https:// (or http://)';
  end if;
  if cardinality(coalesce(p_events, '{}')) = 0 then raise exception 'choose at least one event'; end if;
  select e into v_bad from unnest(p_events) e where e <> all (app.webhook_events()) and e <> '*' limit 1;
  if v_bad is not null then raise exception 'there is no event called %', v_bad; end if;

  if p_id is null then
    if coalesce(length(p_secret), 0) < 24 then raise exception 'malformed secret'; end if;
    insert into public.webhooks (tenant_id, name, url, events, secret, active, created_by)
    values (app.current_tenant(), trim(p_name), trim(p_url), p_events, p_secret, coalesce(p_active, true), app.current_employee())
    returning id into v_id;
    perform app.audit('webhook_created', 'webhook', v_id, trim(p_name) || ' → ' || trim(p_url));
  else
    update public.webhooks
       set name = trim(p_name), url = trim(p_url), events = p_events, active = coalesce(p_active, active),
           -- A new secret rotates it; none keeps the old one.
           secret = case when coalesce(length(p_secret), 0) >= 24 then p_secret else secret end
     where id = p_id and tenant_id = app.current_tenant()
    returning id into v_id;
    if v_id is null then raise exception 'no such webhook'; end if;
    perform app.audit(case when coalesce(length(p_secret), 0) >= 24 then 'webhook_secret_rotated' else 'webhook_changed' end,
                      'webhook', v_id, trim(p_name) || ' → ' || trim(p_url));
  end if;
  return v_id;
end $$;

create or replace function public.delete_webhook(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_name text;
begin
  perform app.require_permission('integrations.manage');
  delete from public.webhooks where id = p_id and tenant_id = app.current_tenant() returning name into v_name;
  if v_name is null then raise exception 'no such webhook'; end if;
  perform app.audit('webhook_deleted', 'webhook', p_id, v_name);
end $$;

-- What a request looks like to another system: the same shape the API
-- returns for one.
create or replace function app.request_json(p_submission uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select jsonb_build_object(
    'id', s.id, 'reference', s.ref_number, 'form', jsonb_build_object('id', t.id, 'name', t.name, 'category', t.category),
    'status', s.status, 'priority', s.priority, 'flag', s.flag,
    'requester', case when s.submitted_by is null then null
                      else jsonb_build_object('employee_id', s.submitted_by, 'name', e.name, 'department', e.department) end,
    'submitted_at', s.submitted_at, 'archived_at', s.archived_at,
    'legacy', case when s.legacy_ref is null then null
                   else jsonb_build_object('source', s.legacy_source, 'reference', s.legacy_ref, 'closed_at', s.closed_at) end,
    'answers', coalesce((select jsonb_object_agg(v.field_name, v.value) from public.submission_values v
                          where v.submission_id = s.id and v.tenant_id = s.tenant_id and v.field_name is not null), '{}'::jsonb))
    from public.form_submissions s
    join public.form_templates t on t.id = s.form_template_id and t.tenant_id = s.tenant_id
    left join public.employees e on e.employee_id = s.submitted_by and e.tenant_id = s.tenant_id
   where s.id = p_submission
$$;

-- Queue one event for every webhook of the organisation listening for
-- it. Seeding and cloning (app.no_mail) tell nobody, by mail or by hook.
create or replace function app.emit_webhook(p_tenant uuid, p_event text, p_data jsonb)
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_n integer;
begin
  if coalesce(current_setting('app.no_mail', true), '') = 'true' then return 0; end if;
  insert into public.webhook_deliveries (tenant_id, webhook_id, event, payload)
  select w.tenant_id, w.id, p_event,
         jsonb_build_object('event', p_event, 'occurred_at', now(),
                            'organisation', (select slug from public.tenants where id = p_tenant),
                            'data', p_data)
    from public.webhooks w
   where w.tenant_id = p_tenant and w.active
     and (p_event = any (w.events) or '*' = any (w.events));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- What happened to a request is in approval_events already, so that is
-- where webhooks listen.
create or replace function app.webhook_on_event()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_event text; v_data jsonb; v_step record;
begin
  if new.subject_type <> 'form_submission' then return new; end if;
  v_event := case new.action
    when 'submitted' then 'request.submitted' when 'completed' then 'request.completed'
    when 'cancelled' then 'request.cancelled' when 'recalled'  then 'request.recalled'
    when 'note'      then 'request.note_added'
    when 'approved'  then 'approval.approved' when 'rejected'  then 'approval.rejected'
    when 'clarification' then 'approval.clarification' end;
  if v_event is null then return new; end if;
  if not exists (select 1 from public.webhooks w where w.tenant_id = new.tenant_id and w.active) then return new; end if;

  v_data := jsonb_build_object('request', app.request_json(new.subject_id),
                               'actor', new.actor_id, 'comment', new.comment);
  if new.request_id is not null then
    select ar.id, ar.step_index, ar.stage_label, ar.lane_label, ar.approver_user_id, e.name
      into v_step
      from public.approval_requests ar
      left join public.employees e on e.employee_id = ar.approver_user_id and e.tenant_id = ar.tenant_id
     where ar.id = new.request_id;
    if found then
      v_data := v_data || jsonb_build_object('approval', jsonb_build_object(
        'id', v_step.id, 'step', v_step.step_index + 1, 'stage', v_step.stage_label, 'lane', v_step.lane_label,
        'approver', jsonb_build_object('employee_id', v_step.approver_user_id, 'name', v_step.name)));
    end if;
  end if;
  perform app.emit_webhook(new.tenant_id, v_event, v_data);
  return new;
end $$;

drop trigger if exists approval_events_webhook on public.approval_events;
create trigger approval_events_webhook after insert on public.approval_events
  for each row execute function app.webhook_on_event();

-- A rejection ends the request; the step's own event says which step.
create or replace function app.webhook_on_status()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    perform app.emit_webhook(new.tenant_id, 'request.rejected', jsonb_build_object('request', app.request_json(new.id)));
  end if;
  return new;
end $$;

drop trigger if exists form_submissions_webhook on public.form_submissions;
create trigger form_submissions_webhook after update of status on public.form_submissions
  for each row execute function app.webhook_on_status();

-- "Send a test": a ping, through the same queue as everything else.
create or replace function public.test_webhook(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_id uuid;
begin
  perform app.require_permission('integrations.manage');
  insert into public.webhook_deliveries (tenant_id, webhook_id, event, payload)
  select w.tenant_id, w.id, 'ping',
         jsonb_build_object('event', 'ping', 'occurred_at', now(),
                            'organisation', (select slug from public.tenants where id = w.tenant_id),
                            'data', jsonb_build_object('message', 'A test from ' || w.name, 'sent_by', app.current_employee()))
    from public.webhooks w where w.id = p_id and w.tenant_id = app.current_tenant()
  returning id into v_id;
  if v_id is null then raise exception 'no such webhook'; end if;
  return v_id;
end $$;

-- Send one again, now: a failure fixed at the other end, or one waiting
-- for its next try.
create or replace function public.redeliver_webhook(p_delivery uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.require_permission('integrations.manage');
  update public.webhook_deliveries set status = 'queued', error = null, attempts = 0, next_attempt_at = now()
   where id = p_delivery and tenant_id = app.current_tenant() and status in ('failed', 'delivered', 'queued');
  if not found then raise exception 'no such delivery, or it is still on its way'; end if;
end $$;

-- =====================================================================
-- The audit trail: one log over every source, each row in one of four
-- categories, with a severity.
--
--   user         what people did: signing in (and failing to), accounts,
--                roles, settings, decisions on requests, documents read
--   application  what the application did, or did with other systems:
--                email, mail received, API calls, webhooks, errors
--   system       scheduled work: the daily round, directory sync,
--                retention runs
--   database     changes to the structure and to data in bulk: schema
--                applied, HR and coupon imports, migration, archiving
--                and purging
-- =====================================================================
create or replace function app.audit_category(p_action text, p_actor text)
returns text
language sql
immutable
as $$
  select case
    when p_action in ('hr_import', 'coupons_imported', 'legacy_import', 'division_renamed', 'division_merged',
                      'records_archived', 'logs_purged', 'schema_applied') then 'database'
    when p_action in ('retention_run', 'directory_synced', 'daily_round') then 'system'
    when p_actor is null and p_action in ('completed', 'escalated', 'reminded', 'followup_created', 'email_received') then 'application'
    else 'user' end
$$;

create or replace function app.audit_severity(p_action text)
returns text
language sql
immutable
as $$
  select case
    when p_action in ('account_locked', 'error') then 'critical'
    when p_action in ('sign_in_failed', 'mfa_disabled', 'password_reset', 'api_key_revoked', 'account_deactivated',
                      'webhook_secret_rotated', 'logs_purged') then 'warning'
    else 'info' end
$$;

create or replace function app.audit_rows(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns table (at timestamptz, category text, severity text, source text, action text,
               actor_id text, actor text, subject text, subject_id uuid, detail text)
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  -- The activity log: accounts, roles, settings, imports.
  select a.created_at, app.audit_category(a.action, a.actor_id), app.audit_severity(a.action), 'activity', a.action,
         a.actor_id, e.name, coalesce(s.ref_number, replace(a.entity_type, '_', ' ')), a.entity_id, a.detail
    from public.activity_log a
    left join public.employees e on e.employee_id = a.actor_id and e.tenant_id = a.tenant_id
    left join public.form_submissions s on s.id = a.entity_id and s.tenant_id = a.tenant_id
   where a.tenant_id = p_tenant and a.created_at between p_from and p_to
     -- Decisions are in approval_events with more detail; the activity
     -- log's copy of them is the dashboard's feed.
     and a.action not in ('approved', 'rejected', 'submitted')
  union all
  -- What happened to each request, step by step.
  select ev.created_at, case when ev.actor_id is null then 'application' else 'user' end,
         'info', 'requests', ev.action,
         ev.actor_id, e.name, s.ref_number, ev.subject_id,
         concat_ws(' — ', t.name, ev.comment)
    from public.approval_events ev
    left join public.employees e on e.employee_id = ev.actor_id and e.tenant_id = ev.tenant_id
    left join public.form_submissions s on s.id = ev.subject_id and s.tenant_id = ev.tenant_id
    left join public.form_templates t on t.id = s.form_template_id and t.tenant_id = ev.tenant_id
   where ev.tenant_id = p_tenant and ev.created_at between p_from and p_to
  union all
  -- Who opened which document.
  select x.accessed_at, 'user', 'info', 'documents', 'document_viewed',
         x.actor_id, e.name, s.ref_number, at.submission_id, at.file_name
    from public.attachment_access x
    join public.attachments at on at.id = x.attachment_id and at.tenant_id = x.tenant_id
    left join public.form_submissions s on s.id = at.submission_id and s.tenant_id = x.tenant_id
    left join public.employees e on e.employee_id = x.actor_id and e.tenant_id = x.tenant_id
   where x.tenant_id = p_tenant and x.accessed_at between p_from and p_to
  union all
  -- Email.
  select o.created_at, 'application', case when o.status = 'failed' then 'warning' else 'info' end, 'email',
         'email_' || o.status, o.recipient_id, e.name, coalesce(o.subject, o.context->>'title', o.kind), o.entity_id,
         concat_ws(' · ', o.kind, o.to_address, o.error)
    from public.email_outbox o
    left join public.employees e on e.employee_id = o.recipient_id and e.tenant_id = o.tenant_id
   where o.tenant_id = p_tenant and o.created_at between p_from and p_to
  union all
  -- Mail received.
  select m.received_at, 'application', case when m.outcome = 'rejected' then 'warning' else 'info' end, 'inbound mail',
         'mail_' || m.outcome, null, m.from_address, coalesce(s.ref_number, m.subject), m.submission_id,
         concat_ws(' — ', m.subject, m.reason)
    from public.inbound_mail m
    left join public.form_submissions s on s.id = m.submission_id and s.tenant_id = m.tenant_id
   where m.tenant_id = p_tenant and m.received_at between p_from and p_to
  union all
  -- Calls to the API. A refused key is a security event.
  select r.created_at, 'application',
         case when r.status in (401, 403) then 'warning' when r.status >= 500 then 'critical' else 'info' end, 'api',
         'api_call', null, coalesce(k.name, 'unknown key'), r.method || ' ' || r.path, r.key_id,
         concat_ws(' · ', r.status::text, r.ms::text || ' ms', r.ip, r.error)
    from public.api_requests r
    left join public.api_keys k on k.id = r.key_id
   where r.tenant_id = p_tenant and r.created_at between p_from and p_to
  union all
  -- Webhook deliveries.
  select d.created_at, 'application', case when d.status = 'failed' then 'warning' else 'info' end, 'webhooks',
         'webhook_' || d.status, null, w.name, d.event, d.id,
         concat_ws(' · ', w.url, d.response_status::text, d.response_ms::text || ' ms', d.attempts::text || ' attempt(s)', d.error)
    from public.webhook_deliveries d
    join public.webhooks w on w.id = d.webhook_id
   where d.tenant_id = p_tenant and d.created_at between p_from and p_to
  union all
  -- What went wrong in the application.
  select x.at, 'application', 'critical', 'errors', 'error', null, null, x.source, null,
         concat_ws(' · ', x.status::text, x.message)
    from public.app_errors x
   -- Only this organisation's: an error recorded without one may quote
   -- somebody else's data.
   where x.tenant_id = p_tenant and x.at between p_from and p_to
  union all
  -- Scheduled work.
  select r.started_at, 'system', case when r.error is not null then 'critical' else 'info' end, 'scheduler',
         r.job, null, 'Scheduler', replace(r.job, '_', ' '), null,
         coalesce(r.error, (select string_agg(k || ' ' || v, ', ') from jsonb_each_text(coalesce(r.result, '{}'::jsonb)) j(k, v)))
    from public.system_runs r
   where (r.tenant_id = p_tenant or r.tenant_id is null) and r.started_at between p_from and p_to
  union all
  -- The database's structure, each time it was applied.
  select m.applied_at, 'database', 'info', 'schema', 'schema_applied', null, 'Deployment', m.file, null,
         'checksum ' || left(m.checksum, 12)
    from public.schema_migrations m
   where m.applied_at between p_from and p_to
$$;

-- The trail, filtered, for whoever may read it.
create or replace function public.audit_events(
  p_from timestamptz, p_to timestamptz, p_categories text[], p_severity text, p_search text, p_limit integer)
returns table (at timestamptz, category text, severity text, source text, action text,
               actor_id text, actor text, subject text, subject_id uuid, detail text)
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare v_like text;
begin
  perform app.require_permission('audit.view');
  v_like := case when coalesce(trim(p_search), '') = '' then null
                 else '%' || lower(replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_')) || '%' end;
  return query
    select r.* from app.audit_rows(app.current_tenant(), coalesce(p_from, now() - interval '30 days'), coalesce(p_to, now())) r
     where (p_categories is null or cardinality(p_categories) = 0 or r.category = any (p_categories))
       and (p_severity is null or p_severity = '' or r.severity = p_severity
            or (p_severity = 'warning' and r.severity = 'critical'))
       and (v_like is null or lower(concat_ws(' ', r.action, r.actor_id, r.actor, r.subject, r.detail, r.source)) like v_like)
     order by r.at desc
     limit least(greatest(coalesce(p_limit, 500), 1), 20000);
end $$;

-- What the monitoring charts are drawn from. Working hours are Dhaka's,
-- 09:00 to 18:00, Sunday to Thursday.
create or replace function public.audit_summary(p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare v_from timestamptz; v jsonb;
begin
  perform app.require_permission('audit.view');
  v_from := date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka'
            - make_interval(days => greatest(least(coalesce(p_days, 30), 365), 7) - 1);
  with r as materialized (
    select x.category, x.severity, x.source, x.action, x.actor_id, x.actor,
           (x.at at time zone 'Asia/Dhaka') as local,
           (extract(isodow from x.at at time zone 'Asia/Dhaka') in (5, 6)
            or (x.at at time zone 'Asia/Dhaka')::time < time '09:00'
            or (x.at at time zone 'Asia/Dhaka')::time >= time '18:00') as after_hours
      from app.audit_rows(app.current_tenant(), v_from, now()) x
  ), days as (
    select d::date as day
      from generate_series((v_from at time zone 'Asia/Dhaka')::date, (now() at time zone 'Asia/Dhaka')::date, interval '1 day') d
  ), per_day as (
    select days.day,
           count(*) filter (where r.category = 'user') as "user",
           count(*) filter (where r.category = 'application') as application,
           count(*) filter (where r.category = 'system') as system,
           count(*) filter (where r.category = 'database') as database,
           count(*) filter (where r.action = 'sign_in_failed') as failed_sign_ins,
           count(*) filter (where r.source = 'api' and r.severity = 'warning') as refused_api,
           count(*) filter (where r.action = 'account_locked') as locked
      from days left join r on r.local::date = days.day
     group by days.day
  )
  select jsonb_build_object(
    'from', v_from,
    'total', (select count(*) from r),
    'by_category', (select coalesce(jsonb_object_agg(category, n), '{}'::jsonb) from (select category, count(*) n from r group by 1) c),
    'by_severity', (select coalesce(jsonb_object_agg(severity, n), '{}'::jsonb) from (select severity, count(*) n from r group by 1) c),
    'daily', (select jsonb_agg(jsonb_build_object('day', day, 'user', "user", 'application', application,
                                                  'system', system, 'database', database) order by day) from per_day),
    'security', (select jsonb_agg(jsonb_build_object('day', day, 'failed_sign_ins', failed_sign_ins,
                                                     'refused_api', refused_api, 'locked', locked) order by day) from per_day),
    'after_hours', (select jsonb_build_object('total', count(*), 'after', count(*) filter (where after_hours))
                      from r where r.category = 'user'),
    'after_hours_people', (select coalesce(jsonb_agg(jsonb_build_object('actor_id', actor_id, 'actor', actor, 'n', n) order by n desc), '[]'::jsonb)
                from (select actor_id, max(actor) actor, count(*) n from r
                       where r.category = 'user' and r.actor_id is not null and r.after_hours
                       group by actor_id order by count(*) desc limit 5) a),
    'top_actors', (select coalesce(jsonb_agg(jsonb_build_object('actor_id', actor_id, 'actor', actor, 'n', n) order by n desc), '[]'::jsonb)
                from (select actor_id, max(actor) actor, count(*) n from r
                       where r.category = 'user' and r.actor_id is not null
                       group by actor_id order by count(*) desc limit 8) a),
    'by_hour', (select jsonb_agg(jsonb_build_object('hour', h.h, 'n', coalesce(c.n, 0)) order by h.h)
                  from generate_series(0, 23) h(h)
                  left join (select extract(hour from local)::int hr, count(*) n from r where r.category = 'user' group by 1) c on c.hr = h.h)
  ) into v;
  return v;
end $$;

-- =====================================================================
-- Retention.
-- =====================================================================

-- When a request was settled: when the other system closed it, or the
-- last thing that happened to it here.
create or replace function app.settled_at(p_submission uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(s.closed_at,
                  (select max(ev.created_at) from public.approval_events ev
                    where ev.subject_id = s.id and ev.tenant_id = s.tenant_id),
                  s.submitted_at)
    from public.form_submissions s where s.id = p_submission
$$;

create or replace function public.set_retention(p_years integer, p_archive_months integer, p_purge_months integer)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.require_permission('records.manage');
  if p_years not between 1 and 50 then raise exception 'keep records for between 1 and 50 years'; end if;
  if p_archive_months not between 1 and 120 then raise exception 'archive after between 1 and 120 months'; end if;
  if p_purge_months not between 12 and 600 then raise exception 'purge logs after between 12 and 600 months'; end if;
  if p_purge_months > p_years * 12 then raise exception 'logs cannot be kept longer than the records they describe'; end if;
  update public.tenants
     set retention_years = p_years, archive_after_months = p_archive_months, purge_logs_after_months = p_purge_months
   where id = app.current_tenant();
  perform app.audit('retention_changed', 'tenant', null::uuid,
    format('keep %s years, archive after %s months, purge logs after %s months', p_years, p_archive_months, p_purge_months));
end $$;

-- What a run would do, without doing it.
create or replace function app.retention_due(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  with t as (select * from public.tenants where id = p_tenant),
  cut as (select now() - make_interval(months => t.archive_after_months) as archive,
                 now() - make_interval(months => t.purge_logs_after_months) as purge,
                 now() - make_interval(years => t.retention_years) as keep
            from t)
  select jsonb_build_object(
    'archive', (select count(*) from public.form_submissions s, cut
                 where s.tenant_id = p_tenant and s.archived_at is null
                   and s.status in ('completed', 'rejected', 'cancelled')
                   and app.settled_at(s.id) < cut.archive),
    'archived', (select count(*) from public.form_submissions s where s.tenant_id = p_tenant and s.archived_at is not null),
    'past_retention', (select count(*) from public.form_submissions s, cut
                        where s.tenant_id = p_tenant and s.archived_at is not null and app.settled_at(s.id) < cut.keep),
    'oldest_archived', (select min(app.settled_at(s.id)) from public.form_submissions s
                         where s.tenant_id = p_tenant and s.archived_at is not null),
    'logs', jsonb_build_object(
      'email',     (select count(*) from public.email_outbox x, cut where x.tenant_id = p_tenant and x.created_at < cut.purge and x.status <> 'queued'),
      'api',       (select count(*) from public.api_requests x, cut where x.tenant_id = p_tenant and x.created_at < cut.purge),
      'webhooks',  (select count(*) from public.webhook_deliveries x, cut where x.tenant_id = p_tenant and x.created_at < cut.purge and x.status in ('delivered', 'failed')),
      'inbound',   (select count(*) from public.inbound_mail x, cut where x.tenant_id = p_tenant and x.received_at < cut.purge),
      'errors',    (select count(*) from public.app_errors x, cut where x.tenant_id = p_tenant and x.at < cut.purge),
      'scheduler', (select count(*) from public.system_runs x, cut where x.tenant_id = p_tenant and x.started_at < cut.purge)),
    'by_year', (select coalesce(jsonb_agg(jsonb_build_object('year', y, 'archived', a, 'active', n) order by y), '[]'::jsonb)
                  from (select extract(year from app.settled_at(s.id))::int y,
                               count(*) filter (where s.archived_at is not null) a,
                               count(*) filter (where s.archived_at is null) n
                          from public.form_submissions s
                         where s.tenant_id = p_tenant and s.status <> 'draft'
                         group by 1) b)
  )
$$;

-- Archive what is due and purge the logs past their time. The records
-- themselves are never deleted here: "past retention" is reported for a
-- records officer to dispose of, because destroying a financial record
-- is a decision, not a timer.
create or replace function app.run_retention(p_tenant uuid, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  t record; v_archive timestamptz; v_purge timestamptz;
  v_archived int; v_email int; v_api int; v_hooks int; v_inbound int; v_errors int; v_runs int; v jsonb;
begin
  select * into t from public.tenants where id = p_tenant;
  v_archive := now() - make_interval(months => t.archive_after_months);
  v_purge := now() - make_interval(months => t.purge_logs_after_months);

  update public.form_submissions s set archived_at = now()
   where s.tenant_id = p_tenant and s.archived_at is null
     and s.status in ('completed', 'rejected', 'cancelled')
     and app.settled_at(s.id) < v_archive;
  get diagnostics v_archived = row_count;

  delete from public.email_outbox where tenant_id = p_tenant and created_at < v_purge and status <> 'queued';
  get diagnostics v_email = row_count;
  delete from public.api_requests where tenant_id = p_tenant and created_at < v_purge;
  get diagnostics v_api = row_count;
  delete from public.webhook_deliveries where tenant_id = p_tenant and created_at < v_purge and status in ('delivered', 'failed');
  get diagnostics v_hooks = row_count;
  delete from public.inbound_mail where tenant_id = p_tenant and received_at < v_purge;
  get diagnostics v_inbound = row_count;
  delete from public.app_errors where tenant_id = p_tenant and at < v_purge;
  get diagnostics v_errors = row_count;
  delete from public.system_runs where tenant_id = p_tenant and started_at < v_purge;
  get diagnostics v_runs = row_count;

  v := jsonb_build_object('archived', v_archived,
         'purged', v_email + v_api + v_hooks + v_inbound + v_errors + v_runs,
         'purged_detail', jsonb_build_object('email', v_email, 'api', v_api, 'webhooks', v_hooks,
                                             'inbound', v_inbound, 'errors', v_errors, 'scheduler', v_runs),
         'past_retention', (app.retention_due(p_tenant))->'past_retention');

  if v_archived > 0 then
    insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
    values (p_tenant, p_actor, 'records_archived', 'tenant', p_tenant,
            format('%s settled request(s) archived — older than %s months', v_archived, t.archive_after_months));
  end if;
  if (v->>'purged')::int > 0 then
    insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
    values (p_tenant, p_actor, 'logs_purged', 'tenant', p_tenant,
            format('%s log entries older than %s months purged', v->>'purged', t.purge_logs_after_months));
  end if;
  update public.tenants set last_retention_run = now(), last_retention_result = v where id = p_tenant;
  return v;
end $$;

create or replace function public.retention_preview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare t record;
begin
  if not (app.has_permission('records.manage') or app.has_permission('audit.view')) then
    raise exception 'you need the records.manage permission for that';
  end if;
  select * into t from public.tenants where id = app.current_tenant();
  return app.retention_due(t.id) || jsonb_build_object(
    'settings', jsonb_build_object('retention_years', t.retention_years, 'archive_after_months', t.archive_after_months,
                                   'purge_logs_after_months', t.purge_logs_after_months),
    'last_run', t.last_retention_run, 'last_result', t.last_retention_result,
    'can_manage', app.has_permission('records.manage'));
end $$;

create or replace function public.run_retention_now()
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v jsonb; v_started timestamptz := clock_timestamp();
begin
  perform app.require_permission('records.manage');
  v := app.run_retention(app.current_tenant(), app.current_employee());
  insert into public.system_runs (tenant_id, job, started_at, finished_at, result)
  values (app.current_tenant(), 'retention_run', v_started, clock_timestamp(),
          jsonb_build_object('archived', v->'archived', 'purged', v->'purged', 'by', coalesce(app.current_employee(), 'administrator')));
  return v;
end $$;

-- Bring one back to the working lists: a settled matter reopened.
create or replace function public.unarchive_submission(p_submission uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_ref text;
begin
  perform app.require_permission('records.manage');
  update public.form_submissions set archived_at = null
   where id = p_submission and tenant_id = app.current_tenant() and archived_at is not null and legacy_ref is null
  returning ref_number into v_ref;
  if v_ref is null then raise exception 'only an archived request made here can be brought back'; end if;
  perform app.audit('record_unarchived', 'form_submission', p_submission, v_ref);
end $$;

-- =====================================================================
-- Migration: tickets settled in another system — ManageEngine
-- ServiceDesk Plus — as archived records here, found by search and by
-- their old reference.
--
-- p_rows is an array of {ref, subject, description, category, requester,
-- technician, status, priority, created, closed, resolution}; the server
-- maps an export's columns onto those names and its dates to ISO. Only
-- settled tickets are taken: an open one belongs in the working system,
-- not the archive.
-- =====================================================================
create or replace function public.import_legacy_tickets(p_source text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_tenant uuid := app.current_tenant(); v_src text; v_tpl uuid; r jsonb; v_req text; v_sub uuid;
  v_status text; v_created timestamptz; v_closed timestamptz; v_ref text;
  n_imported int := 0; n_dup int := 0; n_open int := 0; n_invalid int := 0; n_unmatched int := 0;
  v_errors jsonb := '[]'::jsonb; i int := 0;
begin
  if not (app.has_permission('records.manage') or app.current_employee() is null) then
    raise exception 'you need the records.manage permission for that';
  end if;
  v_src := coalesce(nullif(trim(p_source), ''), 'ManageEngine');
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'expected a list of tickets'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'at most 5,000 tickets at a time'; end if;

  select id into v_tpl from public.form_templates where tenant_id = v_tenant and name = v_src || ' archive';
  if v_tpl is null then
    insert into public.form_templates (tenant_id, name, category, created_by, status, classification, keywords)
    values (v_tenant, v_src || ' archive', 'Admin', app.current_employee(), 'archived', 'non_budgetary',
            array['legacy', 'migrated', lower(v_src), 'servicedesk'])
    returning id into v_tpl;
    insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, order_index, is_required, field_config)
    select v_tenant, v_tpl, ft, fn, ord - 1, false, '{}'::jsonb
      from unnest(array['text', 'textarea', 'text', 'text', 'text', 'text', 'text', 'date', 'date', 'textarea'],
                  array['Subject', 'Description', 'Category', 'Requester', 'Technician', 'Priority',
                        'Status in ' || v_src, 'Created', 'Closed', 'Resolution'])
           with ordinality x(ft, fn, ord);
  end if;

  perform set_config('app.on_behalf', 'true', true);
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_ref := nullif(trim(r->>'ref'), '');
    if v_ref is null or coalesce(trim(r->>'subject'), '') = '' then
      n_invalid := n_invalid + 1;
      if jsonb_array_length(v_errors) < 20 then v_errors := v_errors || jsonb_build_object('row', i, 'error', 'needs a reference and a subject'); end if;
      continue;
    end if;
    if exists (select 1 from public.form_submissions where tenant_id = v_tenant and legacy_source = v_src and legacy_ref = v_ref) then
      n_dup := n_dup + 1; continue;
    end if;
    v_status := case lower(coalesce(trim(r->>'status'), ''))
      when 'closed' then 'completed' when 'resolved' then 'completed' when 'completed' then 'completed'
      when 'cancelled' then 'cancelled' when 'canceled' then 'cancelled'
      when 'rejected' then 'rejected' end;
    if v_status is null then
      n_open := n_open + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_object('row', i, 'ref', v_ref, 'error', 'is ' || coalesce(nullif(r->>'status', ''), 'not settled') || ', not closed');
      end if;
      continue;
    end if;
    begin
      v_created := (r->>'created')::timestamptz;
      v_closed := coalesce(nullif(r->>'closed', '')::timestamptz, v_created);
    exception when others then
      n_invalid := n_invalid + 1;
      if jsonb_array_length(v_errors) < 20 then v_errors := v_errors || jsonb_build_object('row', i, 'ref', v_ref, 'error', 'has a date that cannot be read'); end if;
      continue;
    end;
    if v_created is null then
      n_invalid := n_invalid + 1;
      if jsonb_array_length(v_errors) < 20 then v_errors := v_errors || jsonb_build_object('row', i, 'ref', v_ref, 'error', 'has no created date'); end if;
      continue;
    end if;

    select employee_id into v_req from public.employees e
     where e.tenant_id = v_tenant and coalesce(r->>'requester', '') <> ''
       and (e.employee_id = trim(r->>'requester') or lower(e.email) = lower(trim(r->>'requester'))
            or lower(e.name) = lower(trim(r->>'requester')))
     order by e.active desc limit 1;
    if v_req is null then n_unmatched := n_unmatched + 1; end if;

    insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at, ref_number,
                                         priority, archived_at, legacy_ref, legacy_source, closed_at)
    values (v_tenant, v_tpl, v_req, v_status, v_created, 'ME-' || v_ref,
            case lower(coalesce(r->>'priority', '')) when 'high' then 'high' when 'urgent' then 'urgent' else 'normal' end,
            now(), v_ref, v_src, v_closed)
    returning id into v_sub;

    insert into public.submission_values (tenant_id, submission_id, field_name, value)
    select v_tenant, v_sub, k, v from (values
      ('Subject', r->>'subject'), ('Description', r->>'description'), ('Category', r->>'category'),
      ('Requester', r->>'requester'), ('Technician', r->>'technician'), ('Priority', r->>'priority'),
      ('Status in ' || v_src, r->>'status'), ('Created', to_char(v_created, 'YYYY-MM-DD')),
      ('Closed', to_char(v_closed, 'YYYY-MM-DD')), ('Resolution', r->>'resolution')) x(k, v)
     where coalesce(v, '') <> '';

    -- Its history: raised and closed there, brought over here.
    insert into public.approval_events (tenant_id, request_id, subject_type, subject_id, actor_id, action, comment, created_at)
    values (v_tenant, null, 'form_submission', v_sub, v_req, 'raised_in_legacy', v_src || ' ' || v_ref, v_created),
           (v_tenant, null, 'form_submission', v_sub, null, 'closed_in_legacy',
            concat_ws(' — ', nullif(r->>'technician', ''), left(nullif(r->>'resolution', ''), 300)), v_closed),
           (v_tenant, null, 'form_submission', v_sub, app.current_employee(), 'migrated', 'Imported from ' || v_src, now());
    n_imported := n_imported + 1;
  end loop;
  perform set_config('app.on_behalf', 'false', true);

  if n_imported > 0 then
    perform app.audit('legacy_import', 'form_template', v_tpl,
      format('%s ticket(s) imported from %s; %s already here, %s still open, %s unreadable', n_imported, v_src, n_dup, n_open, n_invalid));
  end if;
  return jsonb_build_object('imported', n_imported, 'duplicates', n_dup, 'open', n_open, 'invalid', n_invalid,
                            'unmatched_requesters', n_unmatched, 'errors', v_errors, 'template_id', v_tpl);
end $$;

-- A ManageEngine export to try the import with, and the template's own
-- archive: closed tickets from 2013 on, some of them past twelve years.
create or replace function app.sample_legacy_tickets(p_count integer default 48)
returns jsonb
language plpgsql
volatile
as $$
declare
  v jsonb := '[]'::jsonb; k int; v_created timestamptz; v_hours int; v_cat text; v_subj text; v_tech text; v_req text;
  cats text[] := array['Hardware', 'Software', 'Network', 'Access', 'Facilities', 'Email'];
  subjects text[][] := array[
    array['Laptop will not boot after update', 'Replace keyboard on finance desk', 'Monitor flickering', 'Printer jam on 4th floor'],
    array['Install Tally ERP on new machine', 'Excel add-in crashes', 'Licence renewal for Adobe', 'Upgrade Office suite'],
    array['Wi-Fi drops in meeting room 3', 'VPN not connecting from home', 'Slow network in warehouse', 'New LAN point for HR'],
    array['Access to shared finance drive', 'Reset ERP password', 'New joiner: create accounts', 'Remove access for leaver'],
    array['AC not cooling in server room', 'Generator test schedule', 'Water purifier service', 'Repair door access reader'],
    array['Mailbox full', 'Distribution list for campaign team', 'Phishing email reported', 'Out-of-office not working']];
  techs text[] := array['Rafiq Ahmed', 'Sumon Das', 'Lina Chowdhury', 'Kamal Hossain'];
  reqs text[] := array['EMP-2847', 'EMP-1134', 'EMP-0312', 'EMP-0445', 'EMP-0416', 'Former employee (K. Rahman)', 'EMP-0201', 'EMP-0600'];
  stats text[] := array['Closed', 'Closed', 'Resolved', 'Closed', 'Cancelled', 'Resolved'];
begin
  perform setseed(0.4242);
  for k in 1..p_count loop
    -- Spread from 2013 to two years ago, oldest first.
    v_created := timestamptz '2013-03-01 10:00+06'
                 + ((now() - interval '2 years' - timestamptz '2013-03-01') * (k - 1 + random() * 0.8) / p_count);
    v_created := date_trunc('minute', v_created);
    v_hours := 2 + floor(random() * 120)::int;
    v_cat := cats[1 + floor(random() * 6)::int];
    v_subj := subjects[array_position(cats, v_cat)][1 + floor(random() * 4)::int];
    v_tech := techs[1 + floor(random() * 4)::int];
    v_req := reqs[1 + floor(random() * 8)::int];
    v := v || jsonb_build_object(
      'ref', 'SR-' || (10200 + k * 37)::text,
      'subject', v_subj,
      'description', 'Reported by phone to the service desk. ' || v_subj || '.',
      'category', v_cat,
      'requester', v_req,
      'technician', v_tech,
      'status', stats[1 + floor(random() * 6)::int],
      'priority', (array['Low', 'Medium', 'Medium', 'High', 'Urgent'])[1 + floor(random() * 5)::int],
      'created', to_char(v_created at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'closed', to_char((v_created + make_interval(hours => v_hours)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'resolution', (array['Replaced the part and tested.', 'Reinstalled and confirmed with the user.',
                           'Configuration corrected.', 'Access granted after line manager approval.',
                           'Vendor visited and fixed.', 'Duplicate of an earlier ticket.'])[1 + floor(random() * 6)::int]);
  end loop;
  return v;
end $$;

-- =====================================================================
-- An evaluation's integrations, so the screens have a history to show:
-- the ERP's key and the reporting tool's, a revoked one, their calls
-- over the last sixty days, a webhook to the built-in receiver with its
-- deliveries, and the scheduler's runs. Made per organisation, never
-- cloned: a key belongs to one.
-- =====================================================================
alter table public.tenants add column if not exists integration_seeded boolean not null default false;

create or replace function app.seed_integration(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_sap uuid; v_tab uuid; v_old uuid; v_hook uuid; d date; k int; v_at timestamptz; v_n int; v_status int;
  v_path text; v_method text; s record;
  v_report uuid;
begin
  if (select integration_seeded from public.tenants where id = p_tenant) then return; end if;
  perform setseed(0.31);
  select id into v_report from public.report_templates where tenant_id = p_tenant order by created_at limit 1;

  -- Nobody holds these secrets: the hash is of a value thrown away.
  insert into public.api_keys (tenant_id, name, prefix, secret_hash, scopes, created_by, created_at, last_used_at)
  values (p_tenant, 'SAP S/4HANA — finance sync', substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
          encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'),
          array['approvals:write', 'forms:read', 'requests:read', 'requests:write'], 'EMP-0445', now() - interval '75 days', now() - interval '2 hours')
  returning id into v_sap;
  insert into public.api_keys (tenant_id, name, prefix, secret_hash, scopes, created_by, created_at, last_used_at)
  values (p_tenant, 'Tableau — management reporting', substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
          encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'),
          array['campaigns:read', 'reports:read', 'requests:read'], 'EMP-0445', now() - interval '60 days', now() - interval '20 hours')
  returning id into v_tab;
  insert into public.api_keys (tenant_id, name, prefix, secret_hash, scopes, created_by, created_at, last_used_at, revoked_at, revoked_by)
  values (p_tenant, 'ERP pilot (test)', substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
          encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'),
          array['requests:read'], 'EMP-0445', now() - interval '90 days', now() - interval '41 days', now() - interval '40 days', 'EMP-0445')
  returning id into v_old;

  insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail, created_at) values
    (p_tenant, 'EMP-0445', 'api_key_created', 'api_key', v_old, 'ERP pilot (test) — requests:read', now() - interval '90 days'),
    (p_tenant, 'EMP-0445', 'api_key_created', 'api_key', v_sap, 'SAP S/4HANA — finance sync — approvals:write, forms:read, requests:read, requests:write', now() - interval '75 days'),
    (p_tenant, 'EMP-0445', 'api_key_created', 'api_key', v_tab, 'Tableau — management reporting — campaigns:read, reports:read, requests:read', now() - interval '60 days'),
    (p_tenant, 'EMP-0445', 'api_key_revoked', 'api_key', v_old, 'ERP pilot (test)', now() - interval '40 days');

  -- Sixty days of calls: the ERP through the working day, Tableau each
  -- night, and the revoked pilot key still trying for a while.
  for d in select generate_series(current_date - 59, current_date, interval '1 day')::date loop
    if extract(isodow from d) not in (5, 6) then
      v_n := 8 + floor(random() * 14)::int;
      for k in 1..v_n loop
        v_at := (d + time '03:00' + make_interval(mins => floor(random() * 540)::int)) at time zone 'UTC';
        if v_at > now() then continue; end if;
        v_method := case when random() < 0.7 then 'GET' else 'POST' end;
        v_path := case when v_method = 'GET' then (array['/api/v1/requests?status=completed&updated_since=' || to_char(d - 1, 'YYYY-MM-DD'),
                                                         '/api/v1/approvals?status=pending', '/api/v1/forms'])[1 + floor(random() * 3)::int]
                       else (array['/api/v1/requests', '/api/v1/approvals/' || gen_random_uuid() || '/decision'])[1 + floor(random() * 2)::int] end;
        v_status := case when random() < 0.04 then 422 when random() < 0.01 then 500
                         when v_method = 'POST' and v_path = '/api/v1/requests' then 201 else 200 end;
        insert into public.api_requests (tenant_id, key_id, method, path, status, ms, ip, error, created_at)
        values (p_tenant, v_sap, v_method, v_path, v_status, 40 + floor(random() * 260)::int, '10.20.4.17',
                case v_status when 422 then 'Amount claimed is required' when 500 then 'internal error' end, v_at);
      end loop;
    end if;
    for k in 1..(2 + floor(random() * 3)::int) loop
      v_at := (d + time '19:00' + make_interval(mins => k * 3)) at time zone 'UTC';
      if v_at > now() then continue; end if;
      insert into public.api_requests (tenant_id, key_id, method, path, status, ms, ip, created_at)
      values (p_tenant, v_tab, 'GET',
              (array['/api/v1/reports/' || coalesce(v_report::text, 'standard') || '?format=csv', '/api/v1/campaigns',
                     '/api/v1/requests?limit=500'])[1 + (k % 3)], 200, 120 + floor(random() * 900)::int, '10.20.9.40', v_at);
    end loop;
    if d between current_date - 40 and current_date - 33 then
      insert into public.api_requests (tenant_id, key_id, method, path, status, ms, ip, error, created_at)
      values (p_tenant, v_old, 'GET', '/api/v1/requests', 401, 3, '103.86.12.9', 'this API key has been revoked',
              (d + time '04:12' + make_interval(mins => floor(random() * 300)::int)) at time zone 'UTC');
    end if;
  end loop;

  -- The ERP hears of each outcome. Its address is the built-in receiver,
  -- so deliveries made during a demonstration arrive and are verified.
  insert into public.webhooks (tenant_id, name, url, events, secret, active, created_by, created_at)
  values (p_tenant, 'SAP — request outcomes', '/webhooks/echo',
          array['approval.approved', 'approval.rejected', 'request.completed', 'request.rejected'],
          encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), true, 'EMP-0445', now() - interval '74 days')
  returning id into v_hook;

  for s in
    select f.id, f.ref_number, f.status, app.settled_at(f.id) as at
      from public.form_submissions f
     where f.tenant_id = p_tenant and f.status in ('completed', 'rejected') and f.legacy_ref is null
       and app.settled_at(f.id) > now() - interval '60 days'
     order by 4 limit 80
  loop
    v_status := case when random() < 0.05 then 503 else 200 end;
    insert into public.webhook_deliveries (tenant_id, webhook_id, event, payload, status, attempts, response_status,
                                           response_ms, response_body, error, created_at, delivered_at)
    values (p_tenant, v_hook, case s.status when 'completed' then 'request.completed' else 'request.rejected' end,
            jsonb_build_object('event', case s.status when 'completed' then 'request.completed' else 'request.rejected' end,
                               'occurred_at', s.at, 'data', jsonb_build_object('request', app.request_json(s.id))),
            case when v_status = 200 then 'delivered' else 'failed' end, case when v_status = 200 then 1 else 3 end,
            v_status, 60 + floor(random() * 300)::int,
            case when v_status = 200 then '{"received":true,"verified":true}' else 'Service Unavailable' end,
            case when v_status = 503 then 'the receiver answered 503 Service Unavailable' end,
            s.at + interval '2 seconds', case when v_status = 200 then s.at + interval '3 seconds' end);
  end loop;

  -- The scheduler: the daily round at 08:00 Dhaka, directory sync hourly
  -- in the working day (recorded once a day here).
  for d in select generate_series(current_date - 59, current_date - 1, interval '1 day')::date loop
    insert into public.system_runs (tenant_id, job, started_at, finished_at, result)
    values (p_tenant, 'daily_round', (d + time '02:00') at time zone 'UTC', (d + time '02:00' + make_interval(secs => 2 + random() * 6)) at time zone 'UTC',
            jsonb_build_object('reminders', floor(random() * 6)::int, 'escalated', floor(random() * 2)::int,
                               'reports', case when extract(isodow from d) = 7 then 2 else 0 end,
                               'archived', 0, 'emails', floor(random() * 12)::int));
    if extract(isodow from d) not in (5, 6) then
      insert into public.system_runs (tenant_id, job, started_at, finished_at, result, error)
      values (p_tenant, 'directory_sync', (d + time '03:00') at time zone 'UTC', (d + time '03:00' + make_interval(secs => 1 + random() * 3)) at time zone 'UTC',
              case when d = current_date - 17 then null else jsonb_build_object('updated', floor(random() * 3)::int, 'leavers', 0) end,
              case when d = current_date - 17 then 'the directory did not answer within 8 seconds' end);
    end if;
  end loop;

  update public.tenants set integration_seeded = true where id = p_tenant;
end $$;

-- Signing in, over the last sixty days — some of it out of hours, some
-- of it failing, one account locked. Part of the template, and so cloned.
create or replace function app.seed_sign_ins(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare d date; e record; v_at timestamptz; v_user uuid;
begin
  perform setseed(0.57);
  select id into v_user from public.app_users where tenant_id = p_tenant limit 1;
  for d in select generate_series(current_date - 59, current_date, interval '1 day')::date loop
    for e in select employee_id, name from public.employees where tenant_id = p_tenant and active order by employee_id loop
      if extract(isodow from d) in (5, 6) and random() > 0.08 then continue; end if;
      if random() > 0.55 then continue; end if;
      -- Mostly 09:00–10:30 Dhaka; now and then late at night.
      v_at := (d + time '03:00' + make_interval(mins => floor(random() * 90)::int))::timestamp at time zone 'UTC';
      if random() < 0.06 then v_at := v_at + interval '14 hours'; end if;
      if v_at > now() then continue; end if;
      if random() < 0.07 then
        insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail, created_at)
        values (p_tenant, e.employee_id, 'sign_in_failed', 'app_user', coalesce(v_user, p_tenant),
                'wrong password for ' || lower(split_part(e.name, ' ', 1)), v_at - interval '1 minute');
      end if;
      insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail, created_at)
      values (p_tenant, e.employee_id, 'signed_in', 'app_user', coalesce(v_user, p_tenant),
              lower(split_part(e.name, ' ', 1)) || ' signed in', v_at);
    end loop;
  end loop;
  -- Somebody guessing at one account, late on a Friday.
  -- 17:40 Dhaka on the Friday at least a week back.
  d := (current_date - 7) - ((extract(isodow from current_date - 7)::int - 5 + 7) % 7);
  v_at := (d + time '11:40') at time zone 'UTC';
  insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail, created_at)
  select p_tenant, 'EMP-0312', 'sign_in_failed', 'app_user', coalesce(v_user, p_tenant), 'wrong password for raj', v_at + make_interval(mins => g)
    from generate_series(0, 4) g;
  insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail, created_at)
  values (p_tenant, 'EMP-0312', 'account_locked', 'app_user', coalesce(v_user, p_tenant), 'raj locked after 5 wrong attempts', v_at + interval '5 minutes'),
         (p_tenant, 'EMP-0445', 'account_unlocked', 'app_user', coalesce(v_user, p_tenant), 'raj unlocked', v_at + interval '2 days 3 hours');
end $$;

grant execute on function
  public.create_api_key(text, text[], text, text),
  public.revoke_api_key(uuid),
  public.save_webhook(uuid, text, text, text[], boolean, text),
  public.delete_webhook(uuid),
  public.test_webhook(uuid),
  public.redeliver_webhook(uuid),
  public.audit_events(timestamptz, timestamptz, text[], text, text, integer),
  public.audit_summary(integer),
  public.set_retention(integer, integer, integer),
  public.retention_preview(),
  public.run_retention_now(),
  public.unarchive_submission(uuid),
  public.import_legacy_tickets(text, jsonb)
to app_api;
grant execute on all functions in schema app to app_api;

commit;
