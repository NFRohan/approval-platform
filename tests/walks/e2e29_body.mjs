// ================================================================ configuration audit, and SLA escalation as people see them
// SOW 2.1 UAT: "audit log of configuration changes". SOW 2.1
// Notification: "SLA wise auto escalation including approvers
// supervisor ... after breach SLA or before SLA. It can be configured."

// ---------------------------------------------------------------- a change to a form is in the activity log
const form = await one(`select id, name from public.form_templates where tenant_id = $1 and name = 'Travel & Expense Reimbursement'`, [tenant]);
await page.goto(`${BASE}/builder/approvers?templateId=${form.id}&as=EMP-0445`); await settle(3500);
await page.getByRole('button', { name: /Next/ }).click(); await settle(3500);
const logged = await one(`select count(*)::int n from public.activity_log where tenant_id = $1 and action = 'configuration_changed'
  and created_at > now() - interval '5 minutes'`, [tenant]);
ok('saving a form\'s approvers writes a configuration entry', logged.n >= 1, String(logged.n));
await page.goto(`${BASE}/activity?as=EMP-0445`); await settle(3500);
const act = await text();
ok('...which the activity log shows, under Configuration', /Configuration/.test(act) && act.includes(form.name), act.slice(0, 400));

// ---------------------------------------------------------------- escalation reaches the manager, then theirs
const step = await one(`select ar.id, ar.subject_id, ar.approver_user_id a, e.line_manager_id m1, m.line_manager_id m2
  from public.approval_requests ar
  join public.employees e on e.tenant_id = ar.tenant_id and e.employee_id = ar.approver_user_id
  join public.employees m on m.tenant_id = ar.tenant_id and m.employee_id = e.line_manager_id
  where ar.tenant_id = $1 and ar.status = 'pending' and ar.submission_id is not null
    and m.line_manager_id is not null and m.line_manager_id <> ar.approver_user_id
  limit 1`, [tenant]);
ok('a pending step two managers deep to test with', !!step);
if (step) {
  await db.query(`update public.approval_requests set deadline_at = now() - interval '6 days', escalate_days = 1, escalate_levels = 2 where id = $1`, [step.id]);
  await db.query(`select set_config('app.tenant_id', $1, false)`, [tenant]);
  await db.query(`select app.daily_reminders()`);
  await db.query(`select set_config('app.tenant_id', '', false)`);
  const to = async (who) => (await one(`select count(*)::int n from public.notifications where entity_id = $1 and recipient_id = $2 and kind = 'approval.escalated'`, [step.subject_id, who])).n;
  ok('an overdue step escalates to the approver\'s manager, and up a second level', (await to(step.m1)) === 1 && (await to(step.m2)) === 1,
    `${step.m1}: ${await to(step.m1)}, ${step.m2}: ${await to(step.m2)}`);
  await page.goto(`${BASE}/?as=${step.m2}`); await settle(3000);
  await page.getByRole('button', { name: /^Notifications/ }).click(); await settle(1500);
  const bell = await text();
  ok('...and the manager\'s manager sees it in their notifications, as level two', /Escalated/.test(bell) && /escalation level 2/i.test(bell), bell.slice(0, 400));
  await page.keyboard.press('Escape');
}

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
