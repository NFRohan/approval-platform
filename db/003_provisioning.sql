-- =====================================================================
-- Provisioning — minting, extending, revoking and purging evaluations.
--
-- These run as SECURITY DEFINER because they read one tenant and write
-- another in a single call, which no ordinary caller may do. Each one
-- checks app.is_staff() first, so the privilege is not a back door.
--
-- The clone is the interesting part. Two things make it tractable:
--
--   employee_id is TEXT and unique per tenant, so all 14 columns that
--   reference an employee copy across unchanged. Only uuid keys are
--   remapped.
--
--   Every remapped id goes into one temporary map, keyed by the old
--   uuid. uuids do not collide across tables, so a single map serves all
--   of them — including activity_log.entity_id, which is an untyped
--   pointer at whatever the entry describes and could not otherwise be
--   followed after a clone.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
create or replace function app.slugify(p_text text) returns text
language sql immutable as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'))
$$;

create or replace function app.require_staff() returns void
language plpgsql stable as $$
begin
  if not app.is_staff() then
    raise exception 'staff only'
      using errcode = 'insufficient_privilege';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- tenant_status — the single answer the login path checks, so no caller
-- can forget one of the conditions.
-- ---------------------------------------------------------------------
create or replace function app.tenant_status(p_tenant uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
           when t.id is null                                      then 'missing'
           when t.revoked_at is not null                          then 'revoked'
           when t.expires_at is not null and t.expires_at < now() then 'expired'
           else 'active'
         end
    from (select 1) dummy
    left join public.tenants t on t.id = p_tenant
$$;

-- =====================================================================
-- provision_demo — a new sandbox, cloned whole from the template.
-- =====================================================================
create or replace function app.provision_demo(
  p_name     text,
  p_username text,
  p_hash     text,
  p_ttl      interval default interval '3 days',
  p_actor    uuid default null,
  p_notes    text default null
) returns table (tenant_id uuid, slug text, username text, expires_at timestamptz)
language plpgsql security definer set search_path = public, app, pg_temp as $$
-- The OUT columns are named tenant_id, slug, username and expires_at for
-- the caller's benefit, and the body reads columns of those names on
-- nearly every table. Resolve such a clash to the column: the OUT values
-- are only ever written, through the local variables below.
#variable_conflict use_column
declare
  v_tpl  uuid;
  v_new  uuid;
  v_slug text;
  v_exp  timestamptz;
begin
  perform app.require_staff();

  if exists (select 1 from public.app_users u where lower(u.username) = lower(p_username)) then
    raise exception 'username % is already taken', p_username
      using errcode = 'unique_violation';
  end if;

  select id into v_tpl from public.tenants where kind = 'template' limit 1;
  if v_tpl is null then
    raise exception 'no template tenant — run 004_seed_template.sql first';
  end if;

  v_slug := left(app.slugify(p_name), 40);
  v_exp  := now() + p_ttl;

  insert into public.tenants (name, slug, kind, expires_at, notes, created_by)
  values (p_name, v_slug || '-' || substr(gen_random_uuid()::text, 1, 6), 'demo', v_exp, p_notes, p_actor)
  returning id, tenants.slug into v_new, v_slug;

  insert into public.app_users (tenant_id, username, password_hash, full_name, role)
  values (v_new, p_username, p_hash, p_name || ' (evaluator)', 'admin');

  -- -------------------------------------------------------------------
  -- One map for the whole clone: old uuid -> new uuid.
  -- -------------------------------------------------------------------
  create temp table if not exists _m (old uuid primary key, new uuid not null) on commit drop;
  delete from _m;

  -- employees: employee_id copies across unchanged, which is what lets
  -- every text reference to a person survive without remapping.
  insert into _m select id, gen_random_uuid() from public.employees where tenant_id = v_tpl;
  insert into public.employees (id, tenant_id, employee_id, name, designation, department, line_manager_id, gate_pass_card_number)
  select m.new, v_new, e.employee_id, e.name, e.designation, e.department, e.line_manager_id, e.gate_pass_card_number
    from public.employees e join _m m on m.old = e.id
   where e.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.form_templates where tenant_id = v_tpl;
  insert into public.form_templates (id, tenant_id, name, category, created_by, status, created_at)
  select m.new, v_new, t.name, t.category, t.created_by, t.status, t.created_at
    from public.form_templates t join _m m on m.old = t.id
   where t.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.form_fields where tenant_id = v_tpl;
  insert into public.form_fields (id, tenant_id, form_template_id, field_type, field_name, field_config, order_index, is_required)
  select m.new, v_new, mt.new, f.field_type, f.field_name, f.field_config, f.order_index, f.is_required
    from public.form_fields f
    join _m m  on m.old  = f.id
    join _m mt on mt.old = f.form_template_id
   where f.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.approval_rules where tenant_id = v_tpl;
  insert into public.approval_rules (id, tenant_id, form_template_id, approver_user_id, deadline_days, is_auto_added, label, step_index)
  select m.new, v_new, mt.new, r.approver_user_id, r.deadline_days, r.is_auto_added, r.label, r.step_index
    from public.approval_rules r
    join _m m  on m.old  = r.id
    join _m mt on mt.old = r.form_template_id
   where r.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.approval_slabs where tenant_id = v_tpl;
  insert into public.approval_slabs (id, tenant_id, form_template_id, min_amount, max_amount, approver_user_id, order_index)
  select m.new, v_new, mt.new, s.min_amount, s.max_amount, s.approver_user_id, s.order_index
    from public.approval_slabs s
    join _m m  on m.old  = s.id
    join _m mt on mt.old = s.form_template_id
   where s.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.notification_rules where tenant_id = v_tpl;
  insert into public.notification_rules (id, tenant_id, form_template_id, notifyee_user_id, is_auto_added, label)
  select m.new, v_new, mt.new, n.notifyee_user_id, n.is_auto_added, n.label
    from public.notification_rules n
    join _m m  on m.old  = n.id
    join _m mt on mt.old = n.form_template_id
   where n.tenant_id = v_tpl;

  -- form_template_ids is an ARRAY of uuids, so it is remapped element by
  -- element rather than by a join.
  insert into _m select id, gen_random_uuid() from public.delegation_rules where tenant_id = v_tpl;
  insert into public.delegation_rules (id, tenant_id, delegator_id, delegate_id, start_date, end_date, reason, form_template_ids, created_at)
  select m.new, v_new, d.delegator_id, d.delegate_id, d.start_date, d.end_date, d.reason,
         case when d.form_template_ids is null then null
              else (select array_agg(mm.new order by mm.new)
                      from unnest(d.form_template_ids) x join _m mm on mm.old = x) end,
         d.created_at
    from public.delegation_rules d join _m m on m.old = d.id
   where d.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.form_submissions where tenant_id = v_tpl;
  insert into public.form_submissions (id, tenant_id, form_template_id, submitted_by, status, submitted_at)
  select m.new, v_new, mt.new, s.submitted_by, s.status, s.submitted_at
    from public.form_submissions s
    join _m m  on m.old  = s.id
    join _m mt on mt.old = s.form_template_id
   where s.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.submission_values where tenant_id = v_tpl;
  insert into public.submission_values (id, tenant_id, submission_id, field_name, value)
  select m.new, v_new, ms.new, v.field_name, v.value
    from public.submission_values v
    join _m m  on m.old  = v.id
    join _m ms on ms.old = v.submission_id
   where v.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.items where tenant_id = v_tpl;
  insert into public.items (id, tenant_id, name, type)
  select m.new, v_new, i.name, i.type
    from public.items i join _m m on m.old = i.id where i.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.venues where tenant_id = v_tpl;
  insert into public.venues (id, tenant_id, name, floor)
  select m.new, v_new, v.name, v.floor
    from public.venues v join _m m on m.old = v.id where v.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.item_stock where tenant_id = v_tpl;
  insert into public.item_stock (id, tenant_id, item_id, venue_id, quantity, reserved_quantity)
  select m.new, v_new, mi.new, mv.new, s.quantity, s.reserved_quantity
    from public.item_stock s
    join _m m  on m.old  = s.id
    join _m mi on mi.old = s.item_id
    join _m mv on mv.old = s.venue_id
   where s.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.movement_orders where tenant_id = v_tpl;
  insert into public.movement_orders (id, tenant_id, ref_number, requester_id, item_name, item_type, quantity,
                                      source_location, destination_location, justification, preferred_time,
                                      assigned_mover_id, status, admin_comment, item_id, source_venue_id,
                                      destination_venue_id, created_at, updated_at)
  select m.new, v_new, o.ref_number, o.requester_id, o.item_name, o.item_type, o.quantity,
         o.source_location, o.destination_location, o.justification, o.preferred_time,
         o.assigned_mover_id, o.status, o.admin_comment,
         mi.new, msv.new, mdv.new, o.created_at, o.updated_at
    from public.movement_orders o
    join _m m on m.old = o.id
    left join _m mi  on mi.old  = o.item_id
    left join _m msv on msv.old = o.source_venue_id
    left join _m mdv on mdv.old = o.destination_venue_id
   where o.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.notices where tenant_id = v_tpl;
  insert into public.notices (id, tenant_id, title, content, category, status, created_by, current_approver_id, created_at, updated_at)
  select m.new, v_new, n.title, n.content, n.category, n.status, n.created_by, n.current_approver_id, n.created_at, n.updated_at
    from public.notices n join _m m on m.old = n.id where n.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.notice_comments where tenant_id = v_tpl;
  insert into public.notice_comments (id, tenant_id, notice_id, author_id, text, created_at)
  select m.new, v_new, mn.new, c.author_id, c.text, c.created_at
    from public.notice_comments c
    join _m m  on m.old  = c.id
    join _m mn on mn.old = c.notice_id
   where c.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.stationery_requests where tenant_id = v_tpl;
  insert into public.stationery_requests (id, tenant_id, kind, requester_id, name, designation, department, division,
                                          email, contact_number, reason, comments, status, current_approver_id, created_at, updated_at)
  select m.new, v_new, s.kind, s.requester_id, s.name, s.designation, s.department, s.division,
         s.email, s.contact_number, s.reason, s.comments, s.status, s.current_approver_id, s.created_at, s.updated_at
    from public.stationery_requests s join _m m on m.old = s.id where s.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.maintenance_items where tenant_id = v_tpl;
  insert into public.maintenance_items (id, tenant_id, name, category)
  select m.new, v_new, i.name, i.category
    from public.maintenance_items i join _m m on m.old = i.id where i.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.maintenance_requests where tenant_id = v_tpl;
  insert into public.maintenance_requests (id, tenant_id, ref_number, requester_id, location, status, assigned_to, admin_comment, created_at, updated_at)
  select m.new, v_new, r.ref_number, r.requester_id, r.location, r.status, r.assigned_to, r.admin_comment, r.created_at, r.updated_at
    from public.maintenance_requests r join _m m on m.old = r.id where r.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.maintenance_request_items where tenant_id = v_tpl;
  insert into public.maintenance_request_items (id, tenant_id, request_id, item_id, description, quantity)
  select m.new, v_new, mr.new, mi.new, ri.description, ri.quantity
    from public.maintenance_request_items ri
    join _m m  on m.old  = ri.id
    join _m mr on mr.old = ri.request_id
    left join _m mi on mi.old = ri.item_id
   where ri.tenant_id = v_tpl;

  -- Cloned last, because a step can hang off any of four subjects and
  -- all of them must already be in the map. Each subject is joined
  -- outward: exactly one is set on any given row, so the other three
  -- resolve to null and the arc is preserved on the far side.
  insert into _m select id, gen_random_uuid() from public.approval_requests where tenant_id = v_tpl;
  insert into public.approval_requests (id, tenant_id, submission_id, notice_id, stationery_request_id, maintenance_request_id, approver_user_id, step_index, status, comment, acted_at, deadline_at, reassigned_from, created_at)
  select m.new, v_new, ms.new, mn.new, mst.new, mmr.new, a.approver_user_id, a.step_index, a.status, a.comment, a.acted_at, a.deadline_at, a.reassigned_from, a.created_at
    from public.approval_requests a
    join      _m m   on m.old   = a.id
    left join _m ms  on ms.old  = a.submission_id
    left join _m mn  on mn.old  = a.notice_id
    left join _m mst on mst.old = a.stationery_request_id
    left join _m mmr on mmr.old = a.maintenance_request_id
   where a.tenant_id = v_tpl;

  -- entity_id is an untyped pointer at whatever the entry describes, so
  -- it is resolved through the same map. Anything not found keeps its
  -- original value rather than being dropped.
  insert into public.activity_log (id, tenant_id, actor_id, action, entity_type, entity_id, detail, created_at)
  select gen_random_uuid(), v_new, a.actor_id, a.action, a.entity_type,
         coalesce(mm.new, a.entity_id), a.detail, a.created_at
    from public.activity_log a
    left join _m mm on mm.old = a.entity_id
   where a.tenant_id = v_tpl;

  insert into public.notifications (id, tenant_id, recipient_id, kind, title, body, entity_type, entity_id, read_at, created_at)
  select gen_random_uuid(), v_new, n.recipient_id, n.kind, n.title, n.body, n.entity_type,
         coalesce(mm.new, n.entity_id), n.read_at, n.created_at
    from public.notifications n
    left join _m mm on mm.old = n.entity_id
   where n.tenant_id = v_tpl;

  insert into public.staff_audit (actor_id, kind, tenant_ref, detail, meta)
  values (p_actor, 'tenant.mint', v_slug,
          format('Minted %s for %s, expires %s', p_username, p_name, v_exp),
          jsonb_build_object('tenant_id', v_new, 'username', p_username));

  return query select v_new, v_slug, p_username, v_exp;
end $$;

-- =====================================================================
-- extend_demo — push the expiry out, and clear any revocation.
-- =====================================================================
create or replace function app.extend_demo(p_tenant uuid, p_extra interval, p_actor uuid default null)
returns timestamptz
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare v_new timestamptz; v_slug text;
begin
  perform app.require_staff();

  update public.tenants
     set expires_at = greatest(expires_at, now()) + p_extra,
         revoked_at = null
   where id = p_tenant and kind = 'demo'
  returning expires_at, slug into v_new, v_slug;

  if v_new is null then
    raise exception 'no demo tenant with id %', p_tenant;
  end if;

  -- Revoking disables the accounts; extending is the decision to restore
  -- them, so it must undo both halves.
  update public.app_users set status = 'active'
   where tenant_id = p_tenant and status = 'disabled';

  insert into public.staff_audit (actor_id, kind, tenant_ref, detail, meta)
  values (p_actor, 'tenant.extend', v_slug,
          format('Extended by %s, now expires %s', p_extra, v_new),
          jsonb_build_object('tenant_id', p_tenant));
  return v_new;
end $$;

-- =====================================================================
-- revoke_demo — cut access now, keep the data. The reversible one.
-- =====================================================================
create or replace function app.revoke_demo(p_tenant uuid, p_actor uuid default null)
returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare v_slug text;
begin
  perform app.require_staff();

  update public.tenants set revoked_at = now()
   where id = p_tenant and kind = 'demo'
  returning slug into v_slug;

  if v_slug is null then
    raise exception 'no demo tenant with id %', p_tenant;
  end if;

  update public.app_users set status = 'disabled' where tenant_id = p_tenant;

  insert into public.staff_audit (actor_id, kind, tenant_ref, detail, meta)
  values (p_actor, 'tenant.revoke', v_slug, 'Access revoked',
          jsonb_build_object('tenant_id', p_tenant));
end $$;

-- =====================================================================
-- purge_expired — hard delete, past the grace period. Irreversible, so
-- it is never implicit: staff ask for it.
-- =====================================================================
create or replace function app.purge_expired(p_grace interval default interval '7 days',
                                             p_actor uuid default null)
returns int
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare r record; n int := 0;
begin
  perform app.require_staff();

  for r in
    select id, slug from public.tenants
     where kind = 'demo'
       and (   (expires_at is not null and expires_at < now() - p_grace)
            or (revoked_at is not null and revoked_at < now() - p_grace))
  loop
    delete from public.tenants where id = r.id;
    insert into public.staff_audit (actor_id, kind, tenant_ref, detail)
    values (p_actor, 'tenant.purge', r.slug, 'Purged after grace period');
    n := n + 1;
  end loop;
  return n;
end $$;

-- =====================================================================
-- reset_demo_password — the prospect lost their credential. Nothing is
-- recoverable: the password is a hash, deliberately.
-- =====================================================================
create or replace function app.reset_demo_password(p_tenant uuid, p_hash text, p_actor uuid default null)
returns table (username text, tenant_status text)
language plpgsql security definer set search_path = public, app, pg_temp as $$
#variable_conflict use_column
declare v_user uuid; v_name text; v_slug text;
begin
  perform app.require_staff();

  select slug into v_slug from public.tenants where id = p_tenant and kind = 'demo';
  if v_slug is null then
    raise exception 'no demo tenant with id %', p_tenant;
  end if;

  select u.id, u.username into v_user, v_name
    from public.app_users u
   where u.tenant_id = p_tenant order by u.created_at limit 1;

  if v_user is null then
    raise exception 'tenant % has no account to reset', v_slug;
  end if;

  update public.app_users
     set password_hash = p_hash, password_changed_at = now(), must_change_pw = false
   where id = v_user;

  insert into public.staff_audit (actor_id, kind, tenant_ref, detail, meta)
  values (p_actor, 'tenant.password_reset', v_slug,
          format('New password issued for %s', v_name),
          jsonb_build_object('tenant_id', p_tenant, 'username', v_name));

  return query select v_name, app.tenant_status(p_tenant);
end $$;

grant execute on all functions in schema app to app_api;

commit;
