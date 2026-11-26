// =====================================================================
// Stage the demo: the requests the storyline needs to exist before the
// call, in one evaluation (default: the bKash one).
//
//   node --env-file=.env scripts/stage-demo.mjs [tenant-slug] [--dry]
//
// Scenes 5 to 9 show states that take days to reach, so they are made
// here, through the engine itself: a request is raised, its route is
// built, and each step is ticked and approved as the person who holds
// it, exactly as the app would. Then its clock is moved back so it
// reads as raised last week.
//
//   3  backup  a CapEx request waiting on Saiful
//   5          a CapEx request overdue with Rajib, escalated two levels
//              (Dilruba, then Arif)
//   6  backup  a Campaign Request waiting on Tanvir
//   7          Towhid's exit clearance: own division, Supply Chain,
//              Administration and Technology cleared, Finance open, HR
//              and Payroll not yet; and a completed clearance (Mehnaz)
//              with Nadia told the final settlement is done
//   8          a Gift & Hospitality Declaration: line manager and one
//              compliance officer (Kamal) done, a second document version
//   9  backup  a role change proposed by Farhana, waiting for Arif
//
// Re-running finds what it already staged and leaves it alone. --dry
// does everything and rolls back.
// =====================================================================

import pg from 'pg';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const SLUG = args.find((a) => !a.startsWith('--')) ?? 'bkash-a9ae5a';
const URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!URL) { console.error('set DIRECT_URL or DATABASE_URL'); process.exit(1); }

const c = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = (sql, p) => c.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];
const all = async (sql, p) => (await q(sql, p)).rows;

