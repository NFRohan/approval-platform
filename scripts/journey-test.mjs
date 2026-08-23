// =====================================================================
// The journey suite.
//
//   npm run test:journey
//
// Walks a request from submitted to fully approved, one step at a time,
// as the people the persona switcher actually offers.
//
// Every other suite tests one layer. The SQL suites prove the engine
// moves a chain correctly; the render suite proves each screen mounts;
// the call-site suite proves every query matches the whitelist. None of
// them walks a request *through* those layers, and that is where the
// three worst faults of this codebase turned out to live:
//
//   - a form routed to an approver who was a real employee but was not
//     one of the personas, so the step could never be actioned and the
//     request stopped there for good;
//   - clarification put a step in a state the application had no way to
//     leave, because nothing ever called the resume the database had
//     implemented all along;
//   - the finance ladder was built correctly and displayed in an order
//     that made it look otherwise.
//
// Each of those passes every other suite. The rule this file enforces is
// simple: whoever the chain asks for next must be somebody a viewer can
// actually be, and every state the chain can enter must have a way out.
//
// Runs inside one transaction and rolls it back, so it leaves nothing
// behind. Point it at the DIRECT endpoint — it carries fixture state
// between statements.
// =====================================================================

import pg from 'pg';
import { createServer } from 'vite';

const URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!URL) {
  console.error('set DIRECT_URL or DATABASE_URL (use node --env-file=.env)');
  process.exit(1);
}
if (/-pooler\./.test(URL)) {
  console.error('refusing to run against the pooled endpoint — set DIRECT_URL');
  process.exit(1);
}

