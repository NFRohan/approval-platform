-- =====================================================================
-- The working calendar.
--
-- Deadlines count working days (app.add_working_days, 005_chain.sql):
-- not Friday or Saturday, and not a day in public.holidays. This file is
-- how those days are kept: the government's list for a year loaded in
-- one step, a day added or moved by hand — the Eid dates once the moon
-- is sighted, a day the office closes — and nothing else.
--
-- The lists are the government's as gazetted: 2026 (Daily Star, 12
-- January 2026) and 2027 (Prothom Alo / BSS, 5 November 2026). General
-- and executive-order holidays both close the office; optional ones are
-- each employee's own and are not here. Chaitra Sankranti 2027 applies to
-- the three hill districts only and is left out. Days fixed by the moon
-- are marked provisional.
-- =====================================================================

begin;

do $p$
begin
  drop policy if exists holidays_member_read on public.holidays;
  create policy holidays_member_read on public.holidays for select to app_api
    using (tenant_id = app.current_tenant() and app.is_member());
end $p$;

-- The government's list, by year.
create or replace function app.public_holidays(p_year integer)
returns table (on_date date, name text, kind text, provisional boolean)
language sql
immutable
as $$
  select d::date, n, k, p from (values
    -- 2026
    ('2026-02-04', 'Shab-e-Barat', 'executive', true),
    ('2026-02-21', 'Shaheed Day and International Mother Language Day', 'general', false),
    ('2026-03-17', 'Shab-e-Qadr', 'executive', true),
    ('2026-03-19', 'Eid ul-Fitr holiday', 'executive', true),
    ('2026-03-20', 'Jumatul Bida · Eid ul-Fitr holiday', 'general', true),
    ('2026-03-21', 'Eid ul-Fitr', 'general', true),
    ('2026-03-22', 'Eid ul-Fitr holiday', 'executive', true),
    ('2026-03-23', 'Eid ul-Fitr holiday', 'executive', true),
    ('2026-03-26', 'Independence and National Day', 'general', false),
    ('2026-04-14', 'Pahela Baishakh (Bangla New Year)', 'executive', false),
    ('2026-05-01', 'May Day · Buddha Purnima', 'general', true),
    ('2026-05-26', 'Eid ul-Azha holiday', 'executive', true),
    ('2026-05-27', 'Eid ul-Azha holiday', 'executive', true),
    ('2026-05-28', 'Eid ul-Azha', 'general', true),
    ('2026-05-29', 'Eid ul-Azha holiday', 'executive', true),
    ('2026-05-30', 'Eid ul-Azha holiday', 'executive', true),
    ('2026-05-31', 'Eid ul-Azha holiday', 'executive', true),
    ('2026-06-26', 'Ashura', 'executive', true),
    ('2026-08-05', 'July Mass Uprising Day', 'general', false),
    ('2026-08-26', 'Eid-e-Miladunnabi', 'general', true),
    ('2026-09-04', 'Janmashtami', 'general', true),
    ('2026-10-20', 'Durga Puja (Mahanabami)', 'executive', true),
    ('2026-10-21', 'Durga Puja (Bijoya Dashami)', 'general', true),
    ('2026-12-16', 'Victory Day', 'general', false),
    ('2026-12-25', 'Christmas Day', 'general', false),
    -- 2027
    ('2027-01-24', 'Shab-e-Barat', 'executive', true),
    ('2027-02-21', 'Shaheed Day and International Mother Language Day', 'general', false),
    ('2027-03-05', 'Jumatul Bida', 'general', true),
    ('2027-03-07', 'Shab-e-Qadr', 'executive', true),
    ('2027-03-08', 'Eid ul-Fitr holiday', 'executive', true),
    ('2027-03-09', 'Eid ul-Fitr holiday', 'executive', true),
    ('2027-03-10', 'Eid ul-Fitr', 'general', true),
    ('2027-03-11', 'Eid ul-Fitr holiday', 'executive', true),
    ('2027-03-12', 'Eid ul-Fitr holiday', 'executive', true),
    ('2027-03-26', 'Independence and National Day', 'general', false),
    ('2027-04-14', 'Pahela Baishakh (Bangla New Year)', 'executive', false),
    ('2027-05-01', 'May Day', 'general', false),
    ('2027-05-15', 'Eid ul-Azha holiday', 'executive', true),
    ('2027-05-16', 'Eid ul-Azha holiday', 'executive', true),
    ('2027-05-17', 'Eid ul-Azha', 'general', true),
    ('2027-05-18', 'Eid ul-Azha holiday', 'executive', true),
    ('2027-05-19', 'Eid ul-Azha holiday', 'executive', true),
    ('2027-05-20', 'Buddha Purnima · Eid ul-Azha holiday', 'general', true),
    ('2027-06-16', 'Ashura', 'executive', true),
    ('2027-08-05', 'July Mass Uprising Day', 'general', false),
    ('2027-08-15', 'Eid-e-Miladunnabi', 'general', true),
    ('2027-08-25', 'Janmashtami', 'general', true),
    ('2027-10-09', 'Durga Puja (Nabami)', 'executive', true),
    ('2027-10-10', 'Durga Puja (Bijoya Dashami)', 'general', true),
    ('2027-11-07', 'National Revolution and Solidarity Day', 'general', false),
    ('2027-12-16', 'Victory Day', 'general', false),
    ('2027-12-25', 'Christmas Day', 'general', false)
  ) x(d, n, k, p)
  where extract(year from d::date) = p_year
