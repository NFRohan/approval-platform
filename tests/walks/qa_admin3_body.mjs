
// ================================================================ QA: administration — email, audit, retention, integrations
// Email wording edited and previewed, a kind switched off and on, the
// delivery log; the audit trail's filters and monitoring; the retention
// policy, by permission, previewed and run; API keys and webhooks, by
// permission. Runs after harness_head.mjs.
import { createServer as httpServer } from 'node:http';

const toasts = async () => (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ');
const audits = async (action, like) => (await one(
  `select count(*)::int n from public.activity_log where tenant_id = $1 and action = $2 and ($3::text is null or detail like $3)`,
  [tenant, action, like ?? null])).n;
const go = async (path, emp, wait = 3000) => { await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}as=${emp}`); await settle(wait); };
const tab = async (name) => { await page.getByRole('tab', { name }).click(); await settle(1800); };
async function asPerson(emp, sql, params = []) {
  await page.goto('about:blank');
  await settle(800);
  try {
    await db.query('begin');
    await db.query(`select set_config('app.tenant_id', $1, true), set_config('app.employee_id', $2, true), set_config('app.role', 'viewer', true)`, [tenant, emp]);
    await db.query(sql, params);
    return null;
  } catch (e) { return String(e.message ?? e); } finally { await db.query('rollback'); }
}
const notify = async (to, kind, title) => {
  await page.goto('about:blank');
  await settle(800);
  await db.query(`insert into public.notifications (tenant_id, recipient_id, kind, title, body) values ($1, $2, $3, $4, 'Raised for the QA walk')`, [tenant, to, kind, title]);
};
const outbox = (title) => rows(`select id, status, subject, to_address from public.email_outbox where tenant_id = $1 and context->>'title' = $2`, [tenant, title]);
const callApi = async (key, path) => {
  const res = await server.fetch(new Request(`${BASE}/api/v1/${path}`, { headers: { authorization: `Bearer ${key}` } }));
  return { status: res.status, body: await res.json().catch(() => null) };
};

// The address the app calls itself by, so the built-in webhook receiver is reachable.
const selfProxy = httpServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const r = await server.fetch(new Request(BASE + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
  res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => selfProxy.listen(0, '127.0.0.1', r));
process.env.APP_URL = `http://127.0.0.1:${selfProxy.address().port}`;

// ------------------------------------------------- email: who may change it
await go('/admin/email', 'EMP-0830');
await tab('Templates');
ok('the auditor reads the email templates but cannot change them', (await text()).includes('Changing templates needs the notifications.manage permission.')
  && await page.locator('input[name="template-subject"]').isDisabled() && (await page.locator('button[name="save-template"]').count()) === 0);
await tab('Delivery log');
ok('...nor deliver queued mail', (await page.getByRole('button', { name: /Deliver queued/ }).count()) === 0);
const lenaTemplate = await asPerson('EMP-0830', `select public.save_email_template('cc.added', 'x', 'y', true)`);
ok('...and the database refuses her too', !!lenaTemplate, lenaTemplate ?? 'it was saved');

// ------------------------------------------------- email: wording, preview, on and off
await go('/admin/email', 'EMP-0445');
ok('with no mail server, the log says mail is captured, not sent', (await text()).includes('No mail server is connected.'));
await tab('Templates');
await page.locator('[data-testid="template-list"]').getByRole('button', { name: /You were copied on a request/ }).click();
await settle(800);
const SUBJ = 'QA copy for {{recipient_name}}: {{title}}';
await page.locator('input[name="template-subject"]').fill(SUBJ);
await page.locator('textarea[name="template-body"]').fill('Dear {{recipient_name}},\n\nYou are copied on {{ref}} for the QA walk.\n\n');
await page.getByRole('button', { name: '{{form}}' }).click();
await settle(600);
ok('a fill-in is added to the message from its button', (await page.locator('textarea[name="template-body"]').inputValue()).endsWith('{{form}}'));
const pvHead = await page.locator('[data-testid="template-preview"]').locator('xpath=..').innerText();
const pvBody = await page.frameLocator('[data-testid="template-preview"]').locator('body').innerText();
ok('the preview fills in the subject as it is typed', pvHead.includes('QA copy for Sam Lindqvist: Your approval is needed'), pvHead);
ok('...and the message', /You are copied on AMS-2026-00042 for the QA walk/.test(pvBody) && pvBody.includes('Travel & Expense Reimbursement'), pvBody.slice(0, 300));
await page.locator('button[name="save-template"]').click();
await settle(2500);
let tpl = await one(`select subject, body, enabled, updated_by from public.email_templates where tenant_id = $1 and kind = 'cc.added'`, [tenant]);
ok('the wording is saved as the organisation\'s own', tpl?.subject === SUBJ && tpl.enabled === true && /for the QA walk/.test(tpl.body));
ok('...and the list marks it custom', (await page.locator('[data-testid="template-list"]').getByRole('button', { name: /You were copied on a request/ }).innerText()).includes('custom'));
await page.getByRole('switch', { name: 'Send this kind of email' }).click();
await settle(300);
ok('switching a kind off says it will not be sent', (await page.locator('[data-testid="template-editor"]').innerText()).includes('Not sent'));
await page.locator('button[name="save-template"]').click();
await settle(2500);
tpl = await one(`select subject, enabled from public.email_templates where tenant_id = $1 and kind = 'cc.added'`, [tenant]);
ok('...and once saved it is off, its wording kept', tpl.enabled === false && tpl.subject === SUBJ && (await page.locator('[data-testid="template-list"]').getByRole('button', { name: /You were copied on a request/ }).innerText()).includes('off'));
await notify('EMP-0700', 'cc.added', 'QA copy while off');
ok('a notification of a kind switched off writes no email', (await outbox('QA copy while off')).length === 0);
await notify('EMP-0700', 'note.added', 'QA note while copies are off');
ok('...while other kinds still do', (await outbox('QA note while copies are off')).length === 1);

await go('/admin/email', 'EMP-0445');
await tab('Templates');
await page.locator('[data-testid="template-list"]').getByRole('button', { name: /You were copied on a request/ }).click();
await settle(800);
await page.getByRole('switch', { name: 'Send this kind of email' }).click();
await page.locator('button[name="save-template"]').click();
await settle(2500);
ok('switched back on', (await one(`select enabled from public.email_templates where tenant_id = $1 and kind = 'cc.added'`, [tenant])).enabled === true);
await notify('EMP-0700', 'cc.added', 'QA copy while on');
let mail = await outbox('QA copy while on');
ok('...it writes the email again, queued for Alex\'s address', mail.length === 1 && mail[0].status === 'queued' && mail[0].to_address === 'alex.mercer@example.com', JSON.stringify(mail));

// ------------------------------------------------- email: the delivery log
await go('/admin/email', 'EMP-0445');
ok('the delivery log counts what is queued', Number(await page.locator('[data-testid="count-queued"] div').nth(1).innerText()) >= 2);
await page.getByRole('button', { name: /Deliver queued/ }).click();
await settle(3500);
ok('delivering the queue captures it, with no mail server', /captured/.test(await toasts()), await toasts());
mail = await outbox('QA copy while on');
ok('...the email is marked captured, under the organisation\'s wording', mail[0].status === 'captured' && mail[0].subject === 'QA copy for Alex Mercer: QA copy while on', JSON.stringify(mail));
await page.locator('select[aria-label="Kind"]').selectOption('cc.added');
await settle(2000);
const kinds = await page.locator('[data-testid="email-log"] [data-email-kind]').evaluateAll((els) => els.map((e) => e.getAttribute('data-email-kind')));
ok('the log filters by kind', kinds.length >= 1 && kinds.every((k) => k === 'cc.added'), JSON.stringify(kinds));
await page.locator('[data-testid="email-log"] [data-email-kind="cc.added"]').first().click();
await settle(2000);
const prev = await page.locator('[data-testid="email-preview"]').innerText();
ok('an email in the log is shown as captured, to whom, with its subject', prev.includes('Alex Mercer') && prev.includes('alex.mercer@example.com') && prev.includes('QA copy for Alex Mercer: QA copy while on'), prev.slice(0, 300));
ok('...and reads as it was written', /You are copied on/.test(await page.frameLocator('[data-testid="email-preview"] iframe').locator('body').innerText()));
await page.locator('select[aria-label="Kind"]').selectOption('');
await page.locator('[data-testid="count-captured"]').click();
await settle(2000);
const statuses = await page.locator('[data-testid="email-log"] [data-email-kind]').allInnerTexts();
ok('...and by status', statuses.length >= 2 && statuses.every((s) => s.includes('Captured')), statuses.length);
await page.locator('[data-testid="count-captured"]').click();
await page.locator('input[aria-label="Search emails"]').fill('QA copy for Alex');
await settle(2000);
ok('...and by a search on the subject', (await page.locator('[data-testid="email-log"] [data-email-kind]').count()) === 1, await page.locator('[data-testid="email-log"]').innerText());
await tab('Templates');
await page.locator('[data-testid="template-list"]').getByRole('button', { name: /You were copied on a request/ }).click();
await settle(800);
await page.getByRole('button', { name: /Built-in wording/ }).click();
await settle(2500);
ok('a template goes back to the built-in wording', !(await one(`select 1 x from public.email_templates where tenant_id = $1 and kind = 'cc.added'`, [tenant]))
  && (await page.locator('input[name="template-subject"]').inputValue()) !== SUBJ);

// ------------------------------------------------- the audit centre
// A wrong password first, so the trail has a warning of today's.
await ctx.clearCookies();
await page.goto(BASE + '/login');
await page.locator('input[autocomplete="username"]').fill(USER);
await page.locator('input[autocomplete="current-password"]').fill('not-the-password');
await page.locator('input[autocomplete="current-password"]').press('Enter');
await settle(1500);
await page.locator('input[autocomplete="current-password"]').fill(PASS);
await page.locator('input[autocomplete="current-password"]').press('Enter');
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

await go('/admin/audit', 'EMP-0830', 3500);
const trailRows = () => page.locator('[data-testid="audit-trail"] tbody tr');
const cells = (n) => trailRows().evaluateAll((trs, i) => trs.map((tr) => tr.children[i]?.textContent?.trim() ?? ''), n);
ok('the auditor reads the trail', (await trailRows().count()) > 10);
const allCount = await trailRows().count();
await page.locator('[data-testid="cat-system"]').click();
await settle(2500);
let cats = await cells(1);
ok('the trail filters to one category', cats.length > 0 && cats.length < allCount && cats.every((c) => c === 'System'), [...new Set(cats)].join(','));
await page.locator('[data-testid="cat-user"]').click();
await settle(2500);
cats = await cells(1);
ok('...or several', new Set(cats).size === 2 && cats.every((c) => c === 'System' || c === 'User'), [...new Set(cats)].join(','));
await page.locator('[data-testid="cat-system"]').click();
await page.locator('[data-testid="cat-user"]').click();
await settle(800);
await page.locator('select[aria-label="Severity"]').selectOption('warning');
await settle(2500);
const sev = await trailRows().evaluateAll((trs) => trs.map((tr) => tr.children[2]?.querySelector('[title]')?.getAttribute('title') ?? 'Info'));
ok('...to warnings and worse', sev.length > 0 && sev.every((s) => s === 'Warning' || s === 'Critical'), [...new Set(sev)].join(','));
await page.getByRole('button', { name: 'Today', exact: true }).click();
await settle(2500);
const what = await cells(3);
ok('...and to today, where the wrong password just now is', what.some((w) => w.startsWith('Sign-in failed')), what.slice(0, 5).join(' | '));
await page.locator('select[aria-label="Severity"]').selectOption('');
await page.getByRole('button', { name: '90 days', exact: true }).click();
await page.locator('input[aria-label="Search the trail"]').fill('local.qa');
await settle(2500);
const det = await cells(6);
ok('...and by a search', det.length > 0 && (await page.locator('[data-testid="audit-trail"]').innerText()).includes('local.qa'));
await tab('Monitoring');
await settle(2000);
const mon = await text();
ok('monitoring counts failed sign-ins and out-of-hours work, and charts activity', /Failed sign-ins\s+[1-9]\d*/.test(mon) && /Out of hours/.test(mon) && (await page.locator('.recharts-surface').count()) >= 3, mon.slice(mon.indexOf('Failed'), mon.indexOf('Failed') + 80));

// ------------------------------------------------- retention, by permission
await tab('Retention');
ok('the auditor sees the retention policy but cannot change or run it', (await text()).includes('Only someone with the Retention and archive permission can change this policy.')
  && await page.locator('input[aria-label="Archive after months"]').isDisabled() && (await page.locator('button[name="run-retention"]').count()) === 0);
const lenaRet = await asPerson('EMP-0830', `select public.set_retention(10, 6, 60)`);
ok('...and the database refuses her too', /records\.manage/.test(lenaRet ?? ''), lenaRet ?? 'it was changed');

await go('/admin/audit', 'EMP-0445', 3500);
await tab('Retention');
await settle(1500);
const due = async (label) => Number(((await page.locator('[data-testid="retention-preview"]').innerText()).match(new RegExp(`${label}\\s+([\\d,]+)`)) ?? [])[1]?.replace(/,/g, '') ?? NaN);
const archBefore = await due('To archive');
ok('the policy starts at 12 years, archiving after 12 months', (await page.locator('input[aria-label="Keep records for years"]').inputValue()) === '12'
  && (await page.locator('input[aria-label="Archive after months"]').inputValue()) === '12' && Number.isFinite(archBefore));
await page.locator('input[aria-label="Keep records for years"]').fill('5');
await page.getByRole('button', { name: /Save policy/ }).click();
await settle(2000);
ok('a policy keeping logs longer than the records is refused', /logs cannot be kept longer than the records/i.test(await toasts())
  && (await one(`select retention_years from public.tenants where id = $1`, [tenant])).retention_years === 12, await toasts());
await page.locator('input[aria-label="Keep records for years"]').fill('12');
await page.locator('input[aria-label="Archive after months"]').fill('2');
await page.getByRole('button', { name: /Save policy/ }).click();
await settle(3000);
const ten = await one(`select retention_years, archive_after_months, purge_logs_after_months from public.tenants where id = $1`, [tenant]);
ok('the records officer changes the policy', ten.archive_after_months === 2 && ten.retention_years === 12 && (await audits('retention_changed', '%archive after 2 months%')) === 1, JSON.stringify(ten));
const archAfter = await due('To archive');
ok('...and the preview counts what the new policy archives', archAfter > archBefore && (await text()).includes('settled more than 2 months'), `${archBefore} → ${archAfter}`);
const archivedBefore = (await one(`select count(*)::int n from public.form_submissions where tenant_id = $1 and archived_at is not null`, [tenant])).n;
await page.locator('button[name="run-retention"]').click();
await settle(3500);
const archivedNow = (await one(`select count(*)::int n from public.form_submissions where tenant_id = $1 and archived_at is not null`, [tenant])).n;
ok('running it archives exactly what the preview said', archivedNow - archivedBefore === archAfter && new RegExp(`${archAfter} archived`).test(await toasts()), `${archivedNow - archivedBefore} vs ${archAfter}; ${await toasts()}`);
ok('...leaves nothing more due', (await due('To archive')) === 0 && /Last run .*— \d+ archived/.test(await text()));
ok('...and is recorded as a run', !!(await one(`select 1 x from public.system_runs where tenant_id = $1 and job = 'retention_run'`, [tenant]))
  && (await audits('records_archived')) >= 1);

// ------------------------------------------------- integrations, by permission
await go('/admin/integrations', 'EMP-0830');
ok('the auditor sees the API keys but cannot make or revoke them', (await text()).includes('Making and revoking keys needs the integrations.manage permission.')
  && (await page.getByRole('button', { name: /New key/ }).count()) === 0 && (await page.locator('[data-testid="keys"]').getByRole('button', { name: 'Revoke' }).count()) === 0);
await tab('Webhooks');
ok('...nor add or change webhooks', (await page.getByRole('button', { name: /New webhook/ }).count()) === 0 && (await page.getByRole('button', { name: /Send a test/ }).count()) === 0);

await go('/admin/integrations', 'EMP-0445');
await page.getByRole('button', { name: /New key/ }).click();
await page.locator('input[aria-label="Key name"]').fill('QA Tableau extract');
await page.locator('input[aria-label="reports:read"]').check();
await page.getByRole('button', { name: /Create key/ }).click();
await settle(2500);
const KEY = (await page.locator('[data-testid="one-time-secret"]').innerText()).trim();
ok('a new API key is shown once', /^ams_[a-z0-9]{8}_[A-Za-z0-9]{40}$/.test(KEY), KEY);
let res = await callApi(KEY, 'me');
ok('...and works, with the scopes it was given', res.status === 200 && JSON.stringify([...res.body.data.scopes].sort()) === '["reports:read","requests:read"]', JSON.stringify(res.body));
res = await callApi(KEY, 'campaigns');
ok('...and nothing more', res.status === 403);
await page.getByRole('button', { name: /^Done$/ }).click();
await go('/admin/integrations', 'EMP-0445');
const prefix = KEY.split('_')[1];
ok('once closed, the key is not shown again: only its prefix', !(await text()).includes(KEY) && (await page.locator('[data-testid="keys"]').innerText()).includes(`ams_${prefix}_••••`));
page.once('dialog', (d) => d.accept());
await page.locator('[data-testid="keys"] tr', { hasText: 'QA Tableau extract' }).getByRole('button', { name: 'Revoke' }).click();
// The list reloads after the revoke; on the test database that queues
// behind the page's own first loads, so wait for it rather than a fixed time.
await page.locator('[data-testid="keys"] tr', { hasText: 'QA Tableau extract' }).filter({ hasText: 'Revoked' }).waitFor({ timeout: 15000 }).catch(() => {});
const revokedRow = await page.locator('[data-testid="keys"] tr', { hasText: 'QA Tableau extract' }).innerText().catch((e) => String(e));
ok('revoking it is shown in the list', /Revoked/.test(revokedRow), `${revokedRow} | ${await toasts()} | db revoked_at=${(await one(`select revoked_at from public.api_keys where tenant_id = $1 and name = 'QA Tableau extract'`, [tenant]))?.revoked_at}`);
res = await callApi(KEY, 'me');
ok('...and its next call is refused', res.status === 401 && /revoked/.test(res.body?.error?.message ?? ''), JSON.stringify(res.body));
ok('...on the trail', (await audits('api_key_revoked')) >= 1);

await tab('Webhooks');
await page.getByRole('button', { name: /New webhook/ }).click();
await page.locator('input[aria-label="Webhook name"]').fill('QA echo');
await page.getByRole('button', { name: /Use the built-in receiver/ }).click();
ok('the built-in receiver fills in its address', (await page.locator('input[aria-label="Webhook URL"]').inputValue()) === '/webhooks/echo');
await page.getByRole('button', { name: 'Add webhook' }).click();
await settle(2500);
ok('a webhook is added, its signing secret shown', /^whsec_[A-Za-z0-9]{32}$/.test((await page.locator('[data-testid="webhook-secret"] code').innerText()).trim()));
await page.getByRole('button', { name: /^Done$/ }).click();
const qaHook = page.locator('[data-testid="webhooks"] section', { hasText: 'QA echo' });
await qaHook.getByRole('button', { name: /Send a test/ }).click();
await settle(3500);
const tr = await qaHook.locator('[data-testid="test-result"]').innerText().catch(() => '');
ok('a test is delivered to it, and its signature checks out', /Delivered/.test(tr) && /"verified":\s*true/.test(tr), tr);
const hookId = (await one(`select id from public.webhooks where tenant_id = $1 and name = 'QA echo'`, [tenant])).id;
ok('...the delivery is logged', (await one(`select count(*)::int n from public.webhook_deliveries where webhook_id = $1`, [hookId])).n >= 1);
page.once('dialog', (d) => d.accept());
await qaHook.getByRole('button', { name: /Delete/ }).click();
await page.locator('[data-testid="webhooks"] section', { hasText: 'QA echo' }).waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
const hookGone = { onScreen: await page.locator('[data-testid="webhooks"] section', { hasText: 'QA echo' }).count(), row: !!(await one(`select 1 x from public.webhooks where id = $1`, [hookId])),
  deliveries: (await one(`select count(*)::int n from public.webhook_deliveries where webhook_id = $1`, [hookId])).n, toasts: await toasts() };
ok('a webhook is deleted, with its delivery log', hookGone.onScreen === 0 && !hookGone.row && hookGone.deliveries === 0, JSON.stringify(hookGone));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
selfProxy.close();
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA ADMIN (EMAIL, AUDIT, INTEGRATIONS) CHECKS PASSED');
process.exit(failures ? 1 : 0);
