-- =====================================================================
-- Commercial campaigns, divisions, and mail to ticket.
--
--   * An approved campaign NFA becomes a tracked campaign: its KPI
--     targets and reporting details as approved, actuals recorded
--     against them, a budget alert at 95% and at 100%, coupon records,
--     and extension through the same approvals as the original.
--   * Divisions can be renamed and merged, and everything that names
--     one follows.
--   * Mail from a partner's domain becomes a ticket; mail quoting a
--     ticket's reference is added to it.
--   * Existing evaluations are brought up to the template: new people,
--     forms and fields, and campaigns to look at.
--
-- Re-runnable.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Small helpers.
-- ---------------------------------------------------------------------
-- A number out of how people write them: "BDT 1,200,000.50" is 1200000.5.
create or replace function app.to_num(p text)
returns numeric
language sql
immutable
as $$
  select case when x ~ '^-?[0-9]+(\.[0-9]+)?$' then x::numeric end
    from (select regexp_replace(coalesce(p, ''), '[^0-9.\-]', '', 'g') as x) t
$$;

create or replace function app.to_date(p text)
returns date
language sql
immutable
as $$
  select case when p ~ '^\d{4}-\d{2}-\d{2}$' then p::date
              when p ~ '^\d{2}/\d{2}/\d{4}$' then to_date(p, 'DD/MM/YYYY') end
$$;

-- On leave: delegating their approvals for a window that covers the day.
create or replace function app.is_absent(p_employee text, p_on date default current_date)
returns boolean
language sql
stable
as $$
  select exists (select 1 from public.delegation_rules d
                  where d.tenant_id = app.current_tenant() and d.delegator_id = p_employee
                    and p_on between d.start_date and d.end_date)
$$;

-- "Customer: 2,000,000" per line, as [{wallet, budget}].
create or replace function app.parse_wallets(p text)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('wallet', trim(m[1]), 'budget', app.to_num(m[2]))), '[]'::jsonb)
    from regexp_matches(coalesce(p, ''), '([^:\n]+):\s*([^\n]+)', 'g') as m
   where app.to_num(m[2]) is not null
$$;

-- ---------------------------------------------------------------------
-- Policies: members read campaigns; changes go through the functions.
-- ---------------------------------------------------------------------
do $p$
declare t text;
begin
  foreach t in array array['campaigns', 'campaign_actuals', 'campaign_coupons', 'campaign_extensions'] loop
    execute format('drop policy if exists %1$s_member_read on public.%1$I', t);
    execute format($f$create policy %1$s_member_read on public.%1$I for select to app_api
                      using (tenant_id = (select app.current_tenant()) and (select app.is_member()))$f$, t);
  end loop;
  drop policy if exists inbound_mail_read on public.inbound_mail;
  create policy inbound_mail_read on public.inbound_mail for select to app_api
    using (tenant_id = (select app.current_tenant()) and (select app.is_member())
           and (app.has_permission('notifications.manage') or app.has_permission('audit.view') or app.has_permission('org.manage')));
end $p$;

-- ---------------------------------------------------------------------
-- An approved NFA becomes a campaign.
-- ---------------------------------------------------------------------
create or replace function app.campaign_from_nfa(p_submission uuid)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  s record; a jsonb; pa jsonb := '{}'; v_id uuid; v_start date; v_end date; v_wallets jsonb; v_reviewer text;
begin
  select * into s from public.form_submissions where id = p_submission;
  if not found then return null; end if;
  if exists (select 1 from public.campaigns where tenant_id = s.tenant_id and submission_id = s.id) then return null; end if;
  a := app.answers_of(s.id);
  if s.parent_submission_id is not null then pa := app.answers_of(s.parent_submission_id); end if;

  v_start := coalesce(app.to_date(a ->> 'Start date'), current_date);
  v_end   := coalesce(app.to_date(a ->> 'End date'), v_start + 30);
  v_wallets := app.parse_wallets(a ->> 'Wallet-wise budget');
  -- Whoever Business Finance put on the campaign request, or whoever
  -- decided its Business Finance step.
  v_reviewer := coalesce(nullif(pa ->> 'Business finance reviewer', ''),
    (select ar.approver_user_id from public.approval_requests ar
      where ar.submission_id = s.parent_submission_id and ar.stage_label = 'Business finance review'
        and ar.status = 'approved' limit 1));

  insert into public.campaigns
    (tenant_id, submission_id, request_id, name, audience, modality, coupon, exceptional, status, starts_on, ends_on,
     budget, kpi, wallets, cost_center, gl_code, product, beneficiary, requester_id, reviewer_id)
  values
    (s.tenant_id, s.id, s.parent_submission_id,
     coalesce(nullif(a ->> 'Campaign name', ''), 'Campaign ' || coalesce(s.ref_number, '')),
     a ->> 'Audience', a ->> 'Modality', coalesce(a ->> 'Modality', '') ilike 'coupon%',
     coalesce(s.flag, (select p.flag from public.form_submissions p where p.id = s.parent_submission_id), '') ilike 'exceptional%'
       or coalesce(pa ->> 'Approval route', '') = 'Exceptional',
     case when v_start > current_date then 'upcoming' when v_end < current_date then 'completed' else 'ongoing' end,
     v_start, v_end,
     coalesce(app.to_num(a ->> 'Total cost'), 0),
     jsonb_strip_nulls(jsonb_build_object(
       'beneficiaries', app.to_num(a ->> 'Beneficiary count'), 'transactions', app.to_num(a ->> 'Transaction count'),
       'volume', app.to_num(a ->> 'Transaction volume'), 'bkash_cost', app.to_num(a ->> 'bKash cost'),
       'total_cost', app.to_num(a ->> 'Total cost'))),
     v_wallets, a ->> 'Cost center', a ->> 'GL code', a ->> 'Product', a ->> 'Campaign beneficiary',
     s.submitted_by, v_reviewer)
  returning id into v_id;

  perform app.notify(s.submitted_by, 'campaign.created', 'Your campaign is approved and tracked',
    coalesce(a ->> 'Campaign name', 'The campaign') || ' is now in the campaign tracker. Record actuals there as it runs.',
    'campaign', v_id);
  return v_id;
