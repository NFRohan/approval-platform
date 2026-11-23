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
-- ---------------------------------------------------------------------
-- Is this evaluation still live, right now?
--
-- tenant_status was only ever consulted at sign-in, which made revoke
-- and expiry advisory for the life of a token: a withdrawn prospect
-- kept full read and write for up to twelve hours. This runs in the
-- session preamble of every request instead, so withdrawing takes
-- effect on the next click rather than the next login.
--
-- Fails closed. If row-level security hides the tenant row the status
-- comes back null, and null is not active.
-- ---------------------------------------------------------------------
create or replace function app.assert_tenant_live() returns void
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_state text;
begin
  -- Staff hold no tenant, so there is nothing to expire.
  if app.current_tenant() is null then
    return;
  end if;

  v_state := app.tenant_status(app.current_tenant());

  if coalesce(v_state, 'unknown') <> 'active' then
    raise exception 'this evaluation is %', coalesce(v_state, 'not available')
      using errcode = '28000';
  end if;
end $$;

grant execute on function app.assert_tenant_live() to app_api;

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
    raise exception 'no template tenant — run 010_seed_template.sql first';
  end if;

  v_slug := left(app.slugify(p_name), 40);
  v_exp  := now() + p_ttl;

  -- An evaluation's settings start as the template's: its login switches
  -- between personas, starting as the template's default one.
  -- Cloning copies notifications; none of them is to be emailed again.
  perform set_config('app.no_mail', 'true', true);

  insert into public.tenants (name, slug, kind, expires_at, notes, created_by,
                              persona_switching, require_admin_mfa, default_persona, history_seeded,
                              inbound_domains, inbound_poc, inbound_form, campaigns_seeded,
                              retention_years, archive_after_months, purge_logs_after_months, holidays_seeded)
  select p_name, v_slug || '-' || substr(gen_random_uuid()::text, 1, 6), 'demo', v_exp, p_notes, p_actor,
         t.persona_switching, t.require_admin_mfa, t.default_persona, t.history_seeded,
         t.inbound_domains, t.inbound_poc, t.inbound_form, t.campaigns_seeded,
         t.retention_years, t.archive_after_months, t.purge_logs_after_months, t.holidays_seeded
    from public.tenants t where t.id = v_tpl
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
  insert into public.employees (id, tenant_id, employee_id, name, designation, department, line_manager_id, gate_pass_card_number, active, left_on, email)
  select m.new, v_new, e.employee_id, e.name, e.designation, e.department, e.line_manager_id, e.gate_pass_card_number, e.active, e.left_on, e.email
    from public.employees e join _m m on m.old = e.id
   where e.tenant_id = v_tpl;

  -- Who heads each department, its HRBP and CXO: the org roles rules
  -- can name.
  -- Roles and who holds them: what each persona may do.
  insert into _m select id, gen_random_uuid() from public.roles where tenant_id = v_tpl;
  insert into public.roles (id, tenant_id, name, description, permissions, status, created_by, approved_by, created_at, updated_at)
  select m.new, v_new, r.name, r.description, r.permissions, r.status, r.created_by, r.approved_by, r.created_at, r.updated_at
    from public.roles r join _m m on m.old = r.id
   where r.tenant_id = v_tpl;
  insert into public.employee_roles (tenant_id, employee_id, role_id, assigned_by, created_at)
  select v_new, er.employee_id, m.new, er.assigned_by, er.created_at
    from public.employee_roles er join _m m on m.old = er.role_id
   where er.tenant_id = v_tpl;

  -- Report templates and the organisation's email wording.
  insert into public.report_templates (tenant_id, name, description, dataset, columns, filters, standard,
                                       schedule, recipients, format, created_by, updated_by, approved_by, created_at, updated_at)
  select v_new, rt.name, rt.description, rt.dataset, rt.columns, rt.filters, rt.standard,
         rt.schedule, rt.recipients, rt.format, rt.created_by, rt.updated_by, rt.approved_by, rt.created_at, rt.updated_at
    from public.report_templates rt where rt.tenant_id = v_tpl;
  insert into public.email_templates (tenant_id, kind, subject, body, enabled, updated_by, updated_at)
  select v_new, et.kind, et.subject, et.body, et.enabled, et.updated_by, et.updated_at
    from public.email_templates et where et.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.departments where tenant_id = v_tpl;
  insert into public.departments (id, tenant_id, name, head_employee_id, hrbp_employee_id, cxo_employee_id, created_at)
  select m.new, v_new, d.name, d.head_employee_id, d.hrbp_employee_id, d.cxo_employee_id, d.created_at
    from public.departments d join _m m on m.old = d.id
   where d.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.form_templates where tenant_id = v_tpl;
  insert into public.form_templates (id, tenant_id, name, category, created_by, status, created_at,
                                     audience_departments, classification, keywords, on_approval)
  select m.new, v_new, t.name, t.category, t.created_by, t.status, t.created_at,
         t.audience_departments, t.classification, t.keywords, t.on_approval
    from public.form_templates t join _m m on m.old = t.id
   where t.tenant_id = v_tpl;

  -- A follow-up points at another template, so it is set once every
  -- template has its new id.
  update public.form_templates nt
     set followup_template_id = mf.new
    from public.form_templates t
    join _m m  on m.old  = t.id
    join _m mf on mf.old = t.followup_template_id
   where t.tenant_id = v_tpl and nt.id = m.new;

  insert into _m select id, gen_random_uuid() from public.form_fields where tenant_id = v_tpl;
  insert into public.form_fields (id, tenant_id, form_template_id, field_type, field_name, field_config, order_index, is_required)
  select m.new, v_new, mt.new, f.field_type, f.field_name, f.field_config, f.order_index, f.is_required
    from public.form_fields f
    join _m m  on m.old  = f.id
    join _m mt on mt.old = f.form_template_id
   where f.tenant_id = v_tpl;

  insert into _m select id, gen_random_uuid() from public.approval_rules where tenant_id = v_tpl;
  -- Rules for notices and service requests have no template, so the
  -- template join is a left one.
  insert into public.approval_rules (id, tenant_id, subject_type, form_template_id, approver_user_id, deadline_days,
                                     is_auto_added, label, step_index, quorum, condition, stage_label, lane, position,
                                     require_signature, flag)
  select m.new, v_new, r.subject_type, mt.new, r.approver_user_id, r.deadline_days,
         r.is_auto_added, r.label, r.step_index, r.quorum, r.condition, r.stage_label, r.lane, r.position,
         r.require_signature, r.flag
    from public.approval_rules r
    join _m m  on m.old  = r.id
    left join _m mt on mt.old = r.form_template_id
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
  -- References copy across as they are, and so does the counter behind
  -- them, so the next request raised in the evaluation follows on.
  insert into public.tenant_counters (tenant_id, name, value)
  select v_new, c.name, c.value from public.tenant_counters c where c.tenant_id = v_tpl;

  insert into public.form_submissions (id, tenant_id, form_template_id, submitted_by, status, submitted_at,
                                       ref_number, priority, flag, archived_at, legacy_ref, legacy_source, closed_at)
  select m.new, v_new, mt.new, s.submitted_by, s.status, s.submitted_at,
         s.ref_number, s.priority, s.flag, s.archived_at, s.legacy_ref, s.legacy_source, s.closed_at
    from public.form_submissions s
    join _m m  on m.old  = s.id
    join _m mt on mt.old = s.form_template_id
   where s.tenant_id = v_tpl;

  update public.form_submissions ns
     set parent_submission_id = mp.new
    from public.form_submissions s
    join _m m  on m.old  = s.id
    join _m mp on mp.old = s.parent_submission_id
   where s.tenant_id = v_tpl and ns.id = m.new;

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
  insert into public.approval_requests (id, tenant_id, submission_id, notice_id, stationery_request_id, maintenance_request_id, approver_user_id, step_index, lane, lane_step, lane_label, quorum, stage_label, require_signature, signature, signed_at, status, comment, acted_at, deadline_at, reassigned_from, created_at, opened_at)
  select m.new, v_new, ms.new, mn.new, mst.new, mmr.new, a.approver_user_id, a.step_index, a.lane, a.lane_step, a.lane_label, a.quorum, a.stage_label, a.require_signature, a.signature, a.signed_at, a.status, a.comment, a.acted_at, a.deadline_at, a.reassigned_from, a.created_at, a.opened_at
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
  -- The chain's history, the questions asked on it, and the ticket's own
  -- links, copies, notes and documents.
  insert into public.approval_events (id, tenant_id, request_id, subject_type, subject_id, actor_id, action, comment, target_id, created_at)
  select gen_random_uuid(), v_new, mr.new, e.subject_type, coalesce(ms.new, e.subject_id),
         e.actor_id, e.action, e.comment, e.target_id, e.created_at
    from public.approval_events e
    left join _m mr on mr.old = e.request_id
    left join _m ms on ms.old = e.subject_id
   where e.tenant_id = v_tpl;

  insert into public.approval_queries (id, tenant_id, subject_type, subject_id, asked_by, asked_to, question, answer, answered_at, created_at)
  select gen_random_uuid(), v_new, q.subject_type, coalesce(ms.new, q.subject_id),
         q.asked_by, q.asked_to, q.question, q.answer, q.answered_at, q.created_at
    from public.approval_queries q
    left join _m ms on ms.old = q.subject_id
   where q.tenant_id = v_tpl;

  insert into public.submission_links (id, tenant_id, from_id, to_id, note, created_by, created_at)
  select gen_random_uuid(), v_new, mf.new, mt.new, l.note, l.created_by, l.created_at
    from public.submission_links l
    join _m mf on mf.old = l.from_id
    join _m mt on mt.old = l.to_id
   where l.tenant_id = v_tpl;

  insert into public.submission_cc (id, tenant_id, submission_id, employee_id, added_by, created_at)
  select gen_random_uuid(), v_new, ms.new, c.employee_id, c.added_by, c.created_at
    from public.submission_cc c join _m ms on ms.old = c.submission_id
   where c.tenant_id = v_tpl;

  insert into public.ticket_notes (id, tenant_id, submission_id, author_id, body, created_at)
  select gen_random_uuid(), v_new, ms.new, n.author_id, n.body, n.created_at
    from public.ticket_notes n join _m ms on ms.old = n.submission_id
   where n.tenant_id = v_tpl;

  insert into public.attachments (id, tenant_id, submission_id, field_name, file_name, content_type, size_bytes,
                                  data, uploaded_by, created_at, description, tags, version, superseded_at)
  select gen_random_uuid(), v_new, ms.new, a.field_name, a.file_name, a.content_type, a.size_bytes,
         a.data, a.uploaded_by, a.created_at, a.description, a.tags, a.version, a.superseded_at
    from public.attachments a join _m ms on ms.old = a.submission_id
   where a.tenant_id = v_tpl;

  -- Campaigns, with what has been spent on them, their coupons and
  -- their extensions.
  insert into _m select id, gen_random_uuid() from public.campaigns where tenant_id = v_tpl;
  insert into public.campaigns (id, tenant_id, submission_id, request_id, name, audience, modality, coupon, exceptional,
                                status, starts_on, ends_on, budget, kpi, wallets, cost_center, gl_code, product, beneficiary,
                                requester_id, reviewer_id, alerted, status_note, created_at, updated_at)
  select m.new, v_new, ms.new, mr.new, c.name, c.audience, c.modality, c.coupon, c.exceptional,
         c.status, c.starts_on, c.ends_on, c.budget, c.kpi, c.wallets, c.cost_center, c.gl_code, c.product, c.beneficiary,
         c.requester_id, c.reviewer_id, c.alerted, c.status_note, c.created_at, c.updated_at
    from public.campaigns c
    join _m m on m.old = c.id
    left join _m ms on ms.old = c.submission_id
    left join _m mr on mr.old = c.request_id
   where c.tenant_id = v_tpl;
  insert into public.campaign_actuals (tenant_id, campaign_id, on_date, cost, beneficiaries, transactions, volume, note, recorded_by, created_at)
  select v_new, m.new, a.on_date, a.cost, a.beneficiaries, a.transactions, a.volume, a.note, a.recorded_by, a.created_at
    from public.campaign_actuals a join _m m on m.old = a.campaign_id where a.tenant_id = v_tpl;
  insert into public.campaign_coupons (tenant_id, campaign_id, code, wallet, amount, issued_at, redeemed_at, redeemed_via, created_at)
  select v_new, m.new, k.code, k.wallet, k.amount, k.issued_at, k.redeemed_at, k.redeemed_via, k.created_at
    from public.campaign_coupons k join _m m on m.old = k.campaign_id where k.tenant_id = v_tpl;
  insert into public.campaign_extensions (tenant_id, campaign_id, submission_id, new_ends_on, added_budget, business_case,
                                          status, requested_by, decided_at, created_at)
  select v_new, m.new, ms.new, x.new_ends_on, x.added_budget, x.business_case, x.status, x.requested_by, x.decided_at, x.created_at
    from public.campaign_extensions x join _m m on m.old = x.campaign_id
    left join _m ms on ms.old = x.submission_id
   where x.tenant_id = v_tpl;

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

  -- The working calendar, with any days the template's administrators
  -- have moved.
  insert into public.holidays (tenant_id, on_date, name, kind, provisional, created_by, created_at, moved_from)
  select v_new, h.on_date, h.name, h.kind, h.provisional, h.created_by, h.created_at, h.moved_from
    from public.holidays h where h.tenant_id = v_tpl;

  -- Its own API keys, webhook and their history: keys are never shared
  -- between organisations, so these are made rather than copied.
  perform app.seed_integration(v_new);

  -- Mail goes out again for whatever this transaction does next.
  perform set_config('app.no_mail', 'false', true);
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
--
-- p_only narrows it to a single evaluation. Sweeping every expired demo
-- is the point when staff run it by hand, but it is the wrong default
-- for anything automated — the test suite used to call this unscoped
-- and assert it returned exactly 1, which both broke whenever a real
-- lapsed evaluation existed and, on the runs where it passed, deleted
-- that evaluation for good.
-- =====================================================================
create or replace function app.purge_expired(p_grace interval default interval '7 days',
                                             p_actor uuid default null,
                                             p_only uuid default null)
