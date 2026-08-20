-- =====================================================================
-- Minting, cloning, and the lifecycle of an evaluation.
--
-- The clone is the risky part: 22 tables, a uuid graph to remap, and a
-- silent failure mode where a child keeps pointing at the template's
-- rows instead of its own copy. Counting rows would not catch that, so
-- these checks follow the pointers.
--
-- Run against a database with 001–004 applied.
-- =====================================================================

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % — got %, want %', label, got, want;
  end if;
  raise notice 'pass: %', label;
end $$;

delete from public.tenants where kind = 'demo' and name like 'Prov Test%';
select set_config('app.is_staff', 'true', false);

-- =====================================================================
-- 1. Staff only
-- =====================================================================
do $$
declare ok boolean := false;
begin
  -- Dropped and restored inside the block: this file runs as one
  -- transaction, so a transaction-local setting left false here would
  -- disable staff for every check after it.
  perform set_config('app.is_staff', 'false', true);
  begin
    perform app.provision_demo('Prov Test Nope', 'nope.eval', 'hash');
  exception when insufficient_privilege then ok := true;
  end;
  perform set_config('app.is_staff', 'true', true);
  if not ok then raise exception 'FAIL: a non-staff caller provisioned a tenant'; end if;
  raise notice 'pass: provisioning refused without staff context';
end $$;

-- =====================================================================
-- 2. Mint two, and check the clone followed its own pointers
-- =====================================================================
select set_config('t.tpl', (select id::text from public.tenants where kind='template'), false);

-- The slug is captured too: staff_audit outlives the tenants it
-- describes and has no delete policy, so entries from previous runs are
-- still present and an absolute count would drift upwards.
select set_config('t.a', (select tenant_id::text from app.provision_demo('Prov Test A', 'prov.a', 'hash-a', interval '3 days')), false);
select set_config('t.b', (select tenant_id::text from app.provision_demo('Prov Test B', 'prov.b', 'hash-b', interval '3 days')), false);
select set_config('s.a', (select slug from public.tenants where id = current_setting('t.a')::uuid), false);

select pg_temp.check('two evaluations exist',
  (select count(*)::int from public.tenants where kind='demo' and name like 'Prov Test%'), 2);

select pg_temp.check('the template still has its employees',
  (select count(*)::int from public.employees where tenant_id = current_setting('t.tpl')::uuid), 10);

select pg_temp.check('the clone has the same employees',
  (select count(*)::int from public.employees where tenant_id = current_setting('t.a')::uuid), 10);

select pg_temp.check('employee identifiers copy across unchanged',
  (select name from public.employees
    where tenant_id = current_setting('t.a')::uuid and employee_id = 'EMP-0700'), 'Alex Mercer'::text);

-- The pointer checks. A row whose parent still lives in the template is
-- the failure that row counts cannot see.
select pg_temp.check('no form field points at the template''s form',
  (select count(*)::int from public.form_fields f
     join public.form_templates t on t.id = f.form_template_id
    where f.tenant_id = current_setting('t.a')::uuid
      and t.tenant_id <> current_setting('t.a')::uuid), 0);

select pg_temp.check('no approval points at the template''s submission',
  (select count(*)::int from public.approval_requests a
     join public.form_submissions s on s.id = a.submission_id
    where a.tenant_id = current_setting('t.a')::uuid
      and s.tenant_id <> current_setting('t.a')::uuid), 0);

select pg_temp.check('no stock row points at the template''s item',
  (select count(*)::int from public.item_stock st
     join public.items i on i.id = st.item_id
    where st.tenant_id = current_setting('t.a')::uuid
      and i.tenant_id <> current_setting('t.a')::uuid), 0);

select pg_temp.check('no comment points at the template''s notice',
  (select count(*)::int from public.notice_comments c
     join public.notices n on n.id = c.notice_id
    where c.tenant_id = current_setting('t.a')::uuid
      and n.tenant_id <> current_setting('t.a')::uuid), 0);

-- The array column, which a join cannot check
select pg_temp.check('the delegation''s form list was remapped into the clone',
  (select count(*)::int
     from public.delegation_rules d, unnest(d.form_template_ids) x
     join public.form_templates t on t.id = x
    where d.tenant_id = current_setting('t.a')::uuid
      and t.tenant_id = current_setting('t.a')::uuid), 1);

-- The untyped pointer, which nothing else would catch
select pg_temp.check('activity entries point at the clone''s own submissions',
  (select count(*)::int from public.activity_log a
     join public.form_submissions s on s.id = a.entity_id
    where a.tenant_id = current_setting('t.a')::uuid
      and a.entity_type = 'form_submission'
      and s.tenant_id = current_setting('t.a')::uuid), 3);

