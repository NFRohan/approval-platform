-- =====================================================================
-- The template tenant.
--
-- Every evaluation is cloned from this, so a prospect opens a populated
-- system rather than empty tables. It has to cover every screen: an org
-- chart deep enough for a chain of command, forms in all three
-- categories, submissions at different stages, stock, notices,
-- stationery, maintenance and a trail of activity.
--
-- Written fresh rather than ported. The previous seed created every
-- approval as `pending` with no ordering, so porting it faithfully would
-- have imported the defect this rebuild exists to fix. Its people and
-- identifiers named the client, which full de-branding removes anyway.
--
-- Applied last, because it calls the chain engine to build its own
-- approval chains — the seed cannot run before the functions exist.
--
-- Re-runnable: the template is removed and rebuilt, so applying twice
-- leaves one copy rather than two. Demo tenants are independent clones
-- and are untouched.
-- =====================================================================

begin;

-- Seeding writes notifications; none of them is to be emailed.
select set_config('app.no_mail', 'true', true);

-- Everything below inserts unconditionally, so clear any previous
-- template first. The cascade takes its rows with it.
delete from public.tenants where kind = 'template';

insert into public.tenants (name, slug, kind, notes)
values ('Template', 'template', 'template', 'Source data cloned into every new evaluation');

select set_config('app.tenant_id',
                  (select id::text from public.tenants where slug = 'template'), false);

-- The working calendar first: every deadline below is counted on it.
select app.seed_holidays(app.current_tenant());

-- =====================================================================
-- 1. The org chart
--
-- Deep enough to walk an approval up three levels, which is the thing
-- worth demonstrating. Managers are inserted before their reports
-- because line_manager_id references an employee of the same tenant.
-- =====================================================================
insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-0700', 'Alex Mercer',      'Chief Financial Officer', 'Finance',    null,       'CARD-0700'),
  ('EMP-0650', 'Priya Raman',      'Head of People',          'HR',         null,       'CARD-0650');

insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-0600', 'Dana Whitfield',   'Head of Finance',         'Finance',    'EMP-0700', 'CARD-0600'),
  ('EMP-0201', 'Nadia Okonjo',     'HR Business Partner',     'HR',         'EMP-0650', 'CARD-0201');

insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-0312', 'Raj Patel',        'Finance Controller',      'Finance',    'EMP-0600', 'CARD-0312'),
  ('EMP-0445', 'Farah Haddad',     'Admin Officer',           'Admin',      'EMP-0201', 'CARD-0445');

insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-1134', 'Sam Lindqvist',    'Line Manager',            'Operations', 'EMP-0201', 'CARD-1134'),
  ('EMP-9001', 'Ivan Petrov',      'Facilities Coordinator',  'Admin',      'EMP-0445', 'CARD-9001');

insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-2847', 'Tom Bexley',       'Operations Analyst',      'Operations', 'EMP-1134', 'CARD-2847'),
  ('EMP-3120', 'Mei Sun',          'Procurement Specialist',  'Operations', 'EMP-1134', 'CARD-3120');

-- The rest of the organisation the scope of work's flows need: an
-- operations CXO, the head of technology who clears IT for leavers, and
-- the compliance officers who review gift and hospitality declarations.
insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-0800', 'Hana Kim',         'Chief Operating Officer', 'Operations', null,       'CARD-0800');

insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-0520', 'Omar Reyes',       'Head of Technology',      'Product & Technology', 'EMP-0800', 'CARD-0520'),
  ('EMP-0830', 'Lena Ortiz',       'Compliance Officer',      'Compliance', 'EMP-0700', 'CARD-0830'),
  ('EMP-0831', 'Kofi Mensah',      'Compliance Officer',      'Compliance', 'EMP-0700', 'CARD-0831'),
  ('EMP-0832', 'Ravi Shah',        'Compliance Officer',      'Compliance', 'EMP-0700', 'CARD-0832');

-- Business Finance, who review campaign requests, and the Commercial
-- team who raise them and take partners' requests by email.
insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-0410', 'Nusrat Jahan',     'Business Finance Lead',   'Business Finance', 'EMP-0600', 'CARD-0410'),
  ('EMP-0416', 'Mitu Rahman',      'Campaign & Promotion Manager', 'Commercial', 'EMP-0800', 'CARD-0416'),
  ('EMP-0415', 'Shahriar Kabir',   'Telecom Partnerships Manager', 'Commercial', 'EMP-0800', 'CARD-0415');
insert into public.employees (employee_id, name, designation, department, line_manager_id, gate_pass_card_number) values
  ('EMP-0411', 'Tanvir Hasan',     'Business Finance Analyst', 'Business Finance', 'EMP-0410', 'CARD-0411'),
  ('EMP-0412', 'Farzana Akter',    'Business Finance Analyst', 'Business Finance', 'EMP-0410', 'CARD-0412');

-- Who heads each department, its HR business partner and its CXO — the
-- roles a rule can name besides the line manager. Operations is headed
-- by the line manager most of its people report to, which is the case
-- the clearance flow means by "layers may be the same person".
insert into public.departments (name, head_employee_id, hrbp_employee_id, cxo_employee_id) values
  ('Operations',           'EMP-1134', 'EMP-0201', 'EMP-0800'),
  ('Finance',              'EMP-0600', 'EMP-0201', 'EMP-0700'),
  ('HR',                   'EMP-0650', 'EMP-0201', 'EMP-0650'),
  ('Admin',                'EMP-0445', 'EMP-0201', 'EMP-0800'),
  ('Product & Technology', 'EMP-0520', 'EMP-0201', 'EMP-0800'),
  ('Compliance',           'EMP-0700', 'EMP-0201', 'EMP-0700'),
  ('Business Finance',     'EMP-0410', 'EMP-0201', 'EMP-0700'),
  ('Commercial',           'EMP-0800', 'EMP-0201', 'EMP-0800');

-- =====================================================================
-- 2. Form templates
-- =====================================================================
insert into public.form_templates (id, name, category, created_by, status) values
  ('11111111-0000-4000-8000-000000000001', 'Travel & Expense Reimbursement', 'Finance', 'EMP-0312', 'published'),
  ('11111111-0000-4000-8000-000000000002', 'Leave Application',              'HR',      'EMP-0201', 'published'),
  ('11111111-0000-4000-8000-000000000003', 'IT System Access Request',       'Admin',   'EMP-0445', 'published'),
  ('11111111-0000-4000-8000-000000000004', 'Gate Pass',                      'Admin',   'EMP-0445', 'published'),
  ('11111111-0000-4000-8000-000000000005', 'New Employee Onboarding',        'HR',      'EMP-0201', 'published'),
  ('11111111-0000-4000-8000-000000000006', 'Capital Expenditure Request',    'Finance', 'EMP-0312', 'published');

