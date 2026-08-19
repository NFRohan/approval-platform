-- =====================================================================
-- Row level security
--
-- What this replaces: 43 policy clauses, every one of them `USING (true)`,
-- generated in a loop for read, insert, update and delete alike. Security
-- was switched on and permitted everything, which is worse than switching
-- it off — it reads as protection.
--
-- The API is the first enforcement point: it resolves the tenant from a
-- verified token and never takes it from the client. These policies are
-- the second and independent one, so a handler that forgets a filter
-- returns nothing rather than everything.
--
-- Per request the API sets:
--   app.tenant_id, app.user_id, app.role, app.is_staff
-- Anything unset resolves to NULL, and `tenant_id = NULL` is never true.
--
-- This application has no anonymous surface. Every screen sits behind the
-- shell, and the certificate's QR code points at an in-app route rather
-- than a public verification page. So unlike a public-facing product,
-- every policy here requires a signed-in member — there is no case to
-- carve out.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- The API's database role. It must not own the tables, or it would
-- bypass RLS; FORCE below closes that door even if ownership changes.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    create role app_api nologin;
  end if;
end $$;

grant usage on schema public, app to app_api;

-- The API drops to this role per transaction (`set local role app_api`),
-- so whoever it connects as must be a member of it.
do $$
begin
  execute format('grant app_api to %I', current_user);
exception when others then
  null;  -- already a member, or a superuser (implicit)
end $$;

-- Is this caller a signed-in member of the tenant they claim?
--
-- One predicate, used by every data policy. The demo issues one login per
-- prospect and lets it switch between personas, so there is no
-- distinction to draw between members: role columns exist on app_users
-- but would be theatre here, and pretending otherwise would be the same
-- mistake as `USING (true)` in the other direction.
create or replace function app.is_member() returns boolean
language sql stable as $$
  select app.current_tenant() is not null
     and app.current_user_id() is not null
$$;

grant execute on all functions in schema app to app_api;

-- ---------------------------------------------------------------------
-- enable + force everywhere
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
  end loop;
end $$;

grant select, insert, update, delete on all tables in schema public to app_api;
grant usage, select on all sequences in schema public to app_api;

-- =====================================================================
-- tenants — staff manage every one; a member may read only its own row,
-- which is where the expiry banner comes from.
-- =====================================================================
drop policy if exists tenants_staff_all on public.tenants;
create policy tenants_staff_all on public.tenants
  for all to app_api
  using (app.is_staff()) with check (app.is_staff());

drop policy if exists tenants_read_own on public.tenants;
create policy tenants_read_own on public.tenants
  for select to app_api
  using (id = app.current_tenant() and app.current_user_id() is not null);

-- =====================================================================
-- app_users — staff mint them; a member may read its own tenant's
-- accounts. Signed-in only: `tenant_id = current_tenant()` alone would
-- expose the login usernames to anyone the API had placed in a tenant
-- context for any reason.
-- =====================================================================
drop policy if exists app_users_staff_all on public.app_users;
create policy app_users_staff_all on public.app_users
  for all to app_api
  using (app.is_staff()) with check (app.is_staff());

drop policy if exists app_users_read_tenant on public.app_users;
create policy app_users_read_tenant on public.app_users
  for select to app_api
  using (tenant_id = app.current_tenant() and app.current_user_id() is not null);

-- =====================================================================
-- staff_audit — staff only, and append-only. Deliberately no delete
-- policy: a trail the audited party can prune is not a trail.
-- =====================================================================
drop policy if exists staff_audit_read on public.staff_audit;
create policy staff_audit_read on public.staff_audit
  for select to app_api using (app.is_staff());

drop policy if exists staff_audit_insert on public.staff_audit;
create policy staff_audit_insert on public.staff_audit
  for insert to app_api with check (app.is_staff());

-- =====================================================================
-- Everything else — the demo's own data.
--
-- Generated in a loop, as before, because 22 tables genuinely share one
-- rule. The difference is the rule.
-- =====================================================================
do $$
declare
  t text;
  data_tables text[] := array[
    'employees','form_templates','form_fields','approval_rules','approval_slabs',
    'notification_rules','delegation_rules','form_submissions','submission_values',
    'approval_requests','items','venues','item_stock','movement_orders',
    'notices','notice_comments','stationery_requests','maintenance_items',
    'maintenance_requests','maintenance_request_items','activity_log','notifications'
  ];
begin
  foreach t in array data_tables loop
    execute format('drop policy if exists %1$s_member_read on public.%1$I', t);
    execute format($f$
      create policy %1$s_member_read on public.%1$I
        for select to app_api
        using (tenant_id = app.current_tenant() and app.is_member())
    $f$, t);

    execute format('drop policy if exists %1$s_member_write on public.%1$I', t);

    -- activity_log is append-only: a prospect's own audit trail, and a
    -- trail the audited party can rewrite is not a trail. It gets an
    -- insert policy below instead of the general write policy, which is
    -- why it is skipped rather than granted and then overridden.
    if t <> 'activity_log' then
      execute format($f$
        create policy %1$s_member_write on public.%1$I
          for all to app_api
          using (tenant_id = app.current_tenant() and app.is_member())
          with check (tenant_id = app.current_tenant() and app.is_member())
      $f$, t);
    end if;
  end loop;
end $$;

drop policy if exists activity_log_member_insert on public.activity_log;
create policy activity_log_member_insert on public.activity_log
  for insert to app_api
  with check (tenant_id = app.current_tenant() and app.is_member());

commit;