end $$;

-- What an approval sets in motion: a campaign, or a campaign extended.
create or replace function app.on_submission_decided()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_kind text; x record;
begin
  -- Seeding writes history it does not want acted on: the campaigns a
  -- demonstration shows are seeded as campaigns, not as side effects.
  if coalesce(current_setting('app.no_mail', true), '') = 'true' then return new; end if;
  select on_approval into v_kind from public.form_templates where id = new.form_template_id;
  if v_kind is null then return new; end if;

  if v_kind = 'campaign' and new.status = 'completed' then
    perform app.campaign_from_nfa(new.id);
  elsif v_kind = 'campaign_extension' then
    select * into x from public.campaign_extensions where submission_id = new.id and status = 'pending';
    if not found then return new; end if;
    if new.status = 'completed' then
      update public.campaign_extensions set status = 'approved', decided_at = now() where id = x.id;
      update public.campaigns
         set ends_on = x.new_ends_on, budget = budget + x.added_budget, updated_at = now(),
             status = case when status = 'completed' then 'ongoing' else status end,
             alerted = '{}'
       where id = x.campaign_id;
      perform app.notify(x.requested_by, 'campaign.extended', 'Your campaign extension is approved',
        'It now runs to ' || to_char(x.new_ends_on, 'DD/MM/YYYY') || '.', 'campaign', x.campaign_id);
    elsif new.status in ('rejected', 'cancelled') then
      update public.campaign_extensions set status = 'rejected', decided_at = now() where id = x.id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists form_submissions_decided on public.form_submissions;
create trigger form_submissions_decided after update of status on public.form_submissions
  for each row when (new.status is distinct from old.status and new.status in ('completed', 'rejected', 'cancelled'))
  execute function app.on_submission_decided();

-- ---------------------------------------------------------------------
-- Working on a campaign: its requester, its reviewer, or an
-- administrator of reports.
-- ---------------------------------------------------------------------
create or replace function app.campaign_for_update(p_campaign uuid)
returns public.campaigns
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare c public.campaigns;
begin
  select * into c from public.campaigns where id = p_campaign and tenant_id = app.current_tenant();
  if not found then raise exception 'no such campaign'; end if;
  -- Each comparison on its own and coalesced: a campaign with no reviewer
  -- made "x in (requester, null)" null rather than false, and a null
  -- condition here let anybody through.
  if not (coalesce(app.current_employee() = c.requester_id, false)
          or coalesce(app.current_employee() = c.reviewer_id, false)
          or app.has_permission('reports.manage') or app.current_employee() is null) then
    raise exception 'only the campaign''s requester, its reviewer or an administrator can change it';
  end if;
  return c;
end $$;

-- Spent, against budget; tell the requester at 95% and at 100%, once each.
create or replace function app.check_campaign_budget(p_campaign uuid)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare c public.campaigns; v_spent numeric; v_pct numeric; t int;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.budget <= 0 then return; end if;
  select coalesce(sum(cost), 0) into v_spent from public.campaign_actuals where campaign_id = p_campaign;
  v_pct := round(100 * v_spent / c.budget, 1);
  foreach t in array array[95, 100] loop
    if v_pct >= t and not (c.alerted ? t::text) then
      perform app.notify(c.requester_id, 'campaign.budget',
        case when t = 100 then 'Over budget: ' else 'Budget at ' || v_pct || '%: ' end || c.name,
        to_char(v_spent, 'FM999,999,999,990') || ' of ' || to_char(c.budget, 'FM999,999,999,990') || ' spent ('
          || v_pct || '%). Consider an extension, or stopping it.',
        'campaign', c.id);
      if c.reviewer_id is not null and c.reviewer_id <> c.requester_id then
        perform app.notify(c.reviewer_id, 'campaign.budget',
          case when t = 100 then 'Over budget: ' else 'Budget at ' || v_pct || '%: ' end || c.name,
          'A campaign you reviewed has spent ' || v_pct || '% of its budget.', 'campaign', c.id);
      end if;
      update public.campaigns set alerted = alerted || jsonb_build_object(t::text, now()) where id = c.id;
      c.alerted := c.alerted || jsonb_build_object(t::text, now());
    end if;
  end loop;
end $$;