select pg_temp.check('two evaluations share no rows',
  (select count(*)::int from public.form_submissions
    where id in (select id from public.form_submissions where tenant_id = current_setting('t.b')::uuid)
      and tenant_id = current_setting('t.a')::uuid), 0);

-- =====================================================================
-- 3. The chain arrives intact and still has exactly one live step
-- =====================================================================
select pg_temp.check('the 620,000 claim kept all four of its rungs',
  (select count(*)::int from public.approval_requests a
     join public.form_submissions s on s.id = a.submission_id
     join public.submission_values v on v.submission_id = s.id
    where a.tenant_id = current_setting('t.a')::uuid
      and v.field_name = 'Amount claimed' and v.value = '620000'), 4);

select pg_temp.check('exactly one step of that claim is live',
  (select count(*)::int from public.approval_requests a
     join public.submission_values v on v.submission_id = a.submission_id
    where a.tenant_id = current_setting('t.a')::uuid
      and v.field_name = 'Amount claimed' and v.value = '620000'
      and a.status = 'pending'), 1);

select pg_temp.check('and it is the Finance Controller''s',
  (select a.approver_user_id from public.approval_requests a
     join public.submission_values v on v.submission_id = a.submission_id
    where a.tenant_id = current_setting('t.a')::uuid
      and v.field_name = 'Amount claimed' and v.value = '620000'
      and a.status = 'pending'), 'EMP-0312'::text);

-- =====================================================================
-- 4. Duplicate usernames are refused
-- =====================================================================
do $$
declare ok boolean := false;
begin
  begin
    perform app.provision_demo('Prov Test Again', 'prov.a', 'hash-c');
  exception when unique_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL: a duplicate username was accepted'; end if;
  raise notice 'pass: duplicate username refused';
end $$;

-- =====================================================================
-- 5. Lifecycle
-- =====================================================================
select pg_temp.check('a fresh evaluation is active',
  app.tenant_status(current_setting('t.a')::uuid), 'active'::text);

select app.revoke_demo(current_setting('t.a')::uuid, null);
select pg_temp.check('a revoked evaluation reports revoked',
  app.tenant_status(current_setting('t.a')::uuid), 'revoked'::text);
select pg_temp.check('revoking disables its account',
  (select count(*)::int from public.app_users
    where tenant_id = current_setting('t.a')::uuid and status = 'disabled'), 1);

select app.extend_demo(current_setting('t.a')::uuid, interval '3 days', null);
select pg_temp.check('extending restores it',
  app.tenant_status(current_setting('t.a')::uuid), 'active'::text);
select pg_temp.check('...and re-enables the account it disabled',
  (select count(*)::int from public.app_users
    where tenant_id = current_setting('t.a')::uuid and status = 'active'), 1);

update public.tenants set expires_at = now() - interval '1 hour' where id = current_setting('t.a')::uuid;
select pg_temp.check('a lapsed evaluation reports expired',
  app.tenant_status(current_setting('t.a')::uuid), 'expired'::text);

select pg_temp.check('nothing is purged inside the grace period',
  app.purge_expired(interval '7 days', null), 0);
select pg_temp.check('and it is purged once past it',
  app.purge_expired(interval '0 days', null), 1);
select pg_temp.check('purging took its data with it',
  (select count(*)::int from public.form_submissions where tenant_id = current_setting('t.a')::uuid), 0);

-- =====================================================================
-- 6. Password reset
-- =====================================================================
select pg_temp.check('reset names the account it changed',
  (select username from app.reset_demo_password(current_setting('t.b')::uuid, 'new-hash', null)), 'prov.b'::text);
select pg_temp.check('and moves the password timestamp',
  (select count(*)::int from public.app_users
    where tenant_id = current_setting('t.b')::uuid
      and password_changed_at > now() - interval '1 minute'), 1);

-- =====================================================================
-- 7. The template is untouched by all of it
-- =====================================================================
select pg_temp.check('the template still has its submissions',
  (select count(*)::int from public.form_submissions where tenant_id = current_setting('t.tpl')::uuid), 4);
select pg_temp.check('the staff trail outlives the purged evaluation',
  (select count(*)::int from public.staff_audit
    where kind = 'tenant.purge' and tenant_ref = current_setting('s.a')), 1);

delete from public.tenants where kind = 'demo' and name like 'Prov Test%';
do $$ begin raise notice 'ALL PROVISIONING TESTS PASSED'; end $$;
