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
-- Re-runnable: the template is removed and rebuilt, so applying twice
-- leaves one copy rather than two. Demo tenants are independent clones
-- and are untouched.
-- =====================================================================

begin;

-- Everything below inserts unconditionally, so clear any previous
-- template first. The cascade takes its rows with it.
delete from public.tenants where kind = 'template';

insert into public.tenants (name, slug, kind, notes)
values ('Template', 'template', 'template', 'Source data cloned into every new evaluation');

select set_config('app.tenant_id',
                  (select id::text from public.tenants where slug = 'template'), false);

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

-- =====================================================================
-- 2. Form templates
-- =====================================================================
insert into public.form_templates (id, name, category, created_by, status) values
  ('11111111-0000-4000-8000-000000000001', 'Travel & Expense Reimbursement', 'Finance', 'EMP-0312', 'published'),
  ('11111111-0000-4000-8000-000000000002', 'Leave Application',              'HR',      'EMP-0201', 'published'),
  ('11111111-0000-4000-8000-000000000003', 'IT System Access Request',       'Admin',   'EMP-0445', 'published'),
  ('11111111-0000-4000-8000-000000000004', 'Gate Pass',                      'Admin',   'EMP-0445', 'published'),
  ('11111111-0000-4000-8000-000000000005', 'New Employee Onboarding',        'HR',      'EMP-0201', 'published'),
  ('11111111-0000-4000-8000-000000000006', 'Capital Expenditure Request',    'Finance', 'EMP-0312', 'draft');

insert into public.form_fields (form_template_id, field_type, field_name, order_index, is_required, field_config) values
  -- Travel & Expense: the money field is what pulls in the finance chain
  ('11111111-0000-4000-8000-000000000001', 'gen_name',   'Employee name',      0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000001', 'text',       'Purpose of travel',  1, true,  '{"placeholder":"Client visit, conference…"}'),
  ('11111111-0000-4000-8000-000000000001', 'date',       'Travel date',        2, true,  '{}'),
  ('11111111-0000-4000-8000-000000000001', 'money',      'Amount claimed',     3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000001', 'textarea',   'Notes',              4, false, '{"placeholder":"Anything the approver should know"}'),

  ('11111111-0000-4000-8000-000000000002', 'gen_name',   'Employee name',      0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000002', 'select',     'Leave type',         1, true,  '{"options":["Annual","Sick","Unpaid","Parental"]}'),
  ('11111111-0000-4000-8000-000000000002', 'date',       'From',               2, true,  '{}'),
  ('11111111-0000-4000-8000-000000000002', 'date',       'To',                 3, true,  '{}'),
  ('11111111-0000-4000-8000-000000000002', 'textarea',   'Reason',             4, false, '{}'),

  ('11111111-0000-4000-8000-000000000003', 'gen_name',   'Employee name',      0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000003', 'select',     'System',             1, true,  '{"options":["Finance ledger","HR records","Source control","Analytics"]}'),
  ('11111111-0000-4000-8000-000000000003', 'select',     'Access level',       2, true,  '{"options":["Read only","Contributor","Administrator"]}'),
  ('11111111-0000-4000-8000-000000000003', 'textarea',   'Justification',      3, true,  '{}'),

  ('11111111-0000-4000-8000-000000000004', 'gen_name',   'Employee name',      0, true,  '{}'),
  ('11111111-0000-4000-8000-000000000004', 'gen_card',   'Gate pass card',     1, true,  '{}'),
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

insert into public.item_stock (item_id, venue_id, quantity, reserved_quantity) values
  ('33333333-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000001', 40, 4),
  ('33333333-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000001', 25, 0),
  ('33333333-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000001', 12, 2),
  ('33333333-0000-4000-8000-000000000004', '44444444-0000-4000-8000-000000000001', 18, 0),
  ('33333333-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', 15, 0),
  ('33333333-0000-4000-8000-000000000004', '44444444-0000-4000-8000-000000000002',  6, 0);

insert into public.movement_orders (ref_number, requester_id, item_name, item_type, quantity,
                                    source_location, destination_location, justification,
                                    assigned_mover_id, status, item_id, source_venue_id, destination_venue_id, created_at) values
  ('MO-1041', 'EMP-1134', 'Desk chair',       'Furniture',    4, 'Main Store', 'North Wing', 'New joiners in the analytics pod', 'EMP-9001', 'in_progress', '33333333-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', now() - interval '3 days'),
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

insert into public.stationery_requests (kind, requester_id, name, designation, department, division, email, contact_number, reason, status, current_approver_id, created_at) values
  ('business_card', 'EMP-3120', 'Mei Sun',   'Procurement Specialist', 'Operations', 'Commercial', 'mei.sun@example.com',    '+1 555 0142', 'Joining the supplier roadshow', 'open',     'EMP-1134', now() - interval '2 days'),
  ('stamp_seal',    'EMP-0445', 'Farah Haddad','Admin Officer',        'Admin',      'Corporate',  'farah.haddad@example.com','+1 555 0118', 'Replacement for a worn seal',   'approved', 'EMP-0201', now() - interval '8 days');

insert into public.maintenance_items (id, name, category) values
  ('66666666-0000-4000-8000-000000000001', 'Split unit, meeting room 4', 'AC'),
  ('66666666-0000-4000-8000-000000000002', 'Water purifier, 4th floor',  'Water Purifier'),
  ('66666666-0000-4000-8000-000000000003', 'Standby generator',          'Generator');

insert into public.maintenance_requests (id, ref_number, requester_id, location, status, assigned_to, admin_comment, created_at) values
  ('77777777-0000-4000-8000-000000000001', 'MR-2201', 'EMP-2847', 'North Wing, 4th Floor', 'in_progress', 'Coolair Services', 'Engineer booked for Thursday', now() - interval '4 days'),
  ('77777777-0000-4000-8000-000000000002', 'MR-2202', 'EMP-0445', 'South Wing, 2nd Floor', 'raised',      null,               null,                          now() - interval '1 day'),
  ('77777777-0000-4000-8000-000000000003', 'MR-2198', 'EMP-9001', 'Basement',              'completed',   'Powerline Ltd',    'Annual service completed',    now() - interval '20 days');

insert into public.maintenance_request_items (request_id, item_id, description, quantity) values
  ('77777777-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000001', 'Not cooling, intermittent noise', 1),
  ('77777777-0000-4000-8000-000000000002', '66666666-0000-4000-8000-000000000002', 'Filter replacement due',          2),
  ('77777777-0000-4000-8000-000000000003', '66666666-0000-4000-8000-000000000003', 'Annual service',                  1);

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
  ('EMP-3120', 'submission.rejected', 'Your request was rejected',
   'IT System Access Request was rejected by Farah Haddad.',
   'form_submission', '22222222-0000-4000-8000-000000000004', now() - interval '4 days', now() - interval '5 days');

commit;