insert into public.form_fields (form_template_id, field_type, field_name, order_index, is_required, field_config) values
  -- Travel & Expense: the money field is what pulls in the finance chain
  ('11111111-0000-4000-8000-000000000001', 'gen_employee_name',   'Employee name',      0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000001', 'text',       'Purpose of travel',  1, true,  '{"placeholder":"Client visit, conference…"}'),
  ('11111111-0000-4000-8000-000000000001', 'date',       'Travel date',        2, true,  '{}'),
  ('11111111-0000-4000-8000-000000000001', 'money',      'Amount claimed',     3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000001', 'textarea',   'Notes',              4, false, '{"placeholder":"Anything the approver should know"}'),

  ('11111111-0000-4000-8000-000000000002', 'gen_employee_name',   'Employee name',      0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000002', 'select',     'Leave type',         1, true,  '{"options":["Annual","Sick","Unpaid","Parental"]}'),
  ('11111111-0000-4000-8000-000000000002', 'date',       'From',               2, true,  '{}'),
  ('11111111-0000-4000-8000-000000000002', 'date',       'To',                 3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000002', 'textarea',   'Reason',             4, false, '{}'),

  ('11111111-0000-4000-8000-000000000003', 'gen_employee_name',   'Employee name',      0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000003', 'select',     'System',             1, true,  '{"options":["Finance ledger","HR records","Source control","Analytics"]}'),
  ('11111111-0000-4000-8000-000000000003', 'select',     'Access level',       2, true,  '{"options":["Read only","Contributor","Administrator"]}'),
  ('11111111-0000-4000-8000-000000000003', 'textarea',   'Justification',      3, true,  '{}'),

  ('11111111-0000-4000-8000-000000000004', 'gen_employee_name',   'Employee name',      0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000004', 'gen_gate_pass',   'Gate pass card',     1, true,  '{}'),
  ('11111111-0000-4000-8000-000000000004', 'select',     'Pass type',          2, true,  '{"options":["Returnable","Non-Returnable","Daily"]}'),
  ('11111111-0000-4000-8000-000000000004', 'text',       'Item description',   3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000004', 'number',     'Quantity',           4, true,  '{}'),
  ('11111111-0000-4000-8000-000000000004', 'date',       'Expected return',    5, false, '{}'),

  ('11111111-0000-4000-8000-000000000005', 'text',       'New starter name',   0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000005', 'date',       'Start date',         1, true,  '{}'),
  ('11111111-0000-4000-8000-000000000005', 'select',     'Department',         2, true,  '{"options":["Finance","HR","Admin","Operations"]}'),
  ('11111111-0000-4000-8000-000000000005', 'checkbox',   'Laptop required',    3, false, '{}');

-- =====================================================================
-- 3. Approval configuration
--
-- step_index is what makes the chain a chain. The line manager is always
-- first; finance follows, and which finance approvers are involved
-- depends on the amount.
-- =====================================================================
-- Notices are chains too, configured once for the whole subject type
-- rather than per template.
insert into public.approval_rules (subject_type, form_template_id, approver_user_id, deadline_days, is_auto_added, label, step_index) values
  ('notice',              null, 'EMP-1134', 2, true, 'line_manager', 0),
  ('notice',              null, 'EMP-0445', 3, true, 'admin',        1);

insert into public.approval_rules (form_template_id, approver_user_id, deadline_days, is_auto_added, label, step_index) values
  ('11111111-0000-4000-8000-000000000001', 'EMP-1134', 3, true,  'line_manager',  0),
  ('11111111-0000-4000-8000-000000000001', null,       5, true,  'slab_finance',  1),
  ('11111111-0000-4000-8000-000000000002', 'EMP-1134', 2, true,  'line_manager',  0),
  ('11111111-0000-4000-8000-000000000002', 'EMP-0201', 3, false, 'hr',            1),
  ('11111111-0000-4000-8000-000000000003', 'EMP-1134', 2, true,  'line_manager',  0),
  ('11111111-0000-4000-8000-000000000003', 'EMP-0445', 3, false, 'admin',         1),
  ('11111111-0000-4000-8000-000000000004', 'EMP-0445', 2, false, 'admin',         0),
  ('11111111-0000-4000-8000-000000000005', 'EMP-0201', 3, false, 'hr',            0),
  ('11111111-0000-4000-8000-000000000005', 'EMP-0650', 5, false, 'head_of_people',1);

-- The bands a claim climbs through. With cumulative escalation a claim
-- of 600,000 involves all three, in this order — not the top one alone.
-- Extending a live campaign, and a partner's request by email with the
-- NFA that follows it.
insert into public.form_templates (id, name, category, created_by, status, audience_departments) values
  ('11111111-0000-4000-8000-000000000011', 'Campaign Extension',   'Commercial', 'EMP-0312', 'published', array['Commercial', 'Business Finance']),
  ('11111111-0000-4000-8000-000000000013', 'MNO Campaign NFA',     'Commercial', 'EMP-0415', 'published', array['Commercial']);
insert into public.form_templates (id, name, category, created_by, status, audience_departments, followup_template_id) values
  ('11111111-0000-4000-8000-000000000012', 'MNO Campaign Request', 'Commercial', 'EMP-0415', 'published', array['Commercial'],
   '11111111-0000-4000-8000-000000000013');

insert into public.form_fields (form_template_id, field_type, field_name, order_index, is_required, field_config) values
  ('11111111-0000-4000-8000-000000000011', 'text',     'Campaign',               0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000011', 'text',     'Modality',               1, true,  '{"helper":"An extension keeps the modality it was approved with"}'),
  ('11111111-0000-4000-8000-000000000011', 'date',     'Current end date',       2, true,  '{}'),
  ('11111111-0000-4000-8000-000000000011', 'date',     'New end date',           3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000011', 'money',    'Additional budget',      4, true,  '{}'),
  ('11111111-0000-4000-8000-000000000011', 'textarea', 'Updated business case',  5, true,  '{}'),
  ('11111111-0000-4000-8000-000000000011', 'select',   'Approval route',         6, true,  '{"options":["Regular","Exceptional"]}'),

  ('11111111-0000-4000-8000-000000000012', 'text',     'Partner',                0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000012', 'email',    'Sender',                 1, true,  '{}'),
  ('11111111-0000-4000-8000-000000000012', 'text',     'Subject',                2, true,  '{}'),
  ('11111111-0000-4000-8000-000000000012', 'textarea', 'Request details',        3, true,  '{}'),

  ('11111111-0000-4000-8000-000000000013', 'text',     'Partner',                0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000013', 'text',     'Subject',                1, true,  '{}'),
  ('11111111-0000-4000-8000-000000000013', 'textarea', 'Request details',        2, true,  '{}'),
  ('11111111-0000-4000-8000-000000000013', 'select',   'NFA type',               3, true,  '{"options":["Information only","Requires SO configuration"]}'),
  ('11111111-0000-4000-8000-000000000013', 'money',    'Total cost',             4, true,  '{}'),
  ('11111111-0000-4000-8000-000000000013', 'textarea', 'Finance notes',          5, false, '{}');

insert into public.approval_rules
  (form_template_id, approver_user_id, deadline_days, is_auto_added, label, step_index, position, lane, quorum, stage_label, condition) values
  ('11111111-0000-4000-8000-000000000011', 'EMP-0800', 2, false, 'cxo_exception',     0, 0, null, null, 'Exceptional approval',
   '{"field": "Approval route", "op": "eq", "value": "Exceptional"}'),
  ('11111111-0000-4000-8000-000000000011', 'EMP-0410', 2, false, 'business_finance',  1, 0, null, null, 'Business finance review', null),
  ('11111111-0000-4000-8000-000000000011', null,       2, false, 'department_head',   2, 0, null, null, null, null),
  -- The telecom team checks a partner's request ...
  ('11111111-0000-4000-8000-000000000012', 'EMP-0520', 2, false, 'telecom_check',     0, 0, null, null, 'Telecom check', null),
  -- ... and the NFA after it goes to the heads, then to SO for
  -- configuration when it needs it.
  ('11111111-0000-4000-8000-000000000013', null,       2, false, 'department_head',   0, 0, null, null, 'Head of department', null),
  ('11111111-0000-4000-8000-000000000013', 'EMP-0410', 2, false, 'business_finance',  1, 0, null, null, 'Business finance review', null),
  ('11111111-0000-4000-8000-000000000013', 'EMP-0520', 3, false, 'so_configuration',  2, 0, null, null, 'SO configuration',
   '{"field": "NFA type", "op": "eq", "value": "Requires SO configuration"}');

insert into public.approval_slabs (form_template_id, min_amount, max_amount, approver_user_id, order_index) values
  ('11111111-0000-4000-8000-000000000001', 0,           100000, 'EMP-0312', 0),
  ('11111111-0000-4000-8000-000000000001', 100000.01,   500000, 'EMP-0600', 1),
  ('11111111-0000-4000-8000-000000000001', 500000.01,   null,   'EMP-0700', 2);

insert into public.notification_rules (form_template_id, notifyee_user_id, is_auto_added, label) values
  ('11111111-0000-4000-8000-000000000001', 'EMP-0312', true,  'finance_watch'),
  ('11111111-0000-4000-8000-000000000002', 'EMP-0201', true,  'hr_watch');

insert into public.delegation_rules (delegator_id, delegate_id, start_date, end_date, reason, form_template_ids) values
  ('EMP-0600', 'EMP-0312', current_date - 2, current_date + 5, 'Annual leave',
   array['11111111-0000-4000-8000-000000000001'::uuid]);

-- =====================================================================
-- 3a. The flows from the scope of work
--
-- Exit clearance: the leaver's own division signs off in order — line
-- manager, head of department, HR business partner, CXO — while Finance,
-- Supply Chain, Administration and Technology clear them at the same
-- time; HR settles only once all five have.
--
-- Gift & hospitality declaration: the line manager, then any two of the
-- three compliance officers, then finance by value.
--
-- Campaign request: the CXO first only on the exceptional route; then
-- business finance and the head of department. Approval starts the
-- campaign NFA for the same requester, preloaded.
-- =====================================================================
insert into public.form_templates (id, name, category, created_by, status) values
  ('11111111-0000-4000-8000-000000000007', 'Employee Exit Clearance',        'HR',         'EMP-0201', 'published'),
  ('11111111-0000-4000-8000-000000000008', 'Gift & Hospitality Declaration', 'Compliance', 'EMP-0830', 'published'),
  ('11111111-0000-4000-8000-000000000010', 'Campaign NFA',                   'Commercial', 'EMP-0312', 'published');
insert into public.form_templates (id, name, category, created_by, status, followup_template_id) values
  ('11111111-0000-4000-8000-000000000009', 'Campaign Request',               'Commercial', 'EMP-0312', 'published',
   '11111111-0000-4000-8000-000000000010');

insert into public.form_fields (form_template_id, field_type, field_name, order_index, is_required, field_config) values
  ('11111111-0000-4000-8000-000000000007', 'gen_employee_name', 'Employee name',        0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000007', 'select',     'Reason for leaving',          1, true,  '{"options":["Resignation","Retirement","End of contract","Termination"]}'),
  ('11111111-0000-4000-8000-000000000007', 'date',       'Resignation date',            2, true,  '{}'),
  ('11111111-0000-4000-8000-000000000007', 'date',       'Last working day',            3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000007', 'section_header', 'Final settlement bank account', 4, false, '{}'),
  ('11111111-0000-4000-8000-000000000007', 'text',       'Bank name',                   5, true,  '{}'),
  ('11111111-0000-4000-8000-000000000007', 'text',       'Branch',                      6, true,  '{}'),
  ('11111111-0000-4000-8000-000000000007', 'text',       'Account name',                7, true,  '{}'),
  ('11111111-0000-4000-8000-000000000007', 'text',       'Account number',              8, true,  '{}'),
  ('11111111-0000-4000-8000-000000000007', 'file',       'Handover note',               9, false, '{}'),
  ('11111111-0000-4000-8000-000000000007', 'checkbox',   'I confirm all company assets will be returned and the account above may receive my final settlement', 10, true, '{}'),

  ('11111111-0000-4000-8000-000000000008', 'gen_employee_name', 'Employee name',        0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000008', 'select',     'Declaration type',            1, true,  '{"options":["Gift received","Gift given","Hospitality","Entertainment","Political donation","Charitable donation"]}'),
  ('11111111-0000-4000-8000-000000000008', 'text',       'Counterparty',                2, true,  '{"placeholder":"Vendor, person or organisation"}'),
  ('11111111-0000-4000-8000-000000000008', 'date',       'Event date',                  3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000008', 'money',      'Value',                       4, true,  '{}'),
  ('11111111-0000-4000-8000-000000000008', 'text',       'Reference number',            5, false, '{}'),
  ('11111111-0000-4000-8000-000000000008', 'file',       'Supporting document',         6, false, '{}'),

  ('11111111-0000-4000-8000-000000000009', 'gen_employee_name', 'Employee name',        0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000009', 'text',       'Campaign name',               1, true,  '{}'),
  ('11111111-0000-4000-8000-000000000009', 'select',     'Audience',                    2, true,  '{"options":["Customer","Agent","Merchant","Distributor","Field force","Internal"]}'),
  ('11111111-0000-4000-8000-000000000009', 'select',     'Approval route',              3, true,  '{"options":["Regular","Exceptional"]}'),
  ('11111111-0000-4000-8000-000000000009', 'number',     'Budget',                      4, true,  '{}'),
  ('11111111-0000-4000-8000-000000000009', 'textarea',   'Business case',               5, true,  '{}'),
  ('11111111-0000-4000-8000-000000000009', 'reviewer',   'Business finance reviewer',   6, false,
   '{"team": "Business Finance", "ccTeam": true, "helper": "Who in Business Finance reviews it. People on leave cannot be chosen; the whole team is copied."}'),
  ('11111111-0000-4000-8000-000000000009', 'file',       'NFA document',                7, false, '{"helper": "The vetted NFA and business case, as a Word file"}'),

  ('11111111-0000-4000-8000-000000000010', 'gen_employee_name', 'Employee name',        0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'text',       'Campaign name',               1, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'select',     'Audience',                    2, true,  '{"options":["Customer","Agent","Merchant","Distributor","Field force","Internal"]}'),
  ('11111111-0000-4000-8000-000000000010', 'select',     'Modality',                    3, true,  '{"options":["Cashback","Discount","Coupon","Bonus","Free transfer"]}'),
  ('11111111-0000-4000-8000-000000000010', 'date',       'Start date',                  4, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'date',       'End date',                    5, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'section_header', 'KPI section',             6, false, '{}'),
  ('11111111-0000-4000-8000-000000000010', 'number',     'Beneficiary count',           7, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'number',     'Transaction count',           8, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'number',     'Transaction volume',          9, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'number',     'bKash cost',                 10, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'money',      'Total cost',                 11, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'section_header', 'Reporting section',      12, false, '{}'),
  ('11111111-0000-4000-8000-000000000010', 'multi_select', 'Wallet',                   13, true,  '{"options":["Customer","Agent","Merchant","Distributor"],"allowOther":true}'),
  ('11111111-0000-4000-8000-000000000010', 'textarea',   'Wallet-wise budget',         14, true,  '{"placeholder":"One wallet a line, e.g. Customer: 2,000,000"}'),
  ('11111111-0000-4000-8000-000000000010', 'text',       'Cost center',                15, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'text',       'GL code',                    16, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'text',       'Product',                    17, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'text',       'Campaign beneficiary',       18, true,  '{}'),
  ('11111111-0000-4000-8000-000000000010', 'file',       'Business case document',     19, false, '{}'),

  ('11111111-0000-4000-8000-000000000006', 'textarea',   'PO lines',                    6, false,
   '{"placeholder":"One PO a line: PO number | description | amount","helper":"Printed on the payment top sheet"}');

insert into public.approval_rules
  (form_template_id, approver_user_id, deadline_days, is_auto_added, label, step_index, position, lane, quorum, stage_label, condition) values
  -- Exit clearance: five lanes at once, then HR.
  ('11111111-0000-4000-8000-000000000007', 'EMP-1134', 2, false, 'line_manager',    0, 0, 'Own division',         null, 'Departmental clearance', null),
  ('11111111-0000-4000-8000-000000000007', null,       2, false, 'department_head', 0, 1, 'Own division',         null, 'Departmental clearance', null),
  ('11111111-0000-4000-8000-000000000007', null,       2, false, 'hrbp',            0, 2, 'Own division',         null, 'Departmental clearance', null),
  ('11111111-0000-4000-8000-000000000007', null,       2, false, 'cxo',             0, 3, 'Own division',         null, 'Departmental clearance', null),
  ('11111111-0000-4000-8000-000000000007', 'EMP-0312', 3, false, 'finance',         0, 4, 'Finance & Accounts',   null, 'Departmental clearance', null),
  ('11111111-0000-4000-8000-000000000007', 'EMP-3120', 3, false, 'scm',             0, 5, 'Supply Chain',         null, 'Departmental clearance', null),
  ('11111111-0000-4000-8000-000000000007', 'EMP-0445', 3, false, 'admin',           0, 6, 'Administration',       null, 'Departmental clearance', null),
  ('11111111-0000-4000-8000-000000000007', 'EMP-0520', 3, false, 'technology',      0, 7, 'Product & Technology', null, 'Departmental clearance', null),
  ('11111111-0000-4000-8000-000000000007', 'EMP-0650', 3, false, 'hr_final',        1, 0, null,                   null, 'Final settlement',       null),

  -- Gift & hospitality: line manager, any two of three officers, then finance by value.
  ('11111111-0000-4000-8000-000000000008', 'EMP-1134', 2, true,  'line_manager',    0, 0, null, null, null, null),
  ('11111111-0000-4000-8000-000000000008', 'EMP-0830', 3, false, 'compliance',      1, 0, null, 2,    'Compliance review', null),
  ('11111111-0000-4000-8000-000000000008', 'EMP-0831', 3, false, 'compliance',      1, 1, null, 2,    'Compliance review', null),
  ('11111111-0000-4000-8000-000000000008', 'EMP-0832', 3, false, 'compliance',      1, 2, null, 2,    'Compliance review', null),
  ('11111111-0000-4000-8000-000000000008', null,       3, true,  'slab_finance',    2, 0, null, null, null, null),

  -- Campaign request: CXO first only when it is exceptional.
  ('11111111-0000-4000-8000-000000000009', 'EMP-0800', 2, false, 'cxo_exception',   0, 0, null, null, 'Exceptional approval',
   '{"field": "Approval route", "op": "eq", "value": "Exceptional"}'),
  ('11111111-0000-4000-8000-000000000009', 'EMP-0410', 2, false, 'answer:Business finance reviewer', 1, 0, null, null, 'Business finance review', null),
  ('11111111-0000-4000-8000-000000000009', null,       2, false, 'department_head',  2, 0, null, null, null, null),

  -- Campaign NFA: line manager, then finance by total cost.
  ('11111111-0000-4000-8000-000000000010', 'EMP-1134', 2, true,  'line_manager',    0, 0, null, null, null, null),
  ('11111111-0000-4000-8000-000000000010', null,       3, true,  'slab_finance',    1, 0, null, null, null, null);

insert into public.approval_slabs (form_template_id, min_amount, max_amount, approver_user_id, order_index) values
  ('11111111-0000-4000-8000-000000000008', 0,         null, 'EMP-0312', 0),
  ('11111111-0000-4000-8000-000000000008', 50000.01,  null, 'EMP-0600', 1),
  ('11111111-0000-4000-8000-000000000010', 0,         null, 'EMP-0312', 0),
  ('11111111-0000-4000-8000-000000000010', 1000000.01, null, 'EMP-0600', 1),
  ('11111111-0000-4000-8000-000000000010', 5000000.01, null, 'EMP-0700', 2);

insert into public.notification_rules (form_template_id, notifyee_user_id, is_auto_added, label) values
  ('11111111-0000-4000-8000-000000000007', 'EMP-0201', true, 'hr_watch'),
  ('11111111-0000-4000-8000-000000000008', null,       true, 'submitter');


-- =====================================================================
-- 3b. Stage 2 — what a ticket carries
--
-- Capital expenditure is classified budgetary or non-budgetary, climbs
-- the finance ladder by amount, and above 5,000,000 needs the board:
-- any two of three members. The campaign's exceptional route is flagged
-- wherever the request appears, and HR signs the final settlement.
-- =====================================================================
insert into public.form_fields (form_template_id, field_type, field_name, order_index, is_required, field_config) values
  ('11111111-0000-4000-8000-000000000006', 'gen_employee_name', 'Employee name', 0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000006', 'text',     'Project',               1, true,  '{}'),
  ('11111111-0000-4000-8000-000000000006', 'select',   'Classification',        2, true,  '{"options":["Budgetary","Non-budgetary"]}'),
  ('11111111-0000-4000-8000-000000000006', 'money',    'Amount',                3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000006', 'textarea', 'Justification',         4, true,  '{}'),
  ('11111111-0000-4000-8000-000000000006', 'file',     'Quotation',             5, false, '{}');

insert into public.approval_rules
  (form_template_id, approver_user_id, deadline_days, is_auto_added, label, step_index, position, quorum, stage_label, condition) values
  ('11111111-0000-4000-8000-000000000006', 'EMP-1134', 2, true,  'line_manager', 0, 0, null, null, null),
  ('11111111-0000-4000-8000-000000000006', null,       3, true,  'slab_finance', 1, 0, null, null, null),
  ('11111111-0000-4000-8000-000000000006', 'EMP-0700', 5, false, 'board',        2, 0, 2, 'Board approval',
   '{"field": "Amount", "op": "gt", "value": "5000000"}'),
  ('11111111-0000-4000-8000-000000000006', 'EMP-0800', 5, false, 'board',        2, 1, 2, 'Board approval',
   '{"field": "Amount", "op": "gt", "value": "5000000"}'),
  ('11111111-0000-4000-8000-000000000006', 'EMP-0650', 5, false, 'board',        2, 2, 2, 'Board approval',
   '{"field": "Amount", "op": "gt", "value": "5000000"}');

insert into public.approval_slabs (form_template_id, min_amount, max_amount, approver_user_id, order_index) values
  ('11111111-0000-4000-8000-000000000006', 0,          null, 'EMP-0312', 0),
  ('11111111-0000-4000-8000-000000000006', 1000000.01, null, 'EMP-0600', 1),
  ('11111111-0000-4000-8000-000000000006', 2500000.01, null, 'EMP-0700', 2);

update public.approval_rules set flag = 'Exceptional'
 where label = 'cxo_exception' and tenant_id = app.current_tenant();
update public.approval_rules set require_signature = true
 where label = 'hr_final' and tenant_id = app.current_tenant();

-- =====================================================================
-- 4. Submissions, at different stages of the chain
--
-- One waiting on the first approver, one part-way up the finance chain,
-- one finished, one rejected. Between them every state the approvals
-- screen can show is represented.
-- =====================================================================
insert into public.form_submissions (id, form_template_id, submitted_by, status, submitted_at) values
  ('22222222-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'EMP-2847', 'in_progress', now() - interval '2 days'),
  ('22222222-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000001', 'EMP-3120', 'in_progress', now() - interval '4 days'),
  ('22222222-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000002', 'EMP-2847', 'completed',   now() - interval '9 days'),
  ('22222222-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000003', 'EMP-3120', 'rejected',    now() - interval '6 days');

insert into public.submission_values (submission_id, field_name, value) values
  ('22222222-0000-4000-8000-000000000001', 'Employee name',     'Tom Bexley'),
  ('22222222-0000-4000-8000-000000000001', 'Purpose of travel', 'Regional supplier audit'),
  ('22222222-0000-4000-8000-000000000001', 'Amount claimed',    '84500'),
  ('22222222-0000-4000-8000-000000000002', 'Employee name',     'Mei Sun'),
  ('22222222-0000-4000-8000-000000000002', 'Purpose of travel', 'Annual procurement conference'),
  -- Deliberately above the top band, so the demo has a claim that climbs
  -- all three finance levels.
  ('22222222-0000-4000-8000-000000000002', 'Amount claimed',    '620000'),
  ('22222222-0000-4000-8000-000000000003', 'Employee name',     'Tom Bexley'),
  ('22222222-0000-4000-8000-000000000003', 'Leave type',        'Annual'),
  ('22222222-0000-4000-8000-000000000004', 'Employee name',     'Mei Sun'),
  ('22222222-0000-4000-8000-000000000004', 'System',            'Finance ledger'),
  ('22222222-0000-4000-8000-000000000004', 'Access level',      'Administrator');

-- Only the lowest unfinished step is `pending`; everything above it
-- waits. That invariant is what the chain tests check.
insert into public.approval_requests (submission_id, approver_user_id, step_index, status, comment, acted_at, deadline_at) values
  -- 84,500 — one finance level, still with the line manager
  ('22222222-0000-4000-8000-000000000001', 'EMP-1134', 0, 'pending',  null, null, now() + interval '1 day'),
  ('22222222-0000-4000-8000-000000000001', 'EMP-0312', 1, 'waiting',  null, null, now() + interval '6 days'),

  -- 620,000 — the line manager has approved, so the Controller is live
  -- and the two levels above are waiting
  ('22222222-0000-4000-8000-000000000002', 'EMP-1134', 0, 'approved', 'Confirmed against the travel calendar', now() - interval '3 days', now() - interval '1 day'),
  ('22222222-0000-4000-8000-000000000002', 'EMP-0312', 1, 'pending',  null, null, now() + interval '2 days'),
  ('22222222-0000-4000-8000-000000000002', 'EMP-0600', 2, 'waiting',  null, null, now() + interval '5 days'),
  ('22222222-0000-4000-8000-000000000002', 'EMP-0700', 3, 'waiting',  null, null, now() + interval '8 days'),

  ('22222222-0000-4000-8000-000000000003', 'EMP-1134', 0, 'approved', 'Cover arranged', now() - interval '8 days', now() - interval '7 days'),
  ('22222222-0000-4000-8000-000000000003', 'EMP-0201', 1, 'approved', 'Balance confirmed', now() - interval '7 days', now() - interval '6 days'),

  ('22222222-0000-4000-8000-000000000004', 'EMP-1134', 0, 'approved', null, now() - interval '5 days', now() - interval '4 days'),
  ('22222222-0000-4000-8000-000000000004', 'EMP-0445', 1, 'rejected', 'Administrator access needs a documented business case', now() - interval '5 days', now() - interval '3 days');

-- =====================================================================
-- 5. Operations — stock, movement, notices, stationery, maintenance
-- =====================================================================
insert into public.items (id, name, type) values
  ('33333333-0000-4000-8000-000000000001', 'Desk chair',      'Furniture'),
  ('33333333-0000-4000-8000-000000000002', 'Laptop dock',     'IT Equipment'),
  ('33333333-0000-4000-8000-000000000003', 'Filing cabinet',  'Furniture'),
  ('33333333-0000-4000-8000-000000000004', 'Monitor, 27 inch','IT Equipment');

insert into public.venues (id, name, floor) values
  ('44444444-0000-4000-8000-000000000001', 'Main Store',      'Basement'),
  ('44444444-0000-4000-8000-000000000002', 'North Wing',      '4th Floor'),
  ('44444444-0000-4000-8000-000000000003', 'South Wing',      '2nd Floor');

-- MO-1041 is approved, so its four desk chairs have already left Main
-- Store and its reservation has been released — approving is what runs
-- release_reservation and transfer_stock. MO-1042 is still only
-- submitted, so its two filing cabinets are reserved and have not moved.
insert into public.item_stock (item_id, venue_id, quantity, reserved_quantity) values
  ('33333333-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000001', 36, 0),
  ('33333333-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000001', 25, 0),
  ('33333333-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000001', 12, 2),
  ('33333333-0000-4000-8000-000000000004', '44444444-0000-4000-8000-000000000001', 18, 0),
  ('33333333-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', 19, 0),
  ('33333333-0000-4000-8000-000000000004', '44444444-0000-4000-8000-000000000002',  6, 0);

insert into public.movement_orders (ref_number, requester_id, item_name, item_type, quantity,
                                    source_location, destination_location, justification,
                                    assigned_mover_id, status, item_id, source_venue_id, destination_venue_id, created_at) values
  ('MO-1041', 'EMP-1134', 'Desk chair',       'Furniture',    4, 'Main Store', 'North Wing', 'New joiners in the analytics pod', 'EMP-9001', 'approved',    '33333333-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', now() - interval '3 days'),
  ('MO-1042', 'EMP-0445', 'Filing cabinet',   'Furniture',    2, 'Main Store', 'South Wing', 'Records consolidation',            'EMP-9001', 'submitted',   '33333333-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000003', now() - interval '1 day'),
  ('MO-1039', 'EMP-3120', 'Monitor, 27 inch', 'IT Equipment', 6, 'Main Store', 'North Wing', 'Second screens for the design team','EMP-9001', 'completed',  '33333333-0000-4000-8000-000000000004', '44444444-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', now() - interval '11 days');

insert into public.notices (id, title, content, category, status, created_by, current_approver_id, created_at) values
  ('55555555-0000-4000-8000-000000000001', 'Quarterly all-hands',
   'The quarterly all-hands is on the 12th at 10:00 in the North Wing auditorium. Dial-in details will follow for regional colleagues.',
   'General', 'published', 'EMP-0201', null, now() - interval '5 days'),
  ('55555555-0000-4000-8000-000000000002', 'Updated expense policy',
   'Claims above 500,000 now require sign-off from the Chief Financial Officer. The change takes effect at the start of next month.',
   'Policy', 'pending', 'EMP-0312', 'EMP-1134', now() - interval '1 day');

insert into public.notice_comments (notice_id, author_id, text) values
  ('55555555-0000-4000-8000-000000000001', 'EMP-2847', 'Will the recording be shared afterwards?'),
  ('55555555-0000-4000-8000-000000000001', 'EMP-0201', 'Yes — posted here the same afternoon.');

-- =====================================================================
-- 6. Activity and notifications
-- =====================================================================
insert into public.activity_log (actor_id, action, entity_type, entity_id, detail, created_at) values
  ('EMP-2847', 'submitted', 'form_submission', '22222222-0000-4000-8000-000000000001', 'Travel & Expense Reimbursement', now() - interval '2 days'),
  ('EMP-1134', 'approved',  'form_submission', '22222222-0000-4000-8000-000000000002', 'Travel & Expense Reimbursement — 620,000', now() - interval '3 days'),
  ('EMP-0445', 'rejected',  'form_submission', '22222222-0000-4000-8000-000000000004', 'IT System Access Request',       now() - interval '5 days'),
  ('EMP-9001', 'updated',   'movement_order',  (select id from public.movement_orders where ref_number = 'MO-1041' and tenant_id = app.current_tenant()), 'Marked in progress', now() - interval '2 days'),
  ('EMP-0201', 'published', 'notice',          '55555555-0000-4000-8000-000000000001', 'Quarterly all-hands',            now() - interval '5 days'),
  ('EMP-0312', 'submitted', 'notice',          '55555555-0000-4000-8000-000000000002', 'Updated expense policy',         now() - interval '1 day');

insert into public.notifications (recipient_id, kind, title, body, entity_type, entity_id, read_at, created_at) values
  ('EMP-1134', 'approval.turn',     'Your approval is needed',
   'Travel & Expense Reimbursement from Tom Bexley is waiting on you.',
   'form_submission', '22222222-0000-4000-8000-000000000001', null, now() - interval '2 days'),
  ('EMP-0312', 'approval.turn',     'Your approval is needed',
   'Travel & Expense Reimbursement from Mei Sun has reached the Finance Controller.',
   'form_submission', '22222222-0000-4000-8000-000000000002', null, now() - interval '3 days'),
  ('EMP-3120', 'request.rejected', 'Your request was rejected',
   'IT System Access Request was rejected by Farah Haddad.',
   'form_submission', '22222222-0000-4000-8000-000000000004', now() - interval '4 days', now() - interval '5 days');

-- =====================================================================
-- 9. Chains for the subjects that are not form submissions
--
-- Built by calling the engine rather than by writing the rows out, so
-- the seed cannot drift from what a real submission produces — and so
-- applying this file is itself a check that the engine works.
--
-- The form submission chains above are still written by hand: they pin
-- one specific state each, including a rejection and a claim part-way up
-- the finance ladder, which is worth stating exactly.
-- =====================================================================
do $chains$
declare
  v_id   uuid;
  v_step uuid;
  v_who  text;
begin
  -- A notice with the line manager, and one already published.
  perform public.build_approval_chain('notice', '55555555-0000-4000-8000-000000000002');

  perform public.build_approval_chain('notice', '55555555-0000-4000-8000-000000000001');
  loop
    select id into v_step from public.approval_requests
     where notice_id = '55555555-0000-4000-8000-000000000001' and status = 'pending';
    exit when v_step is null;
    perform public.act_on_approval(v_step, 'approve', 'Cleared for publication', (select approver_user_id from public.approval_requests where id = v_step));
  end loop;

  -- An exit clearance under way: Tom's own division has started, and two
  -- of the four departments have already cleared him.
  insert into public.form_submissions (id, form_template_id, submitted_by, status, submitted_at) values
    ('22222222-0000-4000-8000-000000000007', '11111111-0000-4000-8000-000000000007', 'EMP-2847', 'submitted', now() - interval '3 days');
  insert into public.submission_values (submission_id, field_name, value) values
    ('22222222-0000-4000-8000-000000000007', 'Employee name',      'Tom Bexley'),
    ('22222222-0000-4000-8000-000000000007', 'Reason for leaving', 'Resignation'),
    ('22222222-0000-4000-8000-000000000007', 'Resignation date',   to_char(current_date - 20, 'YYYY-MM-DD')),
    ('22222222-0000-4000-8000-000000000007', 'Last working day',   to_char(current_date + 10, 'YYYY-MM-DD')),
    ('22222222-0000-4000-8000-000000000007', 'Bank name',          'City Savings Bank'),
    ('22222222-0000-4000-8000-000000000007', 'Branch',             'Riverside'),
    ('22222222-0000-4000-8000-000000000007', 'Account name',       'Tom Bexley'),
    ('22222222-0000-4000-8000-000000000007', 'Account number',     '0042-118-3391');
  perform public.build_approval_chain('form_submission', '22222222-0000-4000-8000-000000000007',
                                      '11111111-0000-4000-8000-000000000007');
  for v_who in select unnest(array['EMP-0312', 'EMP-0445']) loop
    select id into v_step from public.approval_requests
     where submission_id = '22222222-0000-4000-8000-000000000007'
       and approver_user_id = v_who and status = 'pending';
    perform public.act_on_approval(v_step, 'approve', 'No outstanding items', v_who);
  end loop;

  -- A gift declaration with one of the two compliance clearances it needs.
  insert into public.form_submissions (id, form_template_id, submitted_by, status, submitted_at) values
    ('22222222-0000-4000-8000-000000000008', '11111111-0000-4000-8000-000000000008', 'EMP-3120', 'submitted', now() - interval '2 days');
  insert into public.submission_values (submission_id, field_name, value) values
    ('22222222-0000-4000-8000-000000000008', 'Employee name',     'Mei Sun'),
    ('22222222-0000-4000-8000-000000000008', 'Declaration type',  'Hospitality'),
    ('22222222-0000-4000-8000-000000000008', 'Counterparty',      'Northgate Logistics'),
    ('22222222-0000-4000-8000-000000000008', 'Event date',        to_char(current_date - 5, 'YYYY-MM-DD')),
    ('22222222-0000-4000-8000-000000000008', 'Value',             '18500'),
    ('22222222-0000-4000-8000-000000000008', 'Reference number',  'GH-2026-114');
  perform public.build_approval_chain('form_submission', '22222222-0000-4000-8000-000000000008',
                                      '11111111-0000-4000-8000-000000000008');
  select id into v_step from public.approval_requests
   where submission_id = '22222222-0000-4000-8000-000000000008' and status = 'pending';
  perform public.act_on_approval(v_step, 'approve', 'Within policy for a supplier dinner', 'EMP-1134');
  select id into v_step from public.approval_requests
   where submission_id = '22222222-0000-4000-8000-000000000008'
     and approver_user_id = 'EMP-0830' and status = 'pending';
  perform public.act_on_approval(v_step, 'approve', 'Value is under the reporting threshold', 'EMP-0830');

  -- The exit clearance has been talked about: Tom copied Priya, Admin
  -- left a note, and it is linked to the leave that runs out his notice.
  perform public.set_cc('22222222-0000-4000-8000-000000000007', array['EMP-0650'], 'EMP-2847');
  perform public.add_note('22222222-0000-4000-8000-000000000007',
    'Laptop and access card collected at the front desk. Locker key still outstanding.', 'EMP-0445');
  perform public.link_submissions('22222222-0000-4000-8000-000000000007',
    (select ref_number from public.form_submissions where id = '22222222-0000-4000-8000-000000000003'),
    'Leave taken during the notice period', 'EMP-2847');
end $chains$;

-- =====================================================================
-- 6. Who may do what
--
-- An evaluation's login switches between these people, and each carries
-- their own permissions, so a demonstration can show the difference:
-- Farah administers the system, Priya approves the accounts Farah
-- registers, Nadia designs workflows, Raj may only change a workflow's
-- task settings, Alex approves role changes, and everybody else raises
-- and approves requests and nothing more.
-- =====================================================================
update public.tenants
   set persona_switching = true, require_admin_mfa = false, default_persona = 'EMP-2847'
 where id = app.current_tenant();

insert into public.roles (name, description, permissions, status, created_by, approved_by) values
  ('System administrator', 'Accounts, roles, the org chart and workflow design',
   array['forms.build', 'forms.settings', 'users.manage', 'roles.manage', 'org.manage', 'audit.view', 'reports.view',
         'reports.manage', 'notifications.manage', 'integrations.manage', 'records.manage'],
   'active', 'EMP-0445', 'EMP-0700'),
  ('HR administrator', 'Approves accounts and profile changes; keeps the org chart',
   array['users.manage', 'users.approve', 'org.manage', 'audit.view', 'reports.view'],
   'active', 'EMP-0445', 'EMP-0700'),
  ('Workflow designer', 'Designs forms and their approval routes',
   array['forms.build', 'forms.settings', 'reports.view'],
   'active', 'EMP-0445', 'EMP-0700'),
  ('Workflow settings', 'Changes a workflow''s task settings — deadlines and signatures — and nothing else',
   array['forms.settings', 'reports.view'],
   'active', 'EMP-0445', 'EMP-0700'),
  ('Security officer', 'Approves roles and changes to them',
   array['roles.approve', 'audit.view'],
   'active', 'EMP-0445', 'EMP-0700'),
  ('Compliance auditor', 'Reads the audit trails and reports',
   array['audit.view', 'reports.view'],
   'active', 'EMP-0445', 'EMP-0700');

insert into public.employee_roles (employee_id, role_id, assigned_by)
select v.emp, r.id, 'EMP-0445'
  from (values ('EMP-0445', 'System administrator'),
               ('EMP-0650', 'HR administrator'),
               ('EMP-0201', 'Workflow designer'),
               ('EMP-0312', 'Workflow settings'),
               ('EMP-0700', 'Security officer'),
               ('EMP-0830', 'Compliance auditor')) v(emp, role)
  join public.roles r on r.name = v.role and r.tenant_id = app.current_tenant();

-- Work addresses, as the HR master file would carry them.
update public.employees
   set email = lower(replace(name, ' ', '.')) || '@example.com'
 where tenant_id = app.current_tenant();

-- ---------------------------------------------------------------------
-- Evaluations issued before roles existed get the template's, so that
-- somebody in them can still design a workflow once that needs a
-- permission, and they start as the template's default persona.
-- Re-running finds nothing to do.
-- ---------------------------------------------------------------------
insert into public.roles (tenant_id, name, description, permissions, status, created_by, approved_by)
select d.id, r.name, r.description, r.permissions, r.status, r.created_by, r.approved_by
  from public.tenants d
  join public.tenants tpl on tpl.kind = 'template'
  join public.roles r on r.tenant_id = tpl.id
 where d.kind = 'demo'
   and not exists (select 1 from public.roles x where x.tenant_id = d.id);

insert into public.employee_roles (tenant_id, employee_id, role_id, assigned_by)
select d.id, er.employee_id, dr.id, er.assigned_by
  from public.tenants d
  join public.tenants tpl on tpl.kind = 'template'
  join public.employee_roles er on er.tenant_id = tpl.id
  join public.roles tr on tr.id = er.role_id
  join public.roles dr on dr.tenant_id = d.id and dr.name = tr.name
 where d.kind = 'demo'
   and exists (select 1 from public.employees e where e.tenant_id = d.id and e.employee_id = er.employee_id)
   and not exists (select 1 from public.employee_roles x where x.tenant_id = d.id)
on conflict do nothing;

update public.tenants d
   set default_persona = tpl.default_persona
  from public.tenants tpl
 where tpl.kind = 'template' and d.kind = 'demo' and d.default_persona is null;


-- =====================================================================
-- 7. Reports, and the history they report on
--
-- The standard reports answer the tracking questions the SOW asks:
-- what is waiting and on whom, what missed its deadline, what is coming,
-- what was rejected, and how each approver is doing. Two are scheduled,
-- so a demonstration can show a report arriving by email.
-- =====================================================================
insert into public.report_templates (name, description, dataset, columns, filters, standard, schedule, recipients, format, created_by, approved_by) values
  ('All requests', 'Every request raised, where it is and how long it took',
   'requests', array['reference', 'form', 'requester', 'department', 'status', 'priority', 'submitted_at', 'decided_at', 'cycle_days', 'waiting_on'],
   '{"period": "last_90"}', true, 'none', '{}', 'xlsx', 'EMP-0445', 'EMP-0445'),
  ('Open approvals', 'Every step waiting on somebody now, across the organisation',
   'steps', array['reference', 'form', 'requester', 'stage', 'approver', 'opened_at', 'deadline_at', 'response_days', 'overdue'],
   '{"status": ["pending", "clarification"], "period": "all"}', true, 'none', '{}', 'xlsx', 'EMP-0445', 'EMP-0445'),
  ('Missed deadlines', 'Approvals decided late, or overdue now',
   'steps', array['reference', 'form', 'approver', 'approver_department', 'stage', 'deadline_at', 'acted_at', 'response_days', 'status'],
   '{"on_time": false, "period": "last_90"}', true, 'weekly', array['EMP-0445'], 'xlsx', 'EMP-0445', 'EMP-0445'),
  ('Upcoming approvals', 'Steps that will open once the ones before them clear',
   'steps', array['reference', 'form', 'requester', 'stage', 'approver'],
   '{"status": ["waiting"], "period": "all"}', true, 'none', '{}', 'xlsx', 'EMP-0445', 'EMP-0445'),
  ('Rejected requests', 'Requests turned down, by whom and when',
   'requests', array['reference', 'form', 'requester', 'department', 'amount', 'submitted_at', 'decided_at'],
   '{"status": ["rejected"], "period": "last_90"}', true, 'none', '{}', 'xlsx', 'EMP-0445', 'EMP-0445'),
  ('Approver performance', 'Tasks completed on time, response times and what is outstanding, per approver',
   'approvers', array['approver', 'approver_department', 'assigned', 'completed', 'on_time_pct', 'avg_response_days', 'pending', 'overdue'],
   '{"period": "last_90"}', true, 'monthly', array['EMP-0600', 'EMP-0700'], 'pdf', 'EMP-0445', 'EMP-0445'),
  ('Finance requests by amount', 'Money requests with their amounts and outcomes',
   'requests', array['reference', 'form', 'requester', 'amount', 'status', 'submitted_at', 'cycle_days'],
   '{"category": ["Finance"], "period": "last_90"}', true, 'none', '{}', 'xlsx', 'EMP-0445', 'EMP-0445');

select app.generate_history(app.current_tenant(), 180);

-- Evaluations issued before reports existed get the standard ones and
-- the same history; administrators get the two new permissions.
insert into public.report_templates (tenant_id, name, description, dataset, columns, filters, standard, schedule, recipients, format, created_by, approved_by)
select d.id, rt.name, rt.description, rt.dataset, rt.columns, rt.filters, rt.standard, rt.schedule, rt.recipients, rt.format, rt.created_by, rt.approved_by
  from public.tenants d
  join public.tenants tpl on tpl.kind = 'template'
  join public.report_templates rt on rt.tenant_id = tpl.id
 where d.kind = 'demo'
   and not exists (select 1 from public.report_templates x where x.tenant_id = d.id);

select app.generate_history(d.id, 180) from public.tenants d where d.kind = 'demo' and not d.history_seeded;

update public.roles
   set permissions = permissions || array(select p from unnest(array['reports.manage', 'notifications.manage']) p
                                           where p <> all (permissions))
 where name = 'System administrator'
   and not (permissions @> array['reports.manage', 'notifications.manage']);



-- =====================================================================
-- 8. Commercial: campaigns, partners' mail, classification
-- =====================================================================
-- Farzana is on leave, so she cannot be chosen to review a campaign;
-- Tanvir covers for her.
insert into public.delegation_rules (delegator_id, delegate_id, start_date, end_date, reason)
values ('EMP-0412', 'EMP-0411', current_date - 3, current_date + 9, 'Annual leave');

-- What each form is, and the words that find it.
update public.form_templates t
   set classification = x.cls, keywords = x.kw
  from (values
    ('Travel & Expense Reimbursement', 'budgetary',     array['travel', 'expense', 'claim', 'reimbursement', 'per diem']),
    ('Leave Application',              'non_budgetary', array['leave', 'holiday', 'absence', 'vacation']),
    ('Gate Pass',                      'non_budgetary', array['gate pass', 'visitor', 'access']),
    ('New Employee Onboarding',        'non_budgetary', array['onboarding', 'joiner', 'new hire']),
    ('Capital Expenditure Request',    'budgetary',     array['capex', 'purchase', 'asset', 'investment', 'po']),
    ('Employee Exit Clearance',        'non_budgetary', array['exit', 'clearance', 'resignation', 'leaver', 'final settlement']),
    ('Gift & Hospitality Declaration', 'regulatory',    array['gift', 'hospitality', 'abc', 'anti-bribery', 'donation']),
    ('Campaign Request',               'budgetary',     array['campaign', 'promotion', 'business finance', 'commercial']),
    ('Campaign NFA',                   'budgetary',     array['campaign', 'nfa', 'cashback', 'coupon', 'kpi']),
    ('Campaign Extension',             'budgetary',     array['campaign', 'extension', 'extend']),
    ('MNO Campaign Request',           'budgetary',     array['mno', 'telecom', 'partner', 'operator']),
    ('MNO Campaign NFA',               'budgetary',     array['mno', 'telecom', 'nfa', 'so configuration'])
  ) x(name, cls, kw)
 where t.tenant_id = app.current_tenant() and t.name = x.name;
update public.form_templates set on_approval = 'campaign'
 where tenant_id = app.current_tenant() and name = 'Campaign NFA';
update public.form_templates set on_approval = 'campaign_extension'
 where tenant_id = app.current_tenant() and name = 'Campaign Extension';

-- Mail from the mobile operators becomes a ticket for Shahriar.
update public.tenants
   set inbound_domains = array['grameenphone.com', 'robi.com.bd', 'banglalink.net', 'teletalk.com.bd'],
       inbound_poc = 'EMP-0415', inbound_form = 'MNO Campaign Request'
 where id = app.current_tenant();

select app.seed_campaigns(app.current_tenant());

-- Evaluations issued before this get what the template has gained, and
-- campaigns of their own.
select app.upgrade_from_template(d.id) from public.tenants d where d.kind = 'demo';
select app.seed_campaigns(d.id) from public.tenants d where d.kind = 'demo' and not d.campaigns_seeded;

-- The seed's steps are written already decided, so the trigger that
-- records when a step opened never saw them open; give them the same
-- answer 007_reports.sql gives older steps.
update public.approval_requests r
   set opened_at = coalesce(
         (select max(p.acted_at) from public.approval_requests p
           where p.subject_id = r.subject_id and p.tenant_id = r.tenant_id and p.step_index < r.step_index),
         (select s.submitted_at from public.form_submissions s where s.id = r.submission_id),
         r.created_at)
 where r.opened_at is null and r.status not in ('waiting', 'skipped');

-- =====================================================================
-- 9. Integration, audit and retention
-- =====================================================================
-- Sixty days of people signing in, for the audit centre's charts; and
-- the service desk's settled tickets, migrated from ManageEngine and
-- archived. Both are cloned into every evaluation.
select app.seed_sign_ins(app.current_tenant());
-- A ServiceDesk Plus link, not yet connected, mapped for access and
-- purchase tickets.
select app.seed_servicedesk(app.current_tenant());
select app.seed_servicedesk(d.id) from public.tenants d where d.kind = 'demo';
-- The SOW's remaining forms, the exit clearance checklists, 12-hourly
-- Business Finance reminders and the IT clearance link (009_sow_gaps).
-- Idempotent: an evaluation issued before keeps what it has and gains
-- what it lacks.
select app.seed_sow_gaps(app.current_tenant());
select app.seed_sow_gaps(d.id) from public.tenants d where d.kind = 'demo';
select app.seed_division_admins(app.current_tenant());
select app.seed_division_admins(d.id) from public.tenants d where d.kind = 'demo';
-- Notices, stationery and maintenance had their chains built once for
-- every organisation in the database: the seed builds them as the owner,
-- and the rule lookup did not name the organisation (fixed in
-- 005_chain.sql). Each copy became a parallel track of its own, so an
-- evaluation cloned while that was so has every step several times over,
-- side by side. These chains have no parallel tracks, so a step is a
-- copy whatever its track: the first track is kept, with whatever was
-- decided on it, and the copies' history and notifications go too.
create temp table _dup_steps on commit drop as
  select a.id from public.approval_requests a
   where a.subject_type in ('notice', 'stationery_request', 'maintenance_request', 'movement_order')
     and exists (select 1 from public.approval_requests b
                  where b.tenant_id = a.tenant_id and b.subject_id = a.subject_id and b.subject_type = a.subject_type
                    and b.step_index = a.step_index
                    and b.approver_user_id is not distinct from a.approver_user_id
                    and (coalesce(b.lane, 0), b.created_at, b.id) < (coalesce(a.lane, 0), a.created_at, a.id));
delete from public.approval_events e using _dup_steps d where e.request_id = d.id;
delete from public.approval_requests r using _dup_steps d where r.id = d.id;
-- A phase approved on one copy only never opened the next: with the
-- copies gone, a chain whose every earlier step is decided and nothing
-- open has its next phase opened, as the engine would have.
update public.approval_requests w
   set status = 'pending', opened_at = now(),
       deadline_at = app.add_working_days(now(), coalesce((select r.deadline_days from public.approval_rules r
                                                             where r.tenant_id = w.tenant_id and r.subject_type = w.subject_type
                                                               and r.step_index = w.step_index limit 1), 3), w.tenant_id)
 where w.subject_type in ('notice', 'stationery_request', 'maintenance_request', 'movement_order')
   and w.status = 'waiting'
   and w.step_index = (select min(x.step_index) from public.approval_requests x
                        where x.tenant_id = w.tenant_id and x.subject_id = w.subject_id and x.status = 'waiting')
   and not exists (select 1 from public.approval_requests x
                    where x.tenant_id = w.tenant_id and x.subject_id = w.subject_id
                      and x.status in ('pending', 'clarification', 'rejected'))
   and not exists (select 1 from public.approval_requests x
                    where x.tenant_id = w.tenant_id and x.subject_id = w.subject_id
                      and x.step_index < w.step_index and x.status not in ('approved', 'skipped'));

-- The events with no step of their own (submitted, completed), and the
-- notifications, told the same thing at the same moment several times.
delete from public.approval_events a using public.approval_events b
 where a.tenant_id = b.tenant_id and a.subject_id = b.subject_id
   and a.subject_type in ('notice', 'stationery_request', 'maintenance_request', 'movement_order')
   and a.action = b.action and a.actor_id is not distinct from b.actor_id and a.comment is not distinct from b.comment
   and a.request_id is not distinct from b.request_id and a.created_at = b.created_at and a.id > b.id;
delete from public.notifications a using public.notifications b
 where a.tenant_id = b.tenant_id and a.entity_id = b.entity_id
   and a.entity_type in ('notice', 'stationery_request', 'maintenance_request', 'movement_order')
   and a.recipient_id is not distinct from b.recipient_id and a.kind = b.kind and a.title is not distinct from b.title
   and a.created_at = b.created_at and a.id > b.id;

-- A ticket finds its requester by email, so evaluations issued before
-- people had work addresses get them, by the same rule.
update public.employees e
   set email = lower(replace(e.name, ' ', '.')) || '@example.com'
  from public.tenants d
 where d.id = e.tenant_id and d.kind = 'demo' and e.email is null;
select public.import_legacy_tickets('ManageEngine', app.sample_legacy_tickets(48));

-- Evaluations issued before this: the two new permissions, the same
-- history and archive, and keys, a webhook and their logs of their own.
update public.roles
   set permissions = permissions || array(select p from unnest(array['integrations.manage', 'records.manage']) p
                                           where p <> all (permissions))
 where name = 'System administrator'
   and not (permissions @> array['integrations.manage', 'records.manage']);

-- Evaluations issued before the working calendar get the government's
-- lists for both years.
select app.seed_holidays(d.id) from public.tenants d where d.kind = 'demo' and not d.holidays_seeded;

do $up$
declare d record; v_tpl text := current_setting('app.tenant_id');
begin
  for d in select id from public.tenants where kind = 'demo' and not integration_seeded loop
    perform set_config('app.tenant_id', d.id::text, false);
    perform app.seed_sign_ins(d.id);
    if not exists (select 1 from public.form_submissions where tenant_id = d.id and legacy_ref is not null) then
      perform public.import_legacy_tickets('ManageEngine', app.sample_legacy_tickets(48));
    end if;
    perform app.seed_integration(d.id);
  end loop;
  perform set_config('app.tenant_id', v_tpl, false);
end $up$;

-- Business cards and seals are printed to the organisation's own format,
-- and the scope asks only that a leaver hands them back (Administration's
-- exit checklist). The stationery screen is gone, and with it what the
-- seed once raised there: the requests, their steps, and what was said
-- about them, in every organisation.
delete from public.notifications  where entity_type = 'stationery_request';
delete from public.activity_log   where entity_type = 'stationery_request';
delete from public.approval_events where subject_type = 'stationery_request';
delete from public.approval_requests where stationery_request_id is not null or subject_type = 'stationery_request';
delete from public.approval_rules  where subject_type = 'stationery_request';
delete from public.stationery_requests;

-- Facility maintenance is not in the scope either (its only maintenance
-- is the vendor's support of the software), and it had no way to add
-- the items it was raised against. Gone the same way.
delete from public.notifications  where entity_type = 'maintenance_request';
delete from public.activity_log   where entity_type = 'maintenance_request';
delete from public.approval_events where subject_type = 'maintenance_request';
delete from public.approval_requests where maintenance_request_id is not null or subject_type = 'maintenance_request';
delete from public.approval_rules  where subject_type = 'maintenance_request';
delete from public.maintenance_request_items;
delete from public.maintenance_requests;
delete from public.maintenance_items;

commit;
