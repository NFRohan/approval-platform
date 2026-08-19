-- =====================================================================
-- Can a record point across a tenant boundary?
--
-- Run against a database with 001 applied and nothing else. It creates
-- its own fixtures and rolls nothing back, so use a scratch database.
-- =====================================================================
do $$
declare
  t_a uuid; t_b uuid; f_a uuid; s_a uuid; ok boolean;
begin
  delete from public.tenants where slug in ('iso-a','iso-b');

  insert into public.tenants (name, slug, kind, expires_at)
  values ('Tenant A', 'iso-a', 'demo', now() + interval '1 day') returning id into t_a;
  insert into public.tenants (name, slug, kind, expires_at)
  values ('Tenant B', 'iso-b', 'demo', now() + interval '1 day') returning id into t_b;

  insert into public.employees (tenant_id, employee_id, name) values (t_a, 'EMP-0001', 'A Person');
  insert into public.employees (tenant_id, employee_id, name) values (t_b, 'EMP-0001', 'B Person');
  raise notice 'pass: the same employee id can exist in two tenants';

  insert into public.form_templates (tenant_id, name, created_by)
  values (t_a, 'A Form', 'EMP-0001') returning id into f_a;

  -- a field belonging to B, pointing at A's form
  ok := false;
  begin
    insert into public.form_fields (tenant_id, form_template_id, field_name)
    values (t_b, f_a, 'stolen');
  exception when foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL: a field attached to another tenant''s form'; end if;
  raise notice 'pass: a field cannot attach to another tenant''s form';

  -- an approval rule in B naming an employee of A
  ok := false;
  begin
    insert into public.form_templates (tenant_id, name) values (t_b, 'B Form');
    insert into public.approval_rules (tenant_id, form_template_id, approver_user_id)
    select t_b, id, 'EMP-0001' from public.form_templates where tenant_id = t_b limit 1;
    -- this one SUCCEEDS: B has its own EMP-0001, which is the point
    ok := true;
  exception when others then ok := false;
  end;
  if not ok then raise exception 'FAIL: a tenant could not reference its own employee'; end if;
  raise notice 'pass: a tenant can reference its own identically-named employee';

  insert into public.form_submissions (tenant_id, form_template_id, submitted_by)
  values (t_a, f_a, 'EMP-0001') returning id into s_a;

  -- an approval request in B against A's submission
  ok := false;
  begin
    insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index)
    values (t_b, s_a, 'EMP-0001', 0);
  exception when foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL: an approval was attached to another tenant''s submission'; end if;
  raise notice 'pass: an approval cannot attach to another tenant''s submission';

  -- two approvers cannot occupy the same rung
  insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index)
  values (t_a, s_a, 'EMP-0001', 0);
  ok := false;
  begin
    insert into public.approval_requests (tenant_id, submission_id, approver_user_id, step_index)
    values (t_a, s_a, 'EMP-0001', 0);
  exception when unique_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL: two approvals took the same step'; end if;
  raise notice 'pass: one approver per rung of the chain';

  -- stock cannot be reserved beyond what exists
  ok := false;
  begin
    insert into public.items (tenant_id, name) values (t_a, 'Chair');
    insert into public.venues (tenant_id, name) values (t_a, 'Floor 4');
    insert into public.item_stock (tenant_id, item_id, venue_id, quantity, reserved_quantity)
    select t_a, i.id, v.id, 5, 9 from public.items i, public.venues v
     where i.tenant_id = t_a and v.tenant_id = t_a limit 1;
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL: reserved more stock than exists'; end if;
  raise notice 'pass: stock cannot be over-reserved';

  delete from public.tenants where slug in ('iso-a','iso-b');
  raise notice 'ALL ISOLATION TESTS PASSED';
end $$;