let failures = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  pass: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}${detail ? `  (${detail})` : ''}`);
  }
}

// The persona list, read from the component that defines it rather than
// copied here — a copy would drift, which is the exact failure this
// suite exists to catch.
const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const { USERS } = await server.ssrLoadModule('/src/contexts/CurrentUserContext.tsx');
const PERSONAS = new Set(USERS.map((u) => u.employee_id));

// The statuses every queue filters on, read from the module the queues
// import. This is the whole point of the clarification checks below: the
// engine can leave a step in a state, and if this set does not include
// it, no screen will ever show it again.
const { OPEN_STATUSES } = await server.ssrLoadModule('/src/lib/chain.ts');
const OPEN = new Set(OPEN_STATUSES);

const client = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('begin');

const q = (sql, params) => client.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];
const all = async (sql, params) => (await q(sql, params)).rows;

try {
  const tenant = (await one(`select id from public.tenants where slug = 'template'`))?.id;
  if (!tenant) throw new Error('no template tenant — run npm run db:apply first');
  // Column defaults read this.
  await q(`select set_config('app.tenant_id', $1, true)`, [tenant]);

  const requester = 'EMP-2847';

  async function newSubmission(templateId) {
    const row = await one(
      `insert into public.form_submissions (form_template_id, submitted_by, status)
       values ($1, $2, 'submitted') returning id`,
      [templateId, requester],
    );
    return row.id;
  }
  const chainOf = (submissionId) =>
    all(
      `select id, approver_user_id, step_index, status
         from public.approval_requests
        where submission_id = $1 order by step_index`,
      [submissionId],
    );
  const liveStep = (steps) => steps.find((s) => s.status === 'pending') ?? null;

  // -------------------------------------------------------------
  console.log('\nreachable');
  // -------------------------------------------------------------
  // Every approver any rule can name has to be somebody a viewer can be.
  const named = await all(
    `select distinct approver_user_id from public.approval_rules
      where tenant_id = $1 and approver_user_id is not null
     union
     select distinct approver_user_id from public.approval_slabs
      where tenant_id = $1 and approver_user_id is not null`,
    [tenant],
  );
  const unreachable = named
    .map((r) => r.approver_user_id)
    .filter((id) => !PERSONAS.has(id));
  ok(
    `all ${named.length} approvers in the rules are personas somebody can switch to`,
    unreachable.length === 0,
    unreachable.join(', '),
  );

  // -------------------------------------------------------------
  console.log('\nthe walk');
  // -------------------------------------------------------------
  const templates = await all(
    `select id, name from public.form_templates
      where tenant_id = $1 and status = 'published' order by name`,
    [tenant],
  );
  ok('there are published forms to walk', templates.length > 0);

  for (const t of templates) {
    const sub = await newSubmission(t.id);
    await q(`select public.build_approval_chain('form_submission', $1, $2, 0)`, [sub, t.id]);
    let steps = await chainOf(sub);

    if (steps.length === 0) {
      ok(`${t.name}: builds a chain`, false, 'no steps created');
      continue;
    }

    const pendingCount = steps.filter((s) => s.status === 'pending').length;
    ok(
      `${t.name}: exactly one step is live at the start`,
      pendingCount === 1,
      `${pendingCount} pending of ${steps.length}`,
    );
    ok(
      `${t.name}: the live step is the lowest one`,
      liveStep(steps)?.step_index === steps[0].step_index,
    );

    // Walk it to the end, checking each hand-off.
    let guard = 0;
    let walked = 0;
    while (guard++ < 20) {
      steps = await chainOf(sub);
      const live = liveStep(steps);
      if (!live) break;
      if (!PERSONAS.has(live.approver_user_id)) {
        ok(
          `${t.name}: step ${live.step_index} is with somebody who can act`,
          false,
          `${live.approver_user_id} is not a persona — this request cannot move`,
        );
        break;
      }
      await q(`select public.act_on_approval($1, 'approve', null)`, [live.id]);
      walked++;
    }

    steps = await chainOf(sub);
    ok(
      `${t.name}: reaches fully approved in ${walked} step${walked === 1 ? '' : 's'}`,
      steps.length > 0 && steps.every((s) => s.status === 'approved'),
      steps.map((s) => `${s.step_index}:${s.status}`).join(' '),
    );
    const finalStatus = (await one(`select status from public.form_submissions where id = $1`, [sub]))
      ?.status;
    ok(`${t.name}: the submission itself is finished`, finalStatus === 'completed', finalStatus);
  }

  // -------------------------------------------------------------
  console.log('\nescalation');
  // -------------------------------------------------------------
  const money = await one(
    `select ft.id, ft.name from public.form_templates ft
      where ft.tenant_id = $1 and exists (
        select 1 from public.approval_rules r
         where r.form_template_id = ft.id and r.label = 'slab_finance')
      limit 1`,
    [tenant],
  );
  if (!money) {
    ok('a form routes by amount', false, 'no slab_finance rule seeded');
  } else {
    const bands = await all(
      `select min_amount, approver_user_id from public.approval_slabs
        where form_template_id = $1 order by order_index`,
      [money.id],
    );
    const big = await newSubmission(money.id);
    await q(`select public.build_approval_chain('form_submission', $1, $2, 620000)`, [big, money.id]);
    const steps = await chainOf(big);
    const chainIds = steps.map((s) => s.approver_user_id);

    for (const b of bands) {
      ok(
        `620,000 is asked of the ${Number(b.min_amount).toLocaleString('en-US')} band (${b.approver_user_id})`,
        chainIds.includes(b.approver_user_id),
      );
    }
    // Cumulative means in ascending order of threshold, not the top alone.
    const positions = bands.map((b) => chainIds.indexOf(b.approver_user_id));
    ok(
      'the bands are asked lowest threshold first',
      positions.every((p, i) => i === 0 || (p > positions[i - 1] && p >= 0)),
      positions.join(' < '),
    );

    const small = await newSubmission(money.id);
    await q(`select public.build_approval_chain('form_submission', $1, $2, 5000)`, [small, money.id]);
    const smallIds = (await chainOf(small)).map((s) => s.approver_user_id);
    ok(
      'a small claim stops at the lowest band',
      !smallIds.includes(bands[bands.length - 1].approver_user_id),
      smallIds.join(' '),
    );
  }

  // -------------------------------------------------------------
  console.log('\npaused, and started again');
  // -------------------------------------------------------------
  {
    const t = templates[0];
    const sub = await newSubmission(t.id);
    await q(`select public.build_approval_chain('form_submission', $1, $2, 0)`, [sub, t.id]);
    const live = liveStep(await chainOf(sub));

    await q(`select public.act_on_approval($1, 'clarification', 'which cost centre?')`, [live.id]);
    let step = (await chainOf(sub)).find((s) => s.id === live.id);
    ok('asking for clarification pauses the step', step.status === 'clarification', step.status);

    // The fault this suite was written for: the step is held, and the
    // only way out is an action nothing in the app used to call.
    ok(
      'the queues count a paused step as open, so one can still show it',
      OPEN.has('clarification'),
      `OPEN_STATUSES is [${[...OPEN].join(', ')}] — a clarified step would be invisible`,
    );
    const held = await all(
      `select id from public.approval_requests
        where submission_id = $1 and status = any($2::text[])`,
      [sub, [...OPEN]],
    );
    ok('and the queue query actually returns it', held.length === 1, `${held.length} rows`);

    await q(`select public.act_on_approval($1, 'resume', null)`, [live.id]);
    step = (await chainOf(sub)).find((s) => s.id === live.id);
    ok('resuming puts it back with its approver', step.status === 'pending', step.status);

    await q(`select public.act_on_approval($1, 'approve', null)`, [live.id]);
    step = (await chainOf(sub)).find((s) => s.id === live.id);
    ok('and it can then be approved normally', step.status === 'approved', step.status);
  }

  // -------------------------------------------------------------
  console.log('\nrejected');
  // -------------------------------------------------------------
  {
    const many = templates.find(async (t) => true) ?? templates[0];
    const sub = await newSubmission(many.id);
    await q(`select public.build_approval_chain('form_submission', $1, $2, 620000)`, [
      sub,
      money ? money.id : many.id,
    ]);
    const steps = await chainOf(sub);
    const live = liveStep(steps);
    await q(`select public.act_on_approval($1, 'reject', 'not this time')`, [live.id]);

    const after = await chainOf(sub);
    ok('a rejection leaves nothing live', after.every((s) => s.status !== 'pending'));
    ok(
      'the approvers above it are recorded as never asked',
      after.filter((s) => s.step_index > live.step_index).every((s) => s.status === 'skipped'),
      after.map((s) => `${s.step_index}:${s.status}`).join(' '),
    );
  }

  // -------------------------------------------------------------
  console.log('\nthe mover');
  // -------------------------------------------------------------
  {
    const order = await one(
      `select id, item_id, source_venue_id, destination_venue_id, quantity, assigned_mover_id
         from public.movement_orders
        where tenant_id = $1 and status = 'submitted' limit 1`,
      [tenant],
    );
    if (!order) {
      ok('a movement order is waiting to be approved', false, 'none seeded as submitted');
    } else {
      const mover = order.assigned_mover_id || [...PERSONAS][0];
      await q(`select public.approve_movement_order($1,$2,$3,$4,$5,$6,$7)`, [
        order.id, order.item_id, order.source_venue_id, order.destination_venue_id,
        order.quantity, mover, null,
      ]);
      const after = await one(
        `select status, assigned_mover_id from public.movement_orders where id = $1`,
        [order.id],
      );
      ok('approving a movement order assigns its mover', after.status === 'approved');
      ok(
        'and the mover is somebody a viewer can be',
        PERSONAS.has(after.assigned_mover_id),
        `${after.assigned_mover_id} is not a persona — nobody could mark it delivered`,
      );
    }
  }
} finally {
  await client.query('rollback');
  await client.end();
  await server.close();
}

console.log('');
if (failures > 0) {
  console.error(`${failures} JOURNEY CHECK${failures === 1 ? '' : 'S'} FAILED`);
  process.exit(1);
}
console.log('THE JOURNEY HOLDS END TO END');
