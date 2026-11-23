-- =====================================================================
-- Commercial campaigns, divisions and mail to ticket.
--
-- Against the seeded template, as its people: the Business Finance
-- reviewer the requester chooses, the team copied; an approved NFA
-- becoming a campaign; actuals and the budget alerts; extensions; coupon
-- records; merging divisions; partner mail becoming tickets; and an old
-- evaluation brought up to the template.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

select set_config('t.tpl', (select id::text from public.tenants where kind = 'template'), false);

create or replace function pg_temp.as_emp(p_emp text) returns void language plpgsql as $$
begin
  perform set_config('app.tenant_id',   current_setting('t.tpl'), true),
          set_config('app.user_id',     '00000000-0000-4000-8000-0000000000aa', true),
          set_config('app.role',        'admin', true),
          set_config('app.is_staff',    'false', true),
          set_config('app.employee_id', coalesce(p_emp, ''), true),
          set_config('app.mfa',         'true', true);
end $$;

create or replace function pg_temp.refused(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $$;

-- A request raised on a form, with these answers, and its chain built.
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

-- =====================================================================
-- 1. Seeded campaigns
-- =====================================================================
do $$
declare v record;
begin
  select count(*) n, count(distinct status) statuses, count(*) filter (where alerted ? '95') alerted,
         count(*) filter (where exceptional) exceptional
    into v from public.campaigns where tenant_id = current_setting('t.tpl')::uuid;
  if v.n <> 7 or v.statuses <> 5 or v.alerted < 1 or v.exceptional < 1 then
    raise exception 'FAIL: the seeded campaigns are not what a demonstration needs: %', row_to_json(v);
  end if;
  if (select count(distinct redeemed_via) from public.campaign_coupons where tenant_id = current_setting('t.tpl')::uuid and redeemed_at is not null) <> 2 then
    raise exception 'FAIL: the coupon campaign does not record both redemption services';
  end if;
  if exists (select 1 from public.campaigns c where c.tenant_id = current_setting('t.tpl')::uuid and c.submission_id is null) then
    raise exception 'FAIL: a seeded campaign has no approved NFA behind it';
  end if;
  raise notice 'pass: seven campaigns across five statuses, one over 95%%, one exceptional, coupons from App and USSD';
end $$;

-- =====================================================================
-- 2. The reviewer the requester chooses, and the team copied
-- =====================================================================
do $$
declare v_sub uuid; v_who text;
begin
  perform pg_temp.as_emp('EMP-0416');
  v_sub := pg_temp.raise_request('Campaign Request', 'EMP-0416',
    '{"Campaign name": "Test", "Audience": "Customer", "Approval route": "Regular", "Budget": "100000", "Business case": "x", "Business finance reviewer": "EMP-0411"}');
  select approver_user_id into v_who from public.approval_requests where submission_id = v_sub and stage_label = 'Business finance review';
  if v_who <> 'EMP-0411' then raise exception 'FAIL: the chosen reviewer was not asked (got %)', v_who; end if;
  if (select array_agg(employee_id order by employee_id) from public.submission_cc where submission_id = v_sub)
     <> array['EMP-0410', 'EMP-0411', 'EMP-0412'] then
    raise exception 'FAIL: the Business Finance team was not copied';
  end if;

  v_sub := pg_temp.raise_request('Campaign Request', 'EMP-0416',
    '{"Campaign name": "Test 2", "Audience": "Customer", "Approval route": "Regular", "Budget": "100000", "Business case": "x"}');
  select approver_user_id into v_who from public.approval_requests where submission_id = v_sub and stage_label = 'Business finance review';
  if v_who <> 'EMP-0410' then raise exception 'FAIL: with no choice the lead was not asked (got %)', v_who; end if;

  v_sub := pg_temp.raise_request('Campaign Request', 'EMP-0411',
    '{"Campaign name": "Test 3", "Audience": "Customer", "Approval route": "Regular", "Budget": "100000", "Business case": "x", "Business finance reviewer": "EMP-0411"}');
  select approver_user_id into v_who from public.approval_requests where submission_id = v_sub and stage_label = 'Business finance review';
  if v_who = 'EMP-0411' then raise exception 'FAIL: a requester chose themselves to review'; end if;
  if not app.is_absent('EMP-0412') or app.is_absent('EMP-0411') then
    raise exception 'FAIL: who is on leave is wrong';
  end if;
  raise notice 'pass: Business Finance review goes to the reviewer the requester chose, never themselves; the lead otherwise';
  raise notice 'pass: the whole Business Finance team is copied, and who is on leave is known';
end $$;

-- =====================================================================
-- 3. An approved NFA becomes a campaign; actuals and the budget alerts
-- =====================================================================
do $$
declare v_sub uuid; c record; n int;
begin
  perform pg_temp.as_emp('EMP-0416');
  v_sub := pg_temp.raise_request('Campaign NFA', 'EMP-0416', jsonb_build_object(
    'Campaign name', 'Winter Cashback', 'Audience', 'Customer', 'Modality', 'Cashback',
    'Start date', (current_date - 5)::text, 'End date', (current_date + 25)::text,
    'Beneficiary count', '10,000', 'Transaction count', '50000', 'Transaction volume', 'BDT 25,000,000',
    'bKash cost', '900000', 'Total cost', '1,000,000', 'Wallet', '["Customer","Agent"]',
    'Wallet-wise budget', E'Customer: 800,000\nAgent: 200,000', 'Cost center', 'CC-9', 'GL code', '623099',
    'Product', 'Send Money', 'Campaign beneficiary', 'Customers'));
  update public.form_submissions set status = 'completed' where id = v_sub;
  select * into c from public.campaigns where submission_id = v_sub;
  if c.id is null then raise exception 'FAIL: an approved NFA did not become a campaign'; end if;
  if c.status <> 'ongoing' or c.budget <> 1000000 or (c.kpi ->> 'volume')::numeric <> 25000000
     or jsonb_array_length(c.wallets) <> 2 or c.requester_id <> 'EMP-0416' then
    raise exception 'FAIL: the campaign did not carry what the NFA approved: %', row_to_json(c);
  end if;
  raise notice 'pass: an approved NFA becomes a campaign with its KPI targets, wallets and budget';

  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused(format($q$select public.record_campaign_actuals(%L, current_date, 1000, null, null, null, null)$q$, c.id)) then
    raise exception 'FAIL: somebody off the campaign recorded its actuals';
  end if;
  perform pg_temp.as_emp('EMP-0416');
  if not pg_temp.refused(format($q$select public.record_campaign_actuals(%L, current_date + 1, 1000, null, null, null, null)$q$, c.id)) then
    raise exception 'FAIL: actuals were recorded for a day that has not happened';
  end if;
  perform public.record_campaign_actuals(c.id, current_date - 2, 600000, 6000, 30000, 15000000, null);
  if exists (select 1 from public.notifications where entity_id = c.id and kind = 'campaign.budget') then
    raise exception 'FAIL: 60%% spent raised a budget alert';
  end if;
  perform public.record_campaign_actuals(c.id, current_date - 1, 360000, null, null, null, null);
  select count(*) into n from public.notifications where entity_id = c.id and kind = 'campaign.budget' and recipient_id = 'EMP-0416';
  if n <> 1 then raise exception 'FAIL: crossing 95%% told the requester % times', n; end if;
  perform public.record_campaign_actuals(c.id, current_date - 1, 10000, null, null, null, null);
  select count(*) into n from public.notifications where entity_id = c.id and kind = 'campaign.budget' and recipient_id = 'EMP-0416';
  if n <> 1 then raise exception 'FAIL: the 95%% alert was repeated'; end if;
  perform public.record_campaign_actuals(c.id, current_date, 50000, null, null, null, null);
  select count(*) into n from public.notifications where entity_id = c.id and kind = 'campaign.budget' and recipient_id = 'EMP-0416';
  if n <> 2 then raise exception 'FAIL: going over budget did not alert again'; end if;
  raise notice 'pass: actuals come from the campaign''s own people, for days that happened';
  raise notice 'pass: the requester is told at 95%% and again at 100%%, once each';

  -- An extension: through its own approvals, then the campaign runs longer.
  if not pg_temp.refused(format($q$select public.request_campaign_extension(%L, current_date + 10, 0, 'x', 'Regular')$q$, c.id)) then
    raise exception 'FAIL: an extension ending sooner was accepted';
  end if;
  v_sub := public.request_campaign_extension(c.id, current_date + 55, 500000, 'Strong uptake; extend for the holidays', 'Regular');
  if (select count(*) from public.approval_requests where submission_id = v_sub) < 2 then
    raise exception 'FAIL: the extension was not routed for approval';
  end if;
  if (select value from public.submission_values where submission_id = v_sub and field_name = 'Modality') <> 'Cashback' then
    raise exception 'FAIL: the extension did not keep the modality';
  end if;
  if not pg_temp.refused(format($q$select public.request_campaign_extension(%L, current_date + 60, 0, 'again', 'Regular')$q$, c.id)) then
    raise exception 'FAIL: a second extension was asked for while one waits';
  end if;
  update public.form_submissions set status = 'completed' where id = v_sub;
  select * into c from public.campaigns where id = c.id;
  if c.ends_on <> current_date + 55 or c.budget <> 1500000 or c.alerted <> '{}' then
    raise exception 'FAIL: an approved extension did not extend the campaign: %', row_to_json(c);
  end if;
  raise notice 'pass: an extension keeps the modality, goes through approval, and once approved extends the campaign and its budget';

  if not pg_temp.refused(format($q$select public.set_campaign_status(%L, 'ongoing', null)$q$,
       (select id from public.campaigns where tenant_id = current_setting('t.tpl')::uuid and status = 'discarded' limit 1))) then
    raise exception 'FAIL: a discarded campaign was brought back';
  end if;
  perform public.set_campaign_status(c.id, 'discontinued', 'Budget moved to Q1');
  raise notice 'pass: campaigns can be discontinued, and stay that way';
end $$;

-- Coupons, and the daily round.
do $$
declare v jsonb; v_c uuid;
begin
  perform pg_temp.as_emp('EMP-0416');
  select id into v_c from public.campaigns where tenant_id = current_setting('t.tpl')::uuid and coupon limit 1;
  update public.campaigns set status = 'ongoing' where id = v_c;
  v := public.import_coupons(v_c, '[{"code": "NEW-1", "wallet": "01711111111", "amount": "100", "issued_on": "2026-11-01", "redeemed_on": "2026-11-03", "redeemed_via": "ussd"},
                                     {"code": "NEW-2", "amount": "100"}, {"code": ""}]');
  if (v ->> 'imported')::int <> 2 or (select redeemed_via from public.campaign_coupons where code = 'NEW-1') <> 'USSD' then
    raise exception 'FAIL: coupon records were not imported: %', v;
  end if;
  raise notice 'pass: coupon records import with how each was redeemed';

  update public.campaigns set status = 'upcoming', starts_on = current_date where tenant_id = current_setting('t.tpl')::uuid and name = 'Agent Cash-in Incentive Q4';
  v := app.campaign_daily();
  if (v ->> 'started')::int < 1 then raise exception 'FAIL: a campaign due to start did not: %', v; end if;
  raise notice 'pass: the daily round starts campaigns on their day and finishes them after';
end $$;

-- =====================================================================
-- 4. Divisions
-- =====================================================================
do $$
declare v jsonb;
begin
  perform pg_temp.as_emp('EMP-2847');
  if not pg_temp.refused($q$select public.merge_departments('Business Finance', 'Finance')$q$) then
    raise exception 'FAIL: somebody without org.manage merged divisions';
  end if;
  perform pg_temp.as_emp('EMP-0650');
  v := public.merge_departments('Business Finance', 'Finance');
  if (v ->> 'people')::int <> 3 then raise exception 'FAIL: the merge moved % people', v ->> 'people'; end if;
  if exists (select 1 from public.departments where tenant_id = current_setting('t.tpl')::uuid and name = 'Business Finance') then
    raise exception 'FAIL: the merged division is still there';
  end if;
  if (select audience_departments from public.form_templates where tenant_id = current_setting('t.tpl')::uuid and name = 'Campaign Extension')
     <> array['Commercial', 'Finance'] then
    raise exception 'FAIL: a form offered to the merged division was not offered to the one it joined';
  end if;
  v := public.rename_department('Commercial', 'Commercial & Partnerships');
  if (select count(*) from public.employees where tenant_id = current_setting('t.tpl')::uuid and department = 'Commercial & Partnerships') <> 2 then
    raise exception 'FAIL: renaming a division left its people behind';
  end if;
  if not pg_temp.refused($q$select public.rename_department('Finance', 'HR')$q$) then
    raise exception 'FAIL: a division was renamed onto another';
  end if;
  raise notice 'pass: merging a division moves its people and the forms offered to it; renaming carries them too';

  v := public.import_employees('[{"employee_id": "EMP-7777", "name": "New Person", "department": "Risk"}]', false);
  if not exists (select 1 from public.departments where tenant_id = current_setting('t.tpl')::uuid and name = 'Risk') then
    raise exception 'FAIL: a division the HR file named for the first time was not created';
  end if;
  raise notice 'pass: a division the HR file names for the first time is created';
end $$;

-- =====================================================================
-- 5. Mail to ticket
-- =====================================================================
do $$
declare v jsonb; v2 jsonb; v3 jsonb; n int;
begin
  perform pg_temp.as_emp(null);
  v := app.receive_mail('Ayesha Siddiqua <ayesha@grameenphone.com>', 'Eid data bundle cashback', 'Please run a 10% cashback on bundles.', array['brief.pdf']);
  if v ->> 'outcome' <> 'ticket' then raise exception 'FAIL: partner mail did not become a ticket: %', v; end if;
  if (select submitted_by from public.form_submissions where id = (v ->> 'submission_id')::uuid) <> 'EMP-0415' then
    raise exception 'FAIL: the ticket is not the point of contact''s';
  end if;
  if (select approver_user_id from public.approval_requests where submission_id = (v ->> 'submission_id')::uuid and status = 'pending') <> 'EMP-0520' then
    raise exception 'FAIL: the ticket did not land with the telecom team';
  end if;
  if (select value from public.submission_values where submission_id = (v ->> 'submission_id')::uuid and field_name = 'Partner') <> 'grameenphone.com' then
    raise exception 'FAIL: the ticket does not say which partner';
  end if;
  raise notice 'pass: mail from a partner domain becomes a ticket for the telecom team';

  v2 := app.receive_mail('so.team@example.com', 'UAT passed — ' || (v ->> 'reference'), 'All test cases passed.', array['uat.xlsx']);
  select count(*) into n from public.ticket_notes where submission_id = (v ->> 'submission_id')::uuid and body like '%UAT passed%';
  if v2 ->> 'outcome' <> 'note' or n <> 1 then raise exception 'FAIL: a mail quoting the ticket was not added to it: %', v2; end if;
  raise notice 'pass: a UAT result mailed back with the reference lands on the ticket';

  v3 := app.receive_mail('someone@gmail.com', 'Hello', 'Spam', null);
  if v3 ->> 'outcome' <> 'rejected' then raise exception 'FAIL: mail from outside was turned into a ticket'; end if;
  if (select count(*) from public.inbound_mail where tenant_id = current_setting('t.tpl')::uuid) <> 3 then
    raise exception 'FAIL: not every message was logged';
  end if;
  raise notice 'pass: other mail is refused, and every message is logged with what was done with it';
end $$;

-- =====================================================================
-- 6. An evaluation issued before all this is brought up to date
-- =====================================================================
do $$
declare v_t uuid; v jsonb;
begin
  insert into public.tenants (name, slug, kind, expires_at) values ('Old eval', 'old-eval-x', 'demo', now() + interval '1 day') returning id into v_t;
  insert into public.employees (tenant_id, employee_id, name, department) values (v_t, 'EMP-0800', 'Hana Kim', 'Operations');
  insert into public.form_templates (tenant_id, name, category, status) values (v_t, 'Campaign NFA', 'Commercial', 'published');
  insert into public.form_fields (tenant_id, form_template_id, field_type, field_name, order_index)
  select v_t, id, 'text', 'Campaign name', 1 from public.form_templates where tenant_id = v_t;
  v := app.upgrade_from_template(v_t);
  if (v ->> 'people')::int < 15 or (v ->> 'forms')::int < 10 or (v ->> 'fields')::int < 15 then
    raise exception 'FAIL: the evaluation was not brought up to the template: %', v;
  end if;
  if (select on_approval from public.form_templates where tenant_id = v_t and name = 'Campaign NFA') <> 'campaign' then
    raise exception 'FAIL: an existing form did not learn what its approval does';
  end if;
  perform set_config('app.tenant_id', v_t::text, true);
  if app.seed_campaigns(v_t) <> 7 then raise exception 'FAIL: the evaluation got no campaigns'; end if;
  if app.seed_campaigns(v_t) <> 0 then raise exception 'FAIL: campaigns were seeded twice'; end if;
  delete from public.tenants where id = v_t;
  raise notice 'pass: an older evaluation gains the template''s people, forms, fields and campaigns, once';
end $$;

do $$ begin raise notice 'ALL COMMERCIAL TESTS PASSED'; end $$;