const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pdf = (title) => Buffer.from(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
  `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n` +
  `4 0 obj<</Length ${title.length + 40}>>stream\nBT /F1 18 Tf 60 760 Td (${title}) Tj ET\nendstream endobj\n` +
  `5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);

const made = [];
let T;

async function asSession(emp) {
  // The engine's functions read who is acting from the session; with no
  // employee set, they take the p_actor argument instead.
  await q(`select set_config('app.tenant_id', $1, true), set_config('app.employee_id', $2, true),
                  set_config('app.is_staff', 'false', true), set_config('app.mfa', 'true', true),
                  set_config('app.role', 'admin', true), set_config('app.api_key', '', true)`, [T, emp ?? '']);
}

async function formId(name) {
  const r = await one(`select id from public.form_templates where tenant_id = $1 and name = $2 and status = 'published'`, [T, name]);
  if (!r) throw new Error(`no published form "${name}"`);
  return r.id;
}

/** Already staged? Found by the form, the requester and one answer. */
async function staged(form, by, field, value) {
  return one(`select s.id, s.ref_number from public.form_submissions s
                join public.submission_values v on v.submission_id = s.id
               where s.tenant_id = $1 and s.form_template_id = $2 and s.submitted_by = $3
                 and v.field_name = $4 and v.value = $5 and s.status <> 'cancelled'`,
              [T, await formId(form), by, field, value]);
}

async function raise(form, by, answers) {
  const tpl = await formId(form);
  const name = (await one(`select name from public.employees where tenant_id = $1 and employee_id = $2`, [T, by])).name;
  const s = await one(`insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status)
                       values ($1, $2, $3, 'submitted') returning id, ref_number`, [T, tpl, by]);
  for (const [k, v] of Object.entries({ 'Employee name': name, ...answers })) {
    await q(`insert into public.submission_values (tenant_id, submission_id, field_name, value) values ($1, $2, $3, $4)`,
            [T, s.id, k, String(v)]);
  }
  await q(`select public.build_approval_chain('form_submission', $1, $2)`, [s.id, tpl]);
  return s;
}

const live = (sub) => all(
  `select id, approver_user_id, step_index, lane_label, stage_label, require_signature
     from public.approval_requests where submission_id = $1 and status = 'pending'
    order by step_index, lane nulls first, lane_step`, [sub]);

async function approve(step, comment) {
  await q(`insert into public.checklist_ticks (tenant_id, submission_id, item_id, done_by)
            select ar.tenant_id, ar.submission_id, i.id, ar.approver_user_id from public.approval_requests ar
              join public.form_submissions s on s.id = ar.submission_id
              join public.checklist_items i on i.tenant_id = ar.tenant_id and i.form_template_id = s.form_template_id and i.active
                                           and i.track = app.checklist_track(ar.lane_label, ar.stage_label)
             where ar.id = $1 on conflict do nothing`, [step.id]);
  await q(`select public.act_on_approval($1, 'approve', $2, $3, $4)`,
          [step.id, comment ?? null, step.approver_user_id, step.require_signature ? SIGNATURE : null]);
}

/** Approve every live step that `pick` chooses, until none is chosen. */
async function walk(sub, pick, comment) {
  for (let guard = 0; guard < 40; guard++) {
    const steps = (await live(sub)).filter(pick);
    if (!steps.length) return;
    for (const s of steps) await approve(s, typeof comment === 'function' ? comment(s) : comment);
  }
  throw new Error('walk did not settle');
}

/** Move a request's whole history `days` back, and give what is still open a fair deadline. */
async function backdate(sub, days) {
  const iv = `${days} days`;
  await q(`update public.form_submissions set submitted_at = submitted_at - $2::interval,
                  closed_at = closed_at - $2::interval where id = $1`, [sub, iv]);
  await q(`update public.approval_requests set created_at = created_at - $2::interval, opened_at = opened_at - $2::interval,
                  acted_at = acted_at - $2::interval, signed_at = signed_at - $2::interval,
                  deadline_at = deadline_at - $2::interval where submission_id = $1`, [sub, iv]);
  await q(`update public.approval_events set created_at = created_at - $2::interval where subject_id = $1`, [sub, iv]);
  await q(`update public.notifications set created_at = created_at - $2::interval where entity_id = $1`, [sub, iv]);
  await q(`update public.checklist_ticks set done_at = done_at - $2::interval where submission_id = $1`, [sub, iv]);
  await q(`update public.attachments set created_at = created_at - $2::interval where submission_id = $1`, [sub, iv]);
  // What is still waiting is due in a couple of working days, not
  // overdue because its clock moved.
  await q(`update public.approval_requests
              set deadline_at = app.add_working_days(now(), 2, tenant_id)
            where submission_id = $1 and status = 'pending'`, [sub]);
  // Steps decided in an instant read oddly; space them out over the days.
  await q(`with o as (select id, row_number() over (order by acted_at, step_index, lane nulls first) n
                        from public.approval_requests where submission_id = $1 and acted_at is not null)
           update public.approval_requests a set acted_at = a.acted_at + (o.n * interval '7 hours'),
                  opened_at = least(a.opened_at, a.acted_at + (o.n * interval '7 hours'))
             from o where o.id = a.id`, [sub]);
}

function note(scene, s, what) {
  made.push({ scene, ref: s.ref_number, what });
}

try {
  await q('begin');
  T = (await one(`select id from public.tenants where slug = $1`, [SLUG]))?.id;
  if (!T) throw new Error(`no organisation ${SLUG}`);
  await asSession(null);

  // ------------------------------------------------------------------
  // Housekeeping: the leftover draft form, and Towhid's older open
  // clearances, which would sit beside the staged one.
  // ------------------------------------------------------------------
  const draft = await one(`select id from public.form_templates f where tenant_id = $1 and name = 'Employee Departure Due Diligence Form'
                             and status = 'draft' and not exists (select 1 from public.form_submissions s where s.form_template_id = f.id)`, [T]);
  if (draft) {
    await q(`delete from public.form_fields where form_template_id = $1`, [draft.id]);
    await q(`delete from public.form_templates where id = $1`, [draft.id]);
    made.push({ scene: '-', ref: '', what: 'deleted the leftover draft form Employee Departure Due Diligence Form' });
  }

  // ------------------------------------------------------------------
  // Scene 3 backup: a CapEx request already in Saiful's queue.
  // ------------------------------------------------------------------
  let s = await staged('Capital Expenditure Request', 'EMP-2847', 'Project', 'Branch office UPS replacement');
  if (!s) {
    s = await raise('Capital Expenditure Request', 'EMP-2847', {
      Project: 'Branch office UPS replacement', Classification: 'Budgetary', Amount: '420000',
      Justification: 'The UPS units at the Motijheel and Agrabad offices are past their service life; two failed in October.',
      'PO lines': 'APC Smart-UPS 10kVA x 2 @ 165,000 = 330,000\nInstallation and battery disposal = 90,000',
    });
    await backdate(s.id, 1);
    note('3 (backup)', s, 'CapEx 420,000 waiting on Saiful');
  }

  // ------------------------------------------------------------------
  // Scene 5: overdue with Rajib, escalated to Dilruba, then Arif.
  // ------------------------------------------------------------------
  s = await staged('Capital Expenditure Request', 'EMP-2847', 'Project', 'Call centre headset refresh');
  if (!s) {
    s = await raise('Capital Expenditure Request', 'EMP-2847', {
      Project: 'Call centre headset refresh', Classification: 'Budgetary', Amount: '650000',
      Justification: 'Replace 180 headsets on the customer care floor; the current ones are four years old.',
      'PO lines': 'Jabra Engage 50 x 180 @ 3,500 = 630,000\nSpares = 20,000',
    });
    await walk(s.id, (st) => st.approver_user_id === 'EMP-1134', 'Needed before the December peak.');
    await backdate(s.id, 12);
    const rajib = await one(`select id from public.approval_requests where submission_id = $1 and status = 'pending'`, [s.id]);
    await q(`update public.approval_requests
                set deadline_at = app.add_working_days(now() - interval '14 days', 3, tenant_id),
                    warn_hours = 24, escalate_days = 2, escalate_levels = 2
              where id = $1`, [rajib.id]);
    // What the daily round would have said, written by the daily round.
    await asSession(null);
    await q(`select app.daily_reminders()`);
    const esc = await all(`select recipient_id, body from public.notifications where entity_id = $1 and kind = 'approval.escalated'`, [s.id]);
    if (esc.length < 2) throw new Error(`scene 5 escalated to ${esc.length} manager(s), not 2`);
    note('5', s, `CapEx 650,000 overdue with Rajib; escalated to ${esc.map((e) => e.recipient_id).join(' then ')}`);
  }

  // ------------------------------------------------------------------
  // Scene 6 backup: a campaign request waiting on Tanvir.
  // ------------------------------------------------------------------
  s = await staged('Campaign Request', 'EMP-0416', 'Campaign name', 'Pohela Falgun Send Money Offer');
  if (!s) {
    s = await raise('Campaign Request', 'EMP-0416', {
      'Campaign name': 'Pohela Falgun Send Money Offer', Audience: 'Customer', 'Approval route': 'Regular', Budget: '750000',
      'Business case': 'Tk 20 cashback on the first send money of Tk 500 or more over Falgun week; aimed at 40,000 dormant wallets.',
      'Business finance reviewer': 'EMP-0411',
    });
    const first = await live(s.id);
    if (!first.some((x) => x.approver_user_id === 'EMP-0411')) throw new Error('scene 6: the campaign is not with Tanvir');
    await backdate(s.id, 1);
    note('6 (backup)', s, 'Campaign Request 750,000 waiting on Tanvir');
  }

  // ------------------------------------------------------------------
  // Scene 7: Towhid's exit clearance, Finance still holding it.
  // ------------------------------------------------------------------
  const exitAnswers = (bank) => ({
    'Reason for leaving': 'Resignation', 'Resignation date': '2026-11-12', 'Last working day': '2026-12-10',
    'Bank name': bank, Branch: 'Gulshan', 'Account name': 'as above', 'Account number': '1201 3345 0098',
    'I have handed over my work, with a signed-off handover note': 'true',
    'I have returned company property: phone, SIM, laptop, cards and keys': 'true',
    'I have handed over official social media and portal accounts': 'true',
    'I have left or handed over official chat groups': 'true',
    'I confirm all company assets will be returned and the account above may receive my final settlement': 'true',
  });
  s = await staged('Employee Exit Clearance', 'EMP-2847', 'Last working day', '2026-12-10');
  if (!s) {
    for (const old of await all(`select s.id, s.ref_number from public.form_submissions s join public.form_templates f on f.id = s.form_template_id
                                  where s.tenant_id = $1 and f.name = 'Employee Exit Clearance' and s.submitted_by = 'EMP-2847'
                                    and s.status not in ('completed', 'rejected', 'cancelled')`, [T])) {
      await q(`update public.approval_requests set status = 'skipped' where submission_id = $1 and status in ('pending', 'waiting', 'clarification')`, [old.id]);
      await q(`update public.form_submissions set status = 'cancelled', closed_at = now() where id = $1`, [old.id]);
      made.push({ scene: '7', ref: old.ref_number, what: 'older open clearance for Towhid withdrawn, so only the staged one is open' });
    }
    s = await raise('Employee Exit Clearance', 'EMP-2847', exitAnswers('BRAC Bank'));
    await walk(s.id, (st) => !/finance/i.test(st.lane_label ?? ''), 'Cleared; nothing outstanding.');
    const open = await live(s.id);
    if (!open.length || !open.every((x) => /finance/i.test(x.lane_label ?? ''))) {
      throw new Error(`scene 7: expected only Finance open, found ${open.map((x) => x.lane_label).join(', ')}`);
    }
    await backdate(s.id, 6);
    note('7', s, 'Towhid exit clearance: four tracks cleared, Finance & Accounts open, HR and Payroll not yet');
  }

  s = await staged('Employee Exit Clearance', 'EMP-3120', 'Last working day', '2026-11-20');
  if (!s) {
    s = await raise('Employee Exit Clearance', 'EMP-3120', { ...exitAnswers('Dutch-Bangla Bank'), 'Resignation date': '2026-10-21', 'Last working day': '2026-11-20' });
    await walk(s.id, () => true, 'Cleared.');
    const done = await one(`select status from public.form_submissions where id = $1`, [s.id]);
    if (done.status !== 'completed') throw new Error(`scene 7: the completed clearance is ${done.status}`);
    await backdate(s.id, 9);
    note('7', s, 'Mehnaz exit clearance, completed: certificate, and Nadia told the final settlement is done');
  }

  // ------------------------------------------------------------------
  // Scene 8: a declaration with one compliance clearance of two.
  // ------------------------------------------------------------------
  s = await staged('Gift & Hospitality Declaration', 'EMP-2847', 'Counterparty', 'Grameenphone Ltd.');
  if (!s) {
    s = await raise('Gift & Hospitality Declaration', 'EMP-2847', {
      'Declaration type': 'Hospitality received', Counterparty: 'Grameenphone Ltd.', 'Event date': '2026-11-18',
      Value: '18500', 'Reference number': 'GH-2026-114', 'Supporting document': 'Invitation and bill v2.pdf',
    });
    for (const [v, file, desc, sup] of [
      [1, 'Invitation and bill.pdf', 'Invitation to the partner dinner', true],
      [2, 'Invitation and bill v2.pdf', 'Invitation, with the restaurant bill added', false],
    ]) {
      await q(`insert into public.attachments (tenant_id, submission_id, field_name, file_name, content_type, size_bytes, data,
                                               uploaded_by, description, tags, version, superseded_at)
               values ($1, $2, 'Supporting document', $3, 'application/pdf', $4, $5, 'EMP-2847', $6, $7, $8, $9)`,
              [T, s.id, file, pdf(desc).length, pdf(desc), desc, ['hospitality', 'partner'], v, sup ? new Date() : null]);
    }
    await walk(s.id, (st) => ['EMP-1134', 'EMP-0831'].includes(st.approver_user_id), (st) =>
      st.approver_user_id === 'EMP-0831' ? 'Within the hospitality limit; partner dinner, no business pending.' : null);
    const open = await live(s.id);
    if (!open.some((x) => x.approver_user_id === 'EMP-0830')) throw new Error('scene 8: Lubna cannot clear it');
    await backdate(s.id, 3);
    note('8', s, 'Gift & Hospitality: line manager and Kamal cleared; Lubna or Rafiq to give the second clearance; document v2');
  }

  // ------------------------------------------------------------------
  // Scene 9 backup: Farhana proposes a role change; Arif decides.
  // ------------------------------------------------------------------
  const role = await one(`select id, pending_permissions from public.roles where tenant_id = $1 and name = 'Workflow settings'`, [T]);
  if (role && !role.pending_permissions?.length) {
    await asSession('EMP-0445');
    await q(`select public.propose_role_change($1, 'Workflow settings', array['forms.settings', 'reports.view', 'audit.view'])`, [role.id]);
    await asSession(null);
    made.push({ scene: '9 (backup)', ref: '', what: 'role change on Workflow settings (add audit.view) proposed by Farhana, waiting for Arif' });
  }

  if (DRY) { await q('rollback'); console.log('dry run: rolled back'); }
  else await q('commit');
  console.table(made);
} catch (err) {
  await q('rollback').catch(() => {});
  console.error('nothing staged:', err.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