returns int
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare r record; n int := 0;
begin
  perform app.require_staff();

  for r in
    select id, slug from public.tenants
     where kind = 'demo'
       and (p_only is null or id = p_only)
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

-- ---------------------------------------------------------------------
-- Repair evaluations minted before the clone copied every rule.
--
-- The clone joined approval rules to templates and copied no subject
-- type, so rules for notices, stationery and maintenance — which have no
-- template — never arrived, and anything of those kinds raised in an
-- evaluation was routed to nobody. Each such evaluation gets the
-- template's rules for the kinds it has none of. Re-running finds
-- nothing missing and adds nothing.
-- ---------------------------------------------------------------------
insert into public.approval_rules
  (tenant_id, subject_type, form_template_id, approver_user_id, deadline_days,
   is_auto_added, label, step_index, quorum, condition, stage_label, lane, position)
select d.id, r.subject_type, null, r.approver_user_id, r.deadline_days,
       r.is_auto_added, r.label, r.step_index, r.quorum, r.condition, r.stage_label, r.lane, r.position
  from public.tenants d
  join public.tenants tpl on tpl.kind = 'template'
  join public.approval_rules r on r.tenant_id = tpl.id and r.subject_type <> 'form_submission'
 where d.kind = 'demo'
   and not exists (select 1 from public.approval_rules x
                    where x.tenant_id = d.id and x.subject_type = r.subject_type)
   -- every approver named must exist in the evaluation
   and (r.approver_user_id is null
        or exists (select 1 from public.employees e
                    where e.tenant_id = d.id and e.employee_id = r.approver_user_id));

grant execute on all functions in schema app to app_api;

commit;