create or replace function public.record_campaign_actuals(
  p_campaign uuid, p_on_date date, p_cost numeric, p_beneficiaries int, p_transactions int, p_volume numeric, p_note text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare c public.campaigns;
begin
  c := app.campaign_for_update(p_campaign);
  if c.status in ('discarded', 'upcoming') then raise exception 'a campaign that has not run has no actuals'; end if;
  if p_cost is null or p_cost < 0 then raise exception 'the cost has to be zero or more'; end if;
  if p_on_date is null or p_on_date > current_date then raise exception 'actuals are for days that have happened'; end if;
  insert into public.campaign_actuals (tenant_id, campaign_id, on_date, cost, beneficiaries, transactions, volume, note, recorded_by)
  values (c.tenant_id, c.id, p_on_date, p_cost, p_beneficiaries, p_transactions, p_volume, nullif(trim(p_note), ''), app.current_employee());
  update public.campaigns set updated_at = now() where id = c.id;
  perform app.check_campaign_budget(c.id);
  perform app.audit('campaign_actuals', 'campaign', c.id, c.name || ': ' || to_char(p_cost, 'FM999,999,999,990') || ' on ' || to_char(p_on_date, 'DD/MM/YYYY'));
end $$;

create or replace function public.set_campaign_status(p_campaign uuid, p_status text, p_note text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare c public.campaigns;
begin
  c := app.campaign_for_update(p_campaign);
  if p_status not in ('upcoming', 'ongoing', 'completed', 'discontinued', 'discarded') then raise exception 'no such status'; end if;
  if c.status in ('completed', 'discontinued', 'discarded') and p_status <> c.status then
    raise exception 'a % campaign stays that way; extend it to run it again', c.status;
  end if;
  update public.campaigns set status = p_status, status_note = nullif(trim(p_note), ''), updated_at = now() where id = c.id;
  perform app.audit('campaign_' || p_status, 'campaign', c.id, c.name || coalesce(': ' || nullif(trim(p_note), ''), ''));
end $$;

-- Coupon records, from the redemption services' exports.
create or replace function public.import_coupons(p_campaign uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare c public.campaigns; v_in int; v_total int;
begin
  c := app.campaign_for_update(p_campaign);
  if not c.coupon then raise exception 'this is not a coupon campaign'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'expected a list of coupons'; end if;
  select count(*) into v_total from jsonb_array_elements(p_rows);
  insert into public.campaign_coupons (tenant_id, campaign_id, code, wallet, amount, issued_at, redeemed_at, redeemed_via)
  select c.tenant_id, c.id, trim(r ->> 'code'), nullif(trim(r ->> 'wallet'), ''), app.to_num(r ->> 'amount'),
         coalesce(app.to_date(r ->> 'issued_on'), current_date)::timestamptz,
         app.to_date(r ->> 'redeemed_on')::timestamptz,
         case when app.to_date(r ->> 'redeemed_on') is not null
              then case lower(coalesce(nullif(trim(r ->> 'redeemed_via'), ''), 'app'))
                     when 'app' then 'App' when 'ussd' then 'USSD' when 'agent' then 'Agent' when 'merchant' then 'Merchant' end end
    from jsonb_array_elements(p_rows) r
   where coalesce(trim(r ->> 'code'), '') <> ''
     and lower(coalesce(nullif(trim(r ->> 'redeemed_via'), ''), 'app')) in ('app', 'ussd', 'agent', 'merchant')
  on conflict (tenant_id, campaign_id, code) do update
     set redeemed_at = excluded.redeemed_at, redeemed_via = excluded.redeemed_via, amount = coalesce(excluded.amount, campaign_coupons.amount);
  get diagnostics v_in = row_count;
  perform app.audit('coupons_imported', 'campaign', c.id, c.name || ': ' || v_in || ' of ' || v_total || ' rows');
  return jsonb_build_object('imported', v_in, 'skipped', v_total - v_in);
end $$;

-- "Requester will be able to extend a live campaign provided the
-- modality remains unchanged; updated business case to be shared with
-- business finance, and upon vetting regular or exceptional approval
-- matrix will be followed." The extension is a request of its own,
-- through its own approvals; approving it extends the campaign.
create or replace function public.request_campaign_extension(
  p_campaign uuid, p_new_ends_on date, p_added_budget numeric, p_business_case text, p_route text)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare c public.campaigns; v_tpl uuid; v_sub uuid;
begin
  c := app.campaign_for_update(p_campaign);
  if c.status not in ('ongoing', 'upcoming') then raise exception 'only a live or upcoming campaign can be extended'; end if;
  if p_new_ends_on is null or p_new_ends_on <= c.ends_on then raise exception 'an extension has to end after %', to_char(c.ends_on, 'DD/MM/YYYY'); end if;
  if coalesce(trim(p_business_case), '') = '' then raise exception 'share the updated business case with Business Finance'; end if;
  if exists (select 1 from public.campaign_extensions where campaign_id = c.id and status = 'pending') then
    raise exception 'an extension is already waiting for approval';
  end if;
  select id into v_tpl from public.form_templates
   where tenant_id = c.tenant_id and on_approval = 'campaign_extension' and status = 'published' limit 1;
  if v_tpl is null then raise exception 'there is no campaign extension form here'; end if;

  insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
  values (c.tenant_id, v_tpl, coalesce(app.current_employee(), c.requester_id), 'submitted', now())
  returning id into v_sub;
  insert into public.submission_values (tenant_id, submission_id, field_name, value)
  select c.tenant_id, v_sub, k, v from (values
    ('Campaign', c.name),
    ('Modality', coalesce(c.modality, '')),
    ('Current end date', c.ends_on::text),
    ('New end date', p_new_ends_on::text),
    ('Additional budget', coalesce(p_added_budget, 0)::text),
    ('Updated business case', p_business_case),
    ('Approval route', case when p_route = 'Exceptional' then 'Exceptional' else 'Regular' end)) x(k, v);

  insert into public.campaign_extensions (tenant_id, campaign_id, submission_id, new_ends_on, added_budget, business_case, requested_by)
  values (c.tenant_id, c.id, v_sub, p_new_ends_on, coalesce(p_added_budget, 0), p_business_case, coalesce(app.current_employee(), c.requester_id));
  insert into public.submission_links (tenant_id, from_id, to_id, note, created_by)
  select c.tenant_id, v_sub, c.submission_id, 'Extends this campaign', app.current_employee()
   where c.submission_id is not null
  on conflict do nothing;

  perform public.build_approval_chain('form_submission', v_sub, v_tpl);
  perform app.audit('campaign_extension_requested', 'campaign', c.id, c.name || ' to ' || to_char(p_new_ends_on, 'DD/MM/YYYY'));
  return v_sub;
end $$;

-- The campaign day: upcoming ones start, finished ones finish.
create or replace function app.campaign_daily()
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_started int; v_finished int;
begin
  update public.campaigns set status = 'ongoing', updated_at = now()
   where tenant_id = app.current_tenant() and status = 'upcoming' and starts_on <= current_date;
  get diagnostics v_started = row_count;
  update public.campaigns set status = 'completed', updated_at = now()
   where tenant_id = app.current_tenant() and status = 'ongoing' and ends_on < current_date;
  get diagnostics v_finished = row_count;
  return jsonb_build_object('started', v_started, 'finished', v_finished);
end $$;

-- ---------------------------------------------------------------------
-- Divisions.
--
-- "When a new division is created or an old division is merged with
-- another division to form a new one, after input the system will
-- detect this and adjust all the processes accordingly." A rename or a
-- merge carries everything that names the division: its people, which
-- forms are offered to it, and the reports filtered by it. Approval
-- routes follow by themselves, because they resolve a division's head,
-- HRBP and CXO when a request is raised.
-- ---------------------------------------------------------------------
create or replace function app.move_department(p_from text, p_into text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_people int; v_forms int; v_reports int; v_roles int; v_trackers int;
begin
  update public.employees set department = p_into
   where tenant_id = app.current_tenant() and department = p_from;
  get diagnostics v_people = row_count;
  update public.form_templates
     set audience_departments = (select array_agg(distinct x) from unnest(array_replace(audience_departments, p_from, p_into)) x)
   where tenant_id = app.current_tenant() and p_from = any (audience_departments);
  get diagnostics v_forms = row_count;
  update public.report_templates
     set filters = jsonb_set(filters, '{department}',
           (select to_jsonb(array_agg(distinct case when d = p_from then p_into else d end))
              from jsonb_array_elements_text(filters -> 'department') d))
   where tenant_id = app.current_tenant() and filters -> 'department' ? p_from;
  get diagnostics v_reports = row_count;
  -- Roles given to the division (db/009_sow_gaps.sql). Left behind, its
  -- people would silently lose them. On a merge the other division may
  -- already hold the role: keep one.
  delete from public.role_groups g
   where g.tenant_id = app.current_tenant() and g.department = p_from
     and exists (select 1 from public.role_groups h
                  where h.tenant_id = g.tenant_id and h.role_id = g.role_id and h.department = p_into);
  update public.role_groups set department = p_into
   where tenant_id = app.current_tenant() and department = p_from;
  get diagnostics v_roles = row_count;
  -- Trackers kept for the division, and trackers filtered by it.
  update public.trackers set department = p_into
   where tenant_id = app.current_tenant() and department = p_from;
  -- Roles limited to the division, and the forms it owns.
  update public.roles set scope_department = p_into
   where tenant_id = app.current_tenant() and scope_department = p_from;
  update public.form_templates set owner_department = p_into
   where tenant_id = app.current_tenant() and owner_department = p_from;
  get diagnostics v_trackers = row_count;
  update public.trackers
     set filters = jsonb_set(filters, '{departments}',
           (select to_jsonb(array_agg(distinct case when d = p_from then p_into else d end))
              from jsonb_array_elements_text(filters -> 'departments') d))
   where tenant_id = app.current_tenant() and filters -> 'departments' ? p_from;
  return jsonb_build_object('people', v_people, 'forms', v_forms, 'reports', v_reports,
                            'roles', v_roles, 'trackers', v_trackers);
end $$;

create or replace function public.rename_department(p_from text, p_into text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v jsonb;
begin
  perform app.require_permission('org.manage');
  if coalesce(trim(p_into), '') = '' then raise exception 'a division needs a name'; end if;
  if not exists (select 1 from public.departments where tenant_id = app.current_tenant() and name = p_from) then
    raise exception 'no division called %', p_from;
  end if;
  if exists (select 1 from public.departments where tenant_id = app.current_tenant() and name = trim(p_into)) then
    raise exception 'there is already a division called %; merge them instead', trim(p_into);
  end if;
  update public.departments set name = trim(p_into) where tenant_id = app.current_tenant() and name = p_from;
  v := app.move_department(p_from, trim(p_into));
  perform app.audit('division_renamed', 'department', null::uuid, p_from || ' → ' || trim(p_into));
  return v;
end $$;

create or replace function public.merge_departments(p_from text, p_into text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v jsonb; f record; t record;
begin
  perform app.require_permission('org.manage');
  select * into f from public.departments where tenant_id = app.current_tenant() and name = p_from;
  if not found then raise exception 'no division called %', p_from; end if;
  select * into t from public.departments where tenant_id = app.current_tenant() and name = p_into;
  if not found then raise exception 'no division called %', p_into; end if;
  if f.id = t.id then raise exception 'a division cannot be merged into itself'; end if;
  -- The surviving division keeps its own head, HRBP and CXO, and takes
  -- the merged one's where it has none.
  update public.departments
     set head_employee_id = coalesce(t.head_employee_id, f.head_employee_id),
         hrbp_employee_id = coalesce(t.hrbp_employee_id, f.hrbp_employee_id),
         cxo_employee_id  = coalesce(t.cxo_employee_id, f.cxo_employee_id)
   where id = t.id;
  v := app.move_department(p_from, p_into);
  delete from public.departments where id = f.id;
  perform app.audit('division_merged', 'department', t.id, p_from || ' merged into ' || p_into
    || ' (' || (v ->> 'people') || ' people, ' || (v ->> 'forms') || ' forms, ' || (v ->> 'reports') || ' reports)');
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Mail to ticket.
-- ---------------------------------------------------------------------
create or replace function public.set_inbound_settings(p_domains text[], p_poc text, p_form text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if not (app.has_permission('notifications.manage') or app.has_permission('org.manage')) then
    raise exception 'you need the notifications.manage permission for that';
  end if;
  if p_poc is not null and not exists (select 1 from public.employees where tenant_id = app.current_tenant() and employee_id = p_poc and active) then
    raise exception 'the point of contact has to be somebody here';
  end if;
  update public.tenants
     set inbound_domains = (select coalesce(array_agg(distinct lower(trim(d))), '{}') from unnest(coalesce(p_domains, '{}')) d where trim(d) <> ''),
         inbound_poc = p_poc, inbound_form = nullif(trim(p_form), '')
   where id = app.current_tenant();
  perform app.audit('inbound_settings_changed', 'tenant', null::uuid, array_to_string(p_domains, ', '));
end $$;

-- One message, for the tenant in context. Called by the server for the
-- inbound webhook and for the "simulate" button, never by the browser.
create or replace function app.receive_mail(p_from text, p_subject text, p_body text, p_attachments text[])
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  t record; v_addr text; v_domain text; v_ref text; s record; v_sid uuid; v_author text; v_tpl uuid; v_sub uuid; r record;
  v_outcome text; v_reason text;
begin
  select * into t from public.tenants where id = app.current_tenant();
  v_addr := lower(trim(coalesce(substring(p_from from '<([^>]+)>'), p_from)));
  v_domain := split_part(v_addr, '@', 2);
  v_ref := substring(coalesce(p_subject, '') from 'AMS-\d{4}-\d{5}');

  if v_ref is not null then
    select id into v_sid from public.form_submissions where tenant_id = t.id and ref_number = v_ref;
  end if;

  if v_sid is not null then
    select * into s from public.form_submissions where id = v_sid;
    -- A reply about a ticket — a UAT result, say — goes on the ticket.
    select employee_id into v_author from public.employees where tenant_id = t.id and lower(email) = v_addr limit 1;
    -- A note needs an author here: an outsider's mail is filed under the
    -- partner point of contact, or the requester.
    v_author := coalesce(v_author, t.inbound_poc, s.submitted_by);
    insert into public.ticket_notes (tenant_id, submission_id, author_id, body)
    values (t.id, s.id, v_author,
            'Email from ' || v_addr || ': ' || coalesce(p_subject, '') || E'\n\n' || coalesce(left(p_body, 4000), '')
            || case when cardinality(coalesce(p_attachments, '{}')) > 0
                    then E'\n\nAttached: ' || array_to_string(p_attachments, ', ') else '' end);
    perform app.log_event(null, 'form_submission', s.id, v_author, 'email_received', p_subject, v_addr);
    for r in
      select distinct who from (
        select s.submitted_by as who
        union select ar.approver_user_id from public.approval_requests ar
         where ar.submission_id = s.id and ar.status in ('pending', 'approved', 'clarification')) x
       where who is not null
    loop
      perform app.notify(r.who, 'note.added', 'An email was added to ' || v_ref,
        'From ' || v_addr || ': ' || coalesce(p_subject, ''), 'form_submission', s.id);
    end loop;
    v_outcome := 'note'; v_sub := s.id;
  elsif v_domain <> '' and v_domain = any (t.inbound_domains) then
    -- A partner's request: a ticket for the telecom team to check.
    select id into v_tpl from public.form_templates
     where tenant_id = t.id and name = coalesce(t.inbound_form, 'MNO Campaign Request') and status = 'published';
    if v_tpl is null or t.inbound_poc is null then
      v_outcome := 'rejected'; v_reason := 'no form or point of contact is set for partner mail';
    else
      perform set_config('app.on_behalf', 'true', true);
      insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
      values (t.id, v_tpl, t.inbound_poc, 'submitted', now()) returning id into v_sub;
      perform set_config('app.on_behalf', 'false', true);
      insert into public.submission_values (tenant_id, submission_id, field_name, value)
      select t.id, v_sub, k, v from (values
        ('Partner', v_domain), ('Sender', v_addr), ('Subject', coalesce(p_subject, '')),
        ('Request details', coalesce(left(p_body, 8000), ''))) x(k, v);
      perform public.build_approval_chain('form_submission', v_sub, v_tpl);
      perform app.log_event(null, 'form_submission', v_sub, null, 'email_received', p_subject, v_addr);
      v_outcome := 'ticket';
    end if;
  else
    v_outcome := 'rejected';
    v_reason := case when v_ref is not null then 'it quotes ' || v_ref || ', which is not a ticket here'
                     else 'mail from ' || coalesce(nullif(v_domain, ''), 'an unknown sender') || ' is not from a partner domain' end;
  end if;

  insert into public.inbound_mail (tenant_id, from_address, subject, body_text, attachments, outcome, reason, submission_id)
  values (t.id, v_addr, p_subject, left(p_body, 20000), coalesce(p_attachments, '{}'), v_outcome, v_reason, v_sub);
  return jsonb_build_object('outcome', v_outcome, 'reason', v_reason, 'submission_id', v_sub,
    'reference', (select ref_number from public.form_submissions where id = v_sub));
end $$;

-- ---------------------------------------------------------------------
-- Campaigns to look at, for a demonstration: an NFA approved for each,
-- spending recorded over its life, coupon records for the coupon one.
-- ---------------------------------------------------------------------
create or replace function app.seed_campaigns(p_tenant uuid)
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_tpl uuid; spec record; v_sub uuid; v_camp uuid; v_start date; v_end date; v_stop date;
  v_days int; v_n int := 0; d date; v_step int; v_share numeric; v_spent numeric; v_cost numeric;
  v_wallets text; k int; v_alerted jsonb;
begin
  if (select campaigns_seeded from public.tenants where id = p_tenant) then return 0; end if;
  perform set_config('app.no_mail', 'true', true);
  select id into v_tpl from public.form_templates where tenant_id = p_tenant and on_approval = 'campaign' limit 1;
  if v_tpl is null then return 0; end if;
  perform setseed(0.77);

  for spec in select * from (values
    -- name, audience, modality, status, starts (days from today), length, budget, share of budget spent, requester, reviewer, exceptional
    ('Boishakhi Cashback 2026',       'Customer',    'Cashback',      'ongoing',      -42, 60, 4500000::numeric, 0.962, 'EMP-0416', 'EMP-0410', false),
    ('Merchant QR Activation Drive',  'Merchant',    'Discount',      'ongoing',      -24, 75, 2000000::numeric, 0.29,  'EMP-0416', 'EMP-0411', true),
    ('Eid Coupon Bonanza',            'Customer',    'Coupon',        'completed',    -70, 45, 3000000::numeric, 0.91,  'EMP-0416', 'EMP-0410', false),
    ('Agent Cash-in Incentive Q4',    'Agent',       'Bonus',         'upcoming',      12, 60, 1200000::numeric, 0,     'EMP-0416', 'EMP-0411', false),
    ('Distributor Volume Push',       'Distributor', 'Bonus',         'discontinued', -55, 60, 1800000::numeric, 0.55,  'EMP-2847', 'EMP-0410', false),
    ('Field Force Onboarding Sprint', 'Field force', 'Free transfer', 'ongoing',      -18, 40,  900000::numeric, 0.43,  'EMP-0416', 'EMP-0411', false),
    ('Student Free Send Money',       'Customer',    'Free transfer', 'discarded',    -30, 30,  600000::numeric, 0,     'EMP-0416', 'EMP-0410', false)
  ) x(name, audience, modality, status, start_off, len, budget, share, requester, reviewer, exceptional)
  loop
    v_start := current_date + spec.start_off;
    v_end := v_start + spec.len;
    v_wallets := case spec.audience
      when 'Customer' then 'Customer: ' || round(spec.budget * 0.8) || E'\nAgent: ' || round(spec.budget * 0.2)
      when 'Merchant' then 'Merchant: ' || round(spec.budget * 0.9) || E'\nCustomer: ' || round(spec.budget * 0.1)
      else spec.audience || ': ' || round(spec.budget) end;

    insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at, priority, flag)
    values (p_tenant, v_tpl, spec.requester, 'completed', (v_start - 14)::timestamptz + interval '10 hours', 'normal',
            case when spec.exceptional then 'Exceptional' end)
    returning id into v_sub;
    insert into public.submission_values (tenant_id, submission_id, field_name, value)
    select p_tenant, v_sub, k2, v2 from (values
      ('Campaign name', spec.name), ('Audience', spec.audience), ('Modality', spec.modality),
      ('Start date', v_start::text), ('End date', v_end::text),
      ('Beneficiary count', round(spec.budget / 60)::text), ('Transaction count', round(spec.budget / 25)::text),
      ('Transaction volume', round(spec.budget * 42)::text), ('bKash cost', round(spec.budget * 0.85)::text),
      ('Total cost', spec.budget::text),
      ('Wallet', '["' || spec.audience || '"]'), ('Wallet-wise budget', v_wallets),
      ('Cost center', 'CC-' || (4100 + v_n)), ('GL code', '6230' || (10 + v_n)),
      ('Product', case spec.audience when 'Merchant' then 'bKash Merchant QR' when 'Agent' then 'Cash-in' else 'Send Money' end),
      ('Campaign beneficiary', spec.audience || 's')) y(k2, v2);
    insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index, status, opened_at, acted_at, deadline_at, created_at, stage_label)
    values (p_tenant, v_sub, coalesce(app.line_manager_of(spec.requester), 'EMP-0800'), 0, 'approved',
            (v_start - 14)::timestamptz + interval '10 hours', (v_start - 13)::timestamptz + interval '15 hours',
            (v_start - 11)::timestamptz, (v_start - 14)::timestamptz, null),
           (p_tenant, v_sub, spec.reviewer, 1, 'approved',
            (v_start - 13)::timestamptz + interval '15 hours', (v_start - 11)::timestamptz + interval '12 hours',
            (v_start - 10)::timestamptz, (v_start - 14)::timestamptz, 'Business finance review'),
           (p_tenant, v_sub, case when spec.budget > 1000000 then 'EMP-0600' else 'EMP-0312' end, 2, 'approved',
            (v_start - 11)::timestamptz + interval '12 hours', (v_start - 9)::timestamptz + interval '11 hours',
            (v_start - 8)::timestamptz, (v_start - 14)::timestamptz, 'Finance');

    insert into public.campaigns
      (tenant_id, submission_id, name, audience, modality, coupon, exceptional, status, starts_on, ends_on, budget, kpi, wallets,
       cost_center, gl_code, product, beneficiary, requester_id, reviewer_id, status_note, created_at)
    values (p_tenant, v_sub, spec.name, spec.audience, spec.modality, spec.modality = 'Coupon', spec.exceptional, spec.status,
            v_start, v_end, spec.budget,
            jsonb_build_object('beneficiaries', round(spec.budget / 60), 'transactions', round(spec.budget / 25),
                               'volume', round(spec.budget * 42), 'bkash_cost', round(spec.budget * 0.85), 'total_cost', spec.budget),
            app.parse_wallets(v_wallets),
            'CC-' || (4100 + v_n), '6230' || (10 + v_n),
            case spec.audience when 'Merchant' then 'bKash Merchant QR' when 'Agent' then 'Cash-in' else 'Send Money' end,
            spec.audience || 's', spec.requester, spec.reviewer,
            case spec.status when 'discontinued' then 'Stopped early: distributor uptake below plan.'
                             when 'discarded' then 'Not launched: overlapped with the Eid campaign.' end,
            (v_start - 9)::timestamptz)
    returning id into v_camp;

    -- Spending, every few days, until today, the end, or the day it stopped.
    if spec.share > 0 then
      v_stop := least(current_date - 1, v_end, case when spec.status = 'discontinued' then v_start + (spec.len * 0.55)::int else v_end end);
      v_days := greatest(1, v_stop - v_start);
      v_spent := 0; v_step := 0;
      d := v_start;
      while d <= v_stop loop
        v_step := v_step + 1;
        -- Front-loaded a little, with noise, ending at the share spent.
        v_share := spec.share * least(1, power((d - v_start + 3)::numeric / (v_days + 3), 0.85));
        v_cost := greatest(0, round(spec.budget * v_share - v_spent + (random() - 0.5) * spec.budget * 0.004));
        v_spent := v_spent + v_cost;
        insert into public.campaign_actuals (tenant_id, campaign_id, on_date, cost, beneficiaries, transactions, volume, recorded_by, created_at)
        values (p_tenant, v_camp, d, v_cost, round(v_cost / 60 * (0.8 + random() * 0.4)), round(v_cost / 25 * (0.85 + random() * 0.3)),
                round(v_cost * 42 * (0.8 + random() * 0.35)), spec.requester, d::timestamptz + interval '18 hours');
        d := d + 3;
      end loop;
      -- The last stretch, so it ends at exactly the share it was meant to.
      if round(spec.budget * spec.share) > v_spent then
        v_cost := round(spec.budget * spec.share) - v_spent;
        v_spent := v_spent + v_cost;
        insert into public.campaign_actuals (tenant_id, campaign_id, on_date, cost, beneficiaries, transactions, volume, recorded_by, created_at)
        values (p_tenant, v_camp, v_stop, v_cost, round(v_cost / 60), round(v_cost / 25), round(v_cost * 42),
                spec.requester, v_stop::timestamptz + interval '19 hours');
      end if;
      v_alerted := '{}';
      if v_spent >= spec.budget * 0.95 then
        v_alerted := jsonb_build_object('95', now() - interval '2 days');
        insert into public.notifications (tenant_id, recipient_id, kind, title, body, entity_type, entity_id, created_at)
        values (p_tenant, spec.requester, 'campaign.budget', 'Budget at ' || round(100 * v_spent / spec.budget, 1) || '%: ' || spec.name,
                'Consider an extension, or stopping it.', 'campaign', v_camp, now() - interval '2 days');
      end if;
      update public.campaigns set alerted = v_alerted where id = v_camp;
    end if;

    -- Coupons, and which redemption service took each.
    if spec.modality = 'Coupon' then
      for k in 1..360 loop
        insert into public.campaign_coupons (tenant_id, campaign_id, code, wallet, amount, issued_at, redeemed_at, redeemed_via)
        values (p_tenant, v_camp, 'EID26-' || lpad(k::text, 5, '0'),
                '01' || (7 + k % 3) || lpad(((k * 7919) % 100000000)::text, 8, '0'),
                case when k % 5 = 0 then 200 else 100 end,
                (v_start + (k % 20))::timestamptz + interval '9 hours',
                case when random() < 0.68 then (v_start + (k % 20) + 1 + floor(random() * 10)::int)::timestamptz + interval '14 hours' end,
                null);
      end loop;
      update public.campaign_coupons set redeemed_via = case when random() < 0.71 then 'App' else 'USSD' end
       where campaign_id = v_camp and redeemed_at is not null;
    end if;
    v_n := v_n + 1;
  end loop;

  update public.tenants set campaigns_seeded = true where id = p_tenant;
  perform set_config('app.no_mail', 'false', true);
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Bring an evaluation up to the template.
--
-- Evaluations are clones, taken when they were issued; this adds what
-- the template has gained since — people, divisions, forms and the
-- fields of forms they already have — without touching anything a
-- prospect has changed.
-- ---------------------------------------------------------------------
create or replace function app.upgrade_from_template(p_tenant uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_tpl uuid; v_people int; v_depts int; v_forms int := 0; v_fields int; f record; v_new uuid;
begin
  select id into v_tpl from public.tenants where kind = 'template';
  if v_tpl is null or v_tpl = p_tenant then return '{}'; end if;
  perform set_config('app.no_mail', 'true', true);

  insert into public.employees (tenant_id, employee_id, name, designation, department, gate_pass_card_number, active, email)
  select p_tenant, e.employee_id, e.name, e.designation, e.department, e.gate_pass_card_number, e.active, e.email
    from public.employees e
   where e.tenant_id = v_tpl
     and not exists (select 1 from public.employees x where x.tenant_id = p_tenant and x.employee_id = e.employee_id);
  get diagnostics v_people = row_count;
  update public.employees x set line_manager_id = e.line_manager_id
    from public.employees e
   where e.tenant_id = v_tpl and x.tenant_id = p_tenant and x.employee_id = e.employee_id and x.line_manager_id is null
     and e.line_manager_id is not null
     and exists (select 1 from public.employees m where m.tenant_id = p_tenant and m.employee_id = e.line_manager_id);

  insert into public.departments (tenant_id, name, head_employee_id, hrbp_employee_id, cxo_employee_id)
  select p_tenant, d.name, d.head_employee_id, d.hrbp_employee_id, d.cxo_employee_id
    from public.departments d
   where d.tenant_id = v_tpl
     and not exists (select 1 from public.departments x where x.tenant_id = p_tenant and x.name = d.name);
  get diagnostics v_depts = row_count;

  insert into public.delegation_rules (tenant_id, delegator_id, delegate_id, start_date, end_date, reason)
  select p_tenant, d.delegator_id, d.delegate_id, d.start_date, d.end_date, d.reason
    from public.delegation_rules d
   where d.tenant_id = v_tpl and d.delegator_id in ('EMP-0412')
     and not exists (select 1 from public.delegation_rules x where x.tenant_id = p_tenant and x.delegator_id = d.delegator_id);

  -- Forms the evaluation does not have.
  for f in select * from public.form_templates t where t.tenant_id = v_tpl
            and not exists (select 1 from public.form_templates x where x.tenant_id = p_tenant and x.name = t.name)
  loop
    insert into public.form_templates (tenant_id, name, category, created_by, status, audience_departments, classification, keywords, on_approval)
    values (p_tenant, f.name, f.category, f.created_by, f.status, f.audience_departments, f.classification, f.keywords, f.on_approval)
    returning id into v_new;
    insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, field_config, order_index, is_required)
    select p_tenant, v_new, field_type, field_name, field_config, order_index, is_required from public.form_fields where form_template_id = f.id;
    insert into public.approval_rules (tenant_id, subject_type, form_template_id, approver_user_id, deadline_days, is_auto_added, label,
                                       step_index, position, lane, quorum, stage_label, condition, require_signature, flag)
    select p_tenant, subject_type, v_new, approver_user_id, deadline_days, is_auto_added, label,
           step_index, position, lane, quorum, stage_label, condition, require_signature, flag
      from public.approval_rules where form_template_id = f.id;
    insert into public.approval_slabs (tenant_id, form_template_id, min_amount, max_amount, approver_user_id, order_index)
    select p_tenant, v_new, min_amount, max_amount, approver_user_id, order_index from public.approval_slabs where form_template_id = f.id;
    insert into public.notification_rules (tenant_id, form_template_id, notifyee_user_id, is_auto_added, label)
    select p_tenant, v_new, notifyee_user_id, is_auto_added, label from public.notification_rules where form_template_id = f.id;
    v_forms := v_forms + 1;
  end loop;
  -- Follow-ups, by name, once every form exists.
  update public.form_templates x
     set followup_template_id = (select y.id from public.form_templates y
                                  join public.form_templates tf on tf.id = t.followup_template_id
                                 where y.tenant_id = p_tenant and y.name = tf.name)
    from public.form_templates t
   where t.tenant_id = v_tpl and t.followup_template_id is not null
     and x.tenant_id = p_tenant and x.name = t.name and x.followup_template_id is null;

  -- Fields the evaluation's forms are missing, and what a form now is.
  insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, field_config, order_index, is_required)
  select p_tenant, x.id, tf.field_type, tf.field_name, tf.field_config, tf.order_index, tf.is_required
    from public.form_templates t
    join public.form_fields tf on tf.form_template_id = t.id
    join public.form_templates x on x.tenant_id = p_tenant and x.name = t.name
   where t.tenant_id = v_tpl
     and not exists (select 1 from public.form_fields xf where xf.form_template_id = x.id and xf.field_name = tf.field_name);
  get diagnostics v_fields = row_count;
  update public.form_fields xf set order_index = tf.order_index, field_config = tf.field_config
    from public.form_templates x
    join public.form_templates t on t.tenant_id = v_tpl and t.name = x.name
    join public.form_fields tf on tf.form_template_id = t.id
   where x.tenant_id = p_tenant and xf.form_template_id = x.id and xf.field_name = tf.field_name
     and (xf.order_index, xf.field_config) is distinct from (tf.order_index, tf.field_config);
  update public.form_templates x
     set classification = coalesce(x.classification, t.classification),
         keywords = case when cardinality(x.keywords) = 0 then t.keywords else x.keywords end,
         on_approval = coalesce(x.on_approval, t.on_approval)
    from public.form_templates t
   where t.tenant_id = v_tpl and x.tenant_id = p_tenant and x.name = t.name;
  -- The campaign request's Business Finance step is now the reviewer the
  -- requester chooses.
  update public.approval_rules r set label = t.label, approver_user_id = t.approver_user_id
    from public.form_templates x
    join public.form_templates tt on tt.tenant_id = v_tpl and tt.name = x.name
    join public.approval_rules t on t.form_template_id = tt.id and t.stage_label = 'Business finance review'
   where x.tenant_id = p_tenant and r.form_template_id = x.id and r.label = 'business_finance';

  update public.tenants d
     set inbound_domains = case when cardinality(d.inbound_domains) = 0 then t.inbound_domains else d.inbound_domains end,
         inbound_poc = coalesce(d.inbound_poc, t.inbound_poc), inbound_form = coalesce(d.inbound_form, t.inbound_form)
    from public.tenants t
   where t.id = v_tpl and d.id = p_tenant;

  perform set_config('app.no_mail', 'false', true);
  return jsonb_build_object('people', v_people, 'divisions', v_depts, 'forms', v_forms, 'fields', v_fields);
end $$;

grant execute on function
  public.record_campaign_actuals(uuid, date, numeric, int, int, numeric, text),
  public.set_campaign_status(uuid, text, text),
  public.import_coupons(uuid, jsonb),
  public.request_campaign_extension(uuid, date, numeric, text, text),
  public.rename_department(text, text),
  public.merge_departments(text, text),
  public.set_inbound_settings(text[], text, text)
to app_api;
grant execute on all functions in schema app to app_api;

commit;