$$;

create or replace function app.public_holiday_years()
returns integer[]
language sql
immutable
as $$ select array[2026, 2027] $$;

-- Load a year's list into this organisation's calendar. Days already in
-- it — an office closure, a date renamed — are left as they are, and a
-- holiday moved by hand is not put back on the day it was moved off.
create or replace function app.load_public_holidays(p_tenant uuid, p_year integer)
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_n integer;
begin
  insert into public.holidays (tenant_id, on_date, name, kind, provisional, created_by)
  select p_tenant, h.on_date, h.name, h.kind, h.provisional, app.current_employee()
    from app.public_holidays(p_year) h
   where not exists (select 1 from public.holidays x where x.tenant_id = p_tenant and x.moved_from = h.on_date)
  on conflict (tenant_id, on_date) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.load_public_holidays(p_year integer)
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_n integer;
begin
  perform app.require_permission('org.manage');
  if p_year <> all (app.public_holiday_years()) then
    raise exception 'the government''s list for % is not in the system yet — add its days by hand', p_year;
  end if;
  v_n := app.load_public_holidays(app.current_tenant(), p_year);
  perform app.audit('holidays_loaded', 'tenant', null::uuid, format('%s public holidays for %s', v_n, p_year));
  return v_n;
end $$;

-- A day added, renamed or moved; one day at a time.
create or replace function public.save_holiday(p_on date, p_name text, p_kind text, p_provisional boolean, p_moved_from date)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_id uuid; v_origin date;
begin
  perform app.require_permission('org.manage');
  if p_on is null then raise exception 'choose the day'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name the holiday'; end if;
  if coalesce(p_kind, 'general') not in ('general', 'executive', 'office') then raise exception 'a holiday is general, executive or office'; end if;
  if extract(isodow from p_on) in (5, 6) then raise exception 'that is a Friday or Saturday, which is not worked anyway'; end if;

  -- The moon is sighted a day late: the holiday moves, rather than a
  -- second one being added.
  if p_moved_from is not null and p_moved_from <> p_on then
    -- Moved twice, it still remembers the day it was first listed on.
    delete from public.holidays where tenant_id = app.current_tenant() and on_date = p_moved_from
    returning coalesce(moved_from, on_date) into v_origin;
  end if;
  insert into public.holidays (tenant_id, on_date, name, kind, provisional, created_by, moved_from)
  values (app.current_tenant(), p_on, trim(p_name), coalesce(p_kind, 'general'), coalesce(p_provisional, false), app.current_employee(), v_origin)
  on conflict (tenant_id, on_date) do update
    set name = excluded.name, kind = excluded.kind, provisional = excluded.provisional, created_by = excluded.created_by,
        moved_from = coalesce(excluded.moved_from, public.holidays.moved_from)
  returning id into v_id;
  perform app.audit(case when p_moved_from is not null and p_moved_from <> p_on then 'holiday_moved' else 'holiday_saved' end,
                    'tenant', null::uuid,
                    trim(p_name) || ' on ' || to_char(p_on, 'DD/MM/YYYY')
                    || case when p_moved_from is not null and p_moved_from <> p_on then ' (was ' || to_char(p_moved_from, 'DD/MM/YYYY') || ')' else '' end);
  return v_id;
end $$;

create or replace function public.delete_holiday(p_on date)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_name text;
begin
  perform app.require_permission('org.manage');
  delete from public.holidays where tenant_id = app.current_tenant() and on_date = p_on returning name into v_name;
  if v_name is null then raise exception 'there is no holiday on that day'; end if;
  perform app.audit('holiday_removed', 'tenant', null::uuid, v_name || ' on ' || to_char(p_on, 'DD/MM/YYYY'));
end $$;

-- When N working days from now falls: what a deadline set today means.
create or replace function public.working_days_from(p_from date, p_days integer)
returns date
language sql
stable
as $$
  select (app.add_working_days((p_from::timestamp + time '12:00') at time zone 'Asia/Dhaka', p_days) at time zone 'Asia/Dhaka')::date
$$;

-- Every organisation keeps both years' lists from the start.
create or replace function app.seed_holidays(p_tenant uuid)
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_n integer := 0; y integer;
begin
  if (select holidays_seeded from public.tenants where id = p_tenant) then return 0; end if;
  foreach y in array app.public_holiday_years() loop
    v_n := v_n + app.load_public_holidays(p_tenant, y);
  end loop;
  update public.tenants set holidays_seeded = true where id = p_tenant;
  return v_n;
end $$;

grant execute on function
  public.load_public_holidays(integer),
  public.save_holiday(date, text, text, boolean, date),
  public.delete_holiday(date),
  public.working_days_from(date, integer)
to app_api;
grant execute on all functions in schema app to app_api;

commit;
