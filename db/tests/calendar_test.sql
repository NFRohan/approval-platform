-- =====================================================================
-- The working calendar.
--
-- On a fresh evaluation: it starts with the government's holidays for
-- both years; a deadline counted across the Eid break lands after it;
-- an organisation without them counts only weekends; and only somebody
-- who keeps the org chart may add, move or remove a day.
--
-- Every check raises on failure, so reaching the last line is the pass.
-- =====================================================================

\set ON_ERROR_STOP on

select set_config('app.is_staff', 'true', false);
select set_config('t.tpl', (select tenant_id::text from app.provision_demo(
  'Calendar Test', 'calendar.test.' || substr(md5(random()::text), 1, 8), 'hash', interval '1 day')), false);
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

-- =====================================================================
-- 1. The government's lists, and deadlines counted around them
-- =====================================================================
do $$
declare v_t uuid := current_setting('t.tpl')::uuid; v_other uuid;
begin
  if (select count(*) from public.holidays where tenant_id = v_t)
     <> (select count(*) from app.public_holidays(2026)) + (select count(*) from app.public_holidays(2027)) then
    raise exception 'FAIL: the evaluation does not have both years'' holidays';
  end if;
  if not exists (select 1 from public.holidays where tenant_id = v_t and on_date = '2027-03-10' and name = 'Eid ul-Fitr' and provisional) then
    raise exception 'FAIL: Eid ul-Fitr 2027 is missing, or not marked as depending on the moon';
  end if;
  if exists (select 1 from public.holidays where tenant_id = v_t and on_date = '2026-12-16' and provisional) then
    raise exception 'FAIL: Victory Day is marked as depending on the moon';
  end if;

  -- Thursday 4 March 2027, three working days: the Eid break runs from
  -- Sunday 7th (Shab-e-Qadr) to Thursday 11th, then the weekend.
  perform set_config('app.tenant_id', v_t::text, true);
  if public.working_days_from('2027-03-04', 3) <> '2027-03-16' then
    raise exception 'FAIL: three working days from 4 March 2027 is %, not 16 March', public.working_days_from('2027-03-04', 3);
  end if;
  if app.add_working_days(timestamptz '2027-03-04 10:00+06', 1, v_t) <> timestamptz '2027-03-14 10:00+06' then
    raise exception 'FAIL: one working day from 4 March 2027 is not Sunday the 14th';
  end if;
  -- Victory Day is a Thursday in 2027: Wednesday's one-day deadline is Sunday.
  if public.working_days_from('2027-12-15', 1) <> '2027-12-19' then
    raise exception 'FAIL: a day''s deadline on the eve of Victory Day does not skip it';
  end if;

  -- An organisation with no calendar counts only the weekend.
  insert into public.tenants (name, slug, kind, expires_at) values ('No calendar', 'no-calendar-x', 'demo', now() + interval '1 day') returning id into v_other;
  if app.add_working_days(timestamptz '2027-03-04 10:00+06', 3, v_other) <> timestamptz '2027-03-09 10:00+06' then
    raise exception 'FAIL: another organisation''s holidays were counted';
  end if;
  delete from public.tenants where id = v_other;
  raise notice 'pass: an evaluation has the government''s holidays for 2026 and 2027, and deadlines step over them — its own, not another''s';
end $$;

-- =====================================================================
-- 2. Keeping the calendar
-- =====================================================================
begin;
  set local role app_api;
do $$
declare v_n int;
begin
  perform pg_temp.as_emp('EMP-2847');   -- Tom keeps no org chart
  if not pg_temp.refused($q$select public.save_holiday('2027-07-01', 'Bank holiday', 'office', false, null)$q$) then
    raise exception 'FAIL: somebody without org.manage added a holiday';
  end if;
  if (select count(*) from public.holidays) = 0 then
    raise exception 'FAIL: members cannot read the calendar their deadlines are counted on';
  end if;

  perform pg_temp.as_emp('EMP-0650');   -- Priya: HR administrator, org.manage
  if not pg_temp.refused($q$select public.save_holiday('2027-07-02', 'Friday', 'office', false, null)$q$) then
    raise exception 'FAIL: a Friday was added as a holiday';
  end if;
  perform public.save_holiday('2027-07-01', 'Bank holiday (half-yearly closing)', 'office', false, null);
  if public.working_days_from('2027-06-30', 1) <> '2027-07-04' then
    raise exception 'FAIL: an office closure is not skipped';
  end if;

  -- The moon is sighted a day later: Ashura moves.
  perform public.save_holiday('2027-06-17', 'Ashura', 'executive', false, '2027-06-16');
  if exists (select 1 from public.holidays where on_date = '2027-06-16')
     or not exists (select 1 from public.holidays where on_date = '2027-06-17' and name = 'Ashura' and not provisional) then
    raise exception 'FAIL: moving a holiday left the old day or did not confirm the new one';
  end if;
  if not exists (select 1 from public.activity_log where action = 'holiday_moved' and detail like 'Ashura on 17/06/2027 (was 16/06/2027)%') then
    raise exception 'FAIL: moving a holiday was not recorded';
  end if;

  perform public.delete_holiday('2027-07-01');
  if exists (select 1 from public.holidays where on_date = '2027-07-01') then raise exception 'FAIL: the closure was not removed'; end if;
  if not pg_temp.refused($q$select public.delete_holiday('2027-07-01')$q$) then raise exception 'FAIL: a day was removed twice'; end if;

  perform public.delete_holiday('2027-12-25');
  v_n := public.load_public_holidays(2027);
  if v_n <> 1 or not exists (select 1 from public.holidays where on_date = '2027-12-25') then
    raise exception 'FAIL: reloading the 2027 list did not put back what was missing (% added)', v_n;
  end if;
  if exists (select 1 from public.holidays where on_date = '2027-06-16') then
    raise exception 'FAIL: reloading the list put Ashura back on the day it was moved off';
  end if;
  if not pg_temp.refused('select public.load_public_holidays(2031)') then
    raise exception 'FAIL: a year the system has no list for was loaded';
  end if;
end $$;
  reset role;
commit;
do $$ begin raise notice 'pass: only org.manage keeps the calendar; office closures count; a holiday moves when the moon says so, is recorded, and stays moved when the list is reloaded'; end $$;

delete from public.tenants where id = current_setting('t.tpl')::uuid;

do $$ begin raise notice 'ALL CALENDAR TESTS PASSED'; end $$;
