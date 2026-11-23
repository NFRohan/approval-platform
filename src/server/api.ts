// =====================================================================
// The open API: /api/v1/*
//
// For an organisation's other systems — the ERP raising a purchase
// request or approving from its own screens, Tableau pulling reports
// each night. Authenticated by an API key, issued under Administration
// → Integrations and shown once: `Authorization: Bearer ams_<prefix>_<secret>`.
//
// A key carries scopes, and every endpoint names the one it needs. What
// the key may then see and do is decided where everything else is: the
// same row-level security, the same chain engine. A key reads as the
// organisation; it acts as an employee — on_behalf_of — so a decision
// made from the ERP is the approver's, checked exactly as one made on
// screen, delegation and all.
//
// Every call is logged (public.api_requests), in the audit centre.
// =====================================================================

import { createHash, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { getPool, withContext, type RequestContext } from './db';
import { HttpError } from './tables';
import { runReport, requireReports } from './reports';
import { toCsv } from './export';
import { kickMailer, appUrl } from './mailer';
import { logAppError } from './logs';
import { isDataset, type ReportFilters } from '@/lib/report-catalogue';
import { openApiDocument, type ApiScope } from '@/lib/api-catalogue';

export type ApiKey = { id: string; tenantId: string; slug: string; name: string; scopes: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPLOYEE = /^[A-Za-z0-9._-]{1,40}$/;
const KEY = /^ams_([a-z0-9]{8})_([A-Za-z0-9]{20,80})$/;

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
  });
}

/** The key on the request, checked against its hash. */
async function authenticate(request: Request): Promise<{ key: ApiKey } | { error: ApiError; keyId?: string; tenantId?: string }> {
  const auth = request.headers.get('authorization') ?? '';
  const raw = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : (request.headers.get('x-api-key') ?? '').trim();
  if (!raw) return { error: new ApiError(401, 'send an API key: Authorization: Bearer ams_…') };
  const m = KEY.exec(raw);
  if (!m) return { error: new ApiError(401, 'that is not an API key') };

  const { rows: [k] } = await getPool().query(
    `select k.id, k.tenant_id, k.name, k.scopes, k.secret_hash, k.revoked_at, k.last_used_at, t.slug,
            app.tenant_status(t.id) as tenant_status
       from public.api_keys k join public.tenants t on t.id = k.tenant_id
      where k.prefix = $1`, [m[1]]);
  if (!k) return { error: new ApiError(401, 'unknown API key') };
  const want = Buffer.from(k.secret_hash, 'hex');
  const got = Buffer.from(hashSecret(m[2]), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    return { error: new ApiError(401, 'unknown API key'), tenantId: k.tenant_id };
  }
  if (k.revoked_at) return { error: new ApiError(401, 'this API key has been revoked'), keyId: k.id, tenantId: k.tenant_id };
  if (k.tenant_status !== 'active') return { error: new ApiError(401, 'this organisation is not active'), keyId: k.id, tenantId: k.tenant_id };

  // Marked used at most once a minute, so a busy key is not a write per call.
  if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 60_000) {
    await getPool().query('update public.api_keys set last_used_at = now() where id = $1', [k.id]).catch(() => {});
  }
  return { key: { id: k.id, tenantId: k.tenant_id, slug: k.slug, name: k.name, scopes: k.scopes } };
}

function contextFor(key: ApiKey, employeeId: string | null = null): RequestContext {
  return { tenantId: key.tenantId, userId: key.id, apiKeyId: key.id, role: 'admin', isStaff: false, employeeId, mfa: false };
}

function need(key: ApiKey, scope: ApiScope) {
  if (!key.scopes.includes(scope)) throw new ApiError(403, `this key does not have the ${scope} scope`);
}

/** The employee a write is made as: named, and working here. */
async function actingAs(key: ApiKey, given: unknown, fallback?: string | null): Promise<string> {
  const id = typeof given === 'string' && given.trim() ? given.trim() : fallback ?? null;
  if (!id) throw new ApiError(400, 'say who this is for: on_behalf_of, an employee id');
  if (!EMPLOYEE.test(id)) throw new ApiError(400, 'on_behalf_of is not an employee id');
  const { rows: [e] } = await getPool().query(
    'select active from public.employees where tenant_id = $1 and employee_id = $2', [key.tenantId, id]);
  if (!e) throw new ApiError(404, `nobody with the id ${id} works here`);
  if (!e.active) throw new ApiError(403, `${id} has left`);
  return id;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'the body must be a JSON object');
  }
}

function intParam(url: URL, name: string, dflt: number, max: number): number {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, `${name} must be a whole number`);
  return Math.min(n, max);
}

/** A submission by id or reference, or 404. */
async function findRequest(c: pg.PoolClient, ref: string): Promise<{ id: string; status: string; submitted_by: string | null; form_template_id: string }> {
  const { rows: [s] } = await c.query(
    `select id, status, submitted_by, form_template_id from public.form_submissions
      where ${UUID.test(ref) ? 'id = $1::uuid' : 'upper(ref_number) = upper($1)'}`, [ref]);
  if (!s) throw new ApiError(404, `no request ${ref}`);
  return s;
}

async function requestDetail(c: pg.PoolClient, id: string) {
  const { rows: [r] } = await c.query('select app.request_json($1) as r', [id]);
  const { rows: steps } = await c.query(
    `select ar.id, ar.step_index + 1 as step, ar.stage_label as stage, ar.lane_label as lane,
            jsonb_build_object('employee_id', ar.approver_user_id, 'name', e.name) as approver,
            ar.status, ar.opened_at, ar.deadline_at, ar.acted_at, ar.comment, ar.require_signature
       from public.approval_requests ar
       left join public.employees e on e.employee_id = ar.approver_user_id and e.tenant_id = ar.tenant_id
      where ar.submission_id = $1 order by ar.step_index, ar.lane nulls first, ar.lane_step nulls first`, [id]);
  const { rows: history } = await c.query(
    `select created_at as at, action, actor_id as actor, comment from public.approval_events
      where subject_id = $1 order by created_at`, [id]);
  const { rows: notes } = await c.query(
    `select n.created_at as at, n.author_id as author, e.name as author_name, n.body
       from public.ticket_notes n left join public.employees e on e.employee_id = n.author_id and e.tenant_id = n.tenant_id
      where n.submission_id = $1 order by n.created_at`, [id]);
  const { rows: cc } = await c.query('select employee_id from public.submission_cc where submission_id = $1', [id]);
  return { ...r.r, approvals: steps, history, notes, cc: cc.map((x) => x.employee_id) };
}

const NOT_ANSWERS = (t: string) => t.startsWith('perm_') || t.startsWith('linked_') || t === 'section_header' || t === 'calculation';

async function loadForm(c: pg.PoolClient, ref: string) {
  const { rows: [f] } = await c.query(
    `select id, name, category, classification, keywords, status from public.form_templates
      where ${UUID.test(ref) ? 'id = $1::uuid' : 'lower(name) = lower($1)'} and status = 'published'`, [ref]);
  if (!f) throw new ApiError(404, `no published form ${ref}`);
  const { rows: fields } = await c.query(
    `select field_name as name, field_type as type, is_required as required, field_config->'options' as options,
            field_config->>'helper' as help
       from public.form_fields where form_template_id = $1 order by order_index`, [f.id]);
  return {
    id: f.id, name: f.name, category: f.category, classification: f.classification, keywords: f.keywords,
    fields: fields.filter((x) => !NOT_ANSWERS(x.type) && x.name).map((x) => ({
      name: x.name, type: x.type, required: !!x.required && !x.type.startsWith('gen_') && x.type !== 'file',
      ...(x.type.startsWith('gen_') ? { filled_in: 'from the employee record' } : {}),
      ...(x.type === 'file' ? { note: 'attach files on screen; the API takes the rest' } : {}),
      ...(Array.isArray(x.options) ? { options: x.options } : {}),
      ...(x.help ? { help: x.help } : {}),
    })),
  };
}

function answerText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------
// The endpoints.
// ---------------------------------------------------------------------
type Handler = (a: { key: ApiKey; url: URL; params: string[]; request: Request }) => Promise<{ status?: number; body: unknown; raw?: Response }>;
type Route = { method: string; pattern: RegExp; scope: ApiScope | null; handler: Handler };

const routes: Route[] = [
  {
    method: 'GET', pattern: /^me$/, scope: null,
    handler: async ({ key }) => ({ body: { data: { key: key.name, organisation: key.slug, scopes: key.scopes } } }),
  },
  {
    method: 'GET', pattern: /^forms$/, scope: 'forms:read',
    handler: async ({ key }) => withContext(contextFor(key), async (c) => {
      const { rows } = await c.query(`select id from public.form_templates where status = 'published' order by name`);
      const data = [];
      for (const r of rows) data.push(await loadForm(c, r.id));
      return { body: { data } };
    }),
  },
  {
    method: 'GET', pattern: /^forms\/([^/]+)$/, scope: 'forms:read',
    handler: async ({ key, params }) => withContext(contextFor(key), async (c) => ({ body: { data: await loadForm(c, params[0]) } })),
  },
  {
    method: 'GET', pattern: /^requests$/, scope: 'requests:read',
    handler: async ({ key, url }) => withContext(contextFor(key), async (c) => {
      const limit = Math.max(1, intParam(url, 'limit', 100, 500));
      const offset = intParam(url, 'offset', 0, 1_000_000);
      const status = url.searchParams.get('status') || null;
      const form = url.searchParams.get('form') || null;
      const requester = url.searchParams.get('requester') || null;
      const since = url.searchParams.get('since') || null;
      const updated = url.searchParams.get('updated_since') || null;
      const archived = url.searchParams.get('include_archived') === 'true';
      for (const [n, v] of [['since', since], ['updated_since', updated]] as const) {
        if (v && Number.isNaN(Date.parse(v))) throw new ApiError(400, `${n} must be an ISO 8601 date`);
      }
      const where = `from public.form_submissions s
        join public.form_templates t on t.id = s.form_template_id
       where ($1::text is null or s.status = $1) and ($1::text = 'draft' or s.status <> 'draft')
         and ($2::text is null or t.id::text = $2 or lower(t.name) = lower($2))
         and ($3::text is null or s.submitted_by = $3)
         and ($4::timestamptz is null or s.submitted_at >= $4)
         and ($5::timestamptz is null or s.submitted_at >= $5
              or exists (select 1 from public.approval_events ev where ev.subject_id = s.id and ev.created_at >= $5))
         and ($6 or s.archived_at is null)`;
      const args = [status, form, requester, since, updated, archived];
      const { rows: [n] } = await c.query(`select count(*)::int n ${where}`, args);
      const { rows } = await c.query(
        `select app.request_json(s.id) r ${where} order by s.submitted_at desc, s.id limit $7 offset $8`, [...args, limit, offset]);
      return { body: { data: rows.map((r) => r.r), paging: { limit, offset, next_offset: offset + rows.length < n.n ? offset + rows.length : null, total: n.n } } };
    }),
  },
  {
    method: 'GET', pattern: /^requests\/([^/]+)$/, scope: 'requests:read',
    handler: async ({ key, params }) => withContext(contextFor(key), async (c) => {
      const s = await findRequest(c, params[0]);
      return { body: { data: await requestDetail(c, s.id) } };
    }),
  },
  {
    method: 'POST', pattern: /^requests$/, scope: 'requests:write',
    handler: async ({ key, request }) => {
      const body = await readBody(request);
      const who = await actingAs(key, body.on_behalf_of);
      const submit = body.submit !== false;
      const priority = body.priority === undefined ? 'normal' : String(body.priority);
      if (!['normal', 'high', 'urgent'].includes(priority)) throw new ApiError(400, 'priority is normal, high or urgent');
      if (typeof body.form !== 'string' || !body.form.trim()) throw new ApiError(400, 'name the form: form, its id or exact name');
      const answers = body.answers ?? {};
      if (typeof answers !== 'object' || Array.isArray(answers)) throw new ApiError(400, 'answers must be an object keyed by field name');
      const cc = Array.isArray(body.cc) ? body.cc.map(String) : [];

      return withContext(contextFor(key, who), async (c) => {
        const form = await loadForm(c, body.form as string);
        const { rows: all } = await c.query(
          'select field_name, field_type, is_required from public.form_fields where form_template_id = $1 order by order_index', [form.id]);
        const { rows: [me] } = await c.query(
          'select name, designation, department, gate_pass_card_number from public.employees where employee_id = $1', [who]);
        const given = answers as Record<string, unknown>;
        const byName = new Map(all.filter((f) => f.field_name).map((f) => [String(f.field_name).toLowerCase(), f]));
        const unknown = Object.keys(given).filter((k) => !byName.has(k.toLowerCase()) || NOT_ANSWERS(byName.get(k.toLowerCase())!.field_type));
        if (unknown.length) throw new ApiError(422, `${form.name} has no field called ${unknown.map((u) => `"${u}"`).join(', ')}`, { unknown, fields: form.fields.map((f) => f.name) });

        const value = (f: { field_name: string; field_type: string }) => {
          if (f.field_type === 'gen_employee_name') return me?.name ?? '';
          if (f.field_type === 'gen_designation') return me?.designation ?? '';
          if (f.field_type === 'gen_gate_pass') return me?.gate_pass_card_number ?? '';
          const k = Object.keys(given).find((x) => x.toLowerCase() === f.field_name.toLowerCase());
          return k === undefined ? '' : answerText(given[k]);
        };
        const rows = all.filter((f) => f.field_name && !NOT_ANSWERS(f.field_type)).map((f) => ({ name: f.field_name as string, value: value(f), f }));
        if (submit) {
          const missing = rows.filter((r) => r.f.is_required && !r.f.field_type.startsWith('gen_') && r.f.field_type !== 'file' && !r.value.trim()).map((r) => r.name);
          if (missing.length) throw new ApiError(422, `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`, { missing });
        }

        const { rows: [s] } = await c.query(
          `insert into public.form_submissions (form_template_id, submitted_by, status, submitted_at, priority)
           values ($1, $2, $3, now(), $4) returning id`, [form.id, who, submit ? 'submitted' : 'draft', priority]);
        const filled = rows.filter((r) => r.value !== '');
        if (filled.length) {
          await c.query(
            `insert into public.submission_values (submission_id, field_name, value)
             select $1, n, v from unnest($2::text[], $3::text[]) x(n, v)`,
            [s.id, filled.map((r) => r.name), filled.map((r) => r.value)]);
        }
        if (cc.length) await c.query('select public.set_cc($1, $2::text[], $3)', [s.id, cc, who]);
        if (submit) await c.query(`select public.build_approval_chain('form_submission', $1, $2)`, [s.id, form.id]);
        await c.query(`select app.audit('raised_through_api', 'form_submission', $1, $2)`, [s.id, `${form.name} for ${who} by ${key.name}`]);
        return { status: 201, body: { data: await requestDetail(c, s.id) } };
      });
    },
  },
  {
    method: 'POST', pattern: /^requests\/([^/]+)\/submit$/, scope: 'requests:write',
    handler: async ({ key, params, request }) => {
      const body = await readBody(request);
      const s0 = await withContext(contextFor(key), (c) => findRequest(c, params[0]));
      const who = await actingAs(key, body.on_behalf_of, s0.submitted_by);
      return withContext(contextFor(key, who), async (c) => {
        const s = await findRequest(c, params[0]);
        if (s.status !== 'draft') throw new ApiError(409, `it is ${s.status.replace('_', ' ')}, not a draft`);
        if (s.submitted_by !== who) throw new ApiError(403, `only ${s.submitted_by} can submit their draft`);
        await c.query(`update public.form_submissions set status = 'submitted', submitted_at = now() where id = $1`, [s.id]);
        await c.query(`select public.build_approval_chain('form_submission', $1, $2)`, [s.id, s.form_template_id]);
        return { body: { data: await requestDetail(c, s.id) } };
      });
    },
  },
  {
    method: 'POST', pattern: /^requests\/([^/]+)\/notes$/, scope: 'requests:write',
    handler: async ({ key, params, request }) => {
      const body = await readBody(request);
      const who = await actingAs(key, body.on_behalf_of);
      if (typeof body.body !== 'string' || !body.body.trim()) throw new ApiError(400, 'the note needs a body');
      return withContext(contextFor(key, who), async (c) => {
        const s = await findRequest(c, params[0]);
        const { rows: [n] } = await c.query('select public.add_note($1, $2, $3) as id', [s.id, (body.body as string).slice(0, 8000), who]);
        return { status: 201, body: { data: { id: n.id, request: s.id } } };
      });
    },
  },
  {
    method: 'POST', pattern: /^requests\/([^/]+)\/cancel$/, scope: 'requests:write',
    handler: async ({ key, params, request }) => {
      const body = await readBody(request);
      const s0 = await withContext(contextFor(key), (c) => findRequest(c, params[0]));
      const who = await actingAs(key, body.on_behalf_of, s0.submitted_by);
      return withContext(contextFor(key, who), async (c) => {
        await c.query('select public.cancel_submission($1, $2, $3)', [s0.id, typeof body.comment === 'string' ? body.comment : null, who]);
        return { body: { data: await requestDetail(c, s0.id) } };
      });
    },
  },
  {
    method: 'GET', pattern: /^approvals$/, scope: 'requests:read',
    handler: async ({ key, url }) => withContext(contextFor(key), async (c) => {
      const status = url.searchParams.get('status') || 'pending';
      const approver = url.searchParams.get('approver') || null;
      const limit = Math.max(1, intParam(url, 'limit', 100, 500));
      const { rows } = await c.query(
        `select ar.id, ar.step_index + 1 as step, ar.stage_label as stage, ar.lane_label as lane, ar.status,
                jsonb_build_object('employee_id', ar.approver_user_id, 'name', e.name) as approver,
                ar.opened_at, ar.deadline_at, ar.acted_at, ar.require_signature,
                jsonb_build_object('id', s.id, 'reference', s.ref_number, 'form', t.name, 'requester', s.submitted_by,
                                   'submitted_at', s.submitted_at, 'priority', s.priority) as request
           from public.approval_requests ar
           join public.form_submissions s on s.id = ar.submission_id
           join public.form_templates t on t.id = s.form_template_id
           left join public.employees e on e.employee_id = ar.approver_user_id and e.tenant_id = ar.tenant_id
          where ar.status = $1 and ($2::text is null or ar.approver_user_id = $2)
          order by ar.deadline_at nulls last, ar.opened_at limit $3`, [status, approver, limit]);
      return { body: { data: rows } };
    }),
  },
  {
    method: 'POST', pattern: /^approvals\/([^/]+)\/decision$/, scope: 'approvals:write',
    handler: async ({ key, params, request }) => {
      if (!UUID.test(params[0])) throw new ApiError(404, 'no such approval step');
      const body = await readBody(request);
      const decision = String(body.decision ?? '');
      if (!['approve', 'reject', 'clarification'].includes(decision)) throw new ApiError(400, 'decision is approve, reject or clarification');
      const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim() : null;
      if (decision !== 'approve' && !comment) throw new ApiError(400, `a ${decision === 'reject' ? 'rejection' : 'request for clarification'} needs a comment`);
      const step = await withContext(contextFor(key), async (c) =>
        (await c.query('select id, approver_user_id, submission_id from public.approval_requests where id = $1', [params[0]])).rows[0]);
      if (!step) throw new ApiError(404, 'no such approval step');
      const who = await actingAs(key, body.on_behalf_of, step.approver_user_id);
      return withContext(contextFor(key, who), async (c) => {
        const { rows: [r] } = await c.query('select public.act_on_approval($1, $2, $3, $4, $5) as outcome',
          [step.id, decision, comment, who, typeof body.signature === 'string' ? body.signature : null]);
        return { body: { data: { outcome: r.outcome, request: await requestDetail(c, step.submission_id) } } };
      });
    },
  },
  {
    method: 'GET', pattern: /^reports$/, scope: 'reports:read',
    handler: async ({ key }) => withContext(contextFor(key), async (c) => {
      await requireReports(c);
      const { rows } = await c.query(
        `select id, name, description, dataset, columns, filters, standard, updated_at from public.report_templates order by standard desc, name`);
      return { body: { data: rows } };
    }),
  },
  {
    method: 'GET', pattern: /^reports\/([^/]+)$/, scope: 'reports:read',
    handler: async ({ key, params, url }) => {
      if (!UUID.test(params[0])) throw new ApiError(404, 'no such report');
      const format = url.searchParams.get('format') ?? 'json';
      if (!['json', 'csv'].includes(format)) throw new ApiError(400, 'format is json or csv');
      return withContext(contextFor(key), async (c) => {
        await requireReports(c);
        const { rows: [t] } = await c.query('select name, dataset, columns, filters from public.report_templates where id = $1', [params[0]]);
        if (!t || !isDataset(t.dataset)) throw new ApiError(404, 'no such report');
        const result = await runReport(c, t.dataset, t.columns, t.filters as ReportFilters);
        if (format === 'csv') {
          const name = String(t.name).replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'report';
          return {
            body: null,
            raw: new Response(toCsv(result), {
              status: 200,
              headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store' },
            }),
          };
        }
        return { body: { data: { name: t.name, ...result } } };
      });
    },
  },
  {
    method: 'GET', pattern: /^campaigns$/, scope: 'campaigns:read',
    handler: async ({ key, url }) => withContext(contextFor(key), async (c) => {
      const status = url.searchParams.get('status') || null;
      const { rows } = await c.query(
        `select c.id, c.name, c.status, c.audience, c.modality, c.coupon, c.exceptional, c.starts_on, c.ends_on,
                c.budget::float8 as budget, coalesce(sum(a.cost), 0)::float8 as spent,
                case when c.budget > 0 then round(coalesce(sum(a.cost), 0) / c.budget, 4)::float8 end as utilisation,
                coalesce(sum(a.beneficiaries), 0)::int as beneficiaries, coalesce(sum(a.transactions), 0)::int as transactions,
                c.kpi, c.cost_center, c.gl_code, c.requester_id, c.reviewer_id
           from public.campaigns c left join public.campaign_actuals a on a.campaign_id = c.id
          where ($1::text is null or c.status = $1)
          group by c.id order by c.starts_on desc`, [status]);
      return { body: { data: rows } };
    }),
  },
];

/** Map an error to the API's answer. Postgres's own codes as data-fn does. */
function errorResponse(err: unknown): { status: number; message: string; details?: unknown; log: boolean } {
  if (err instanceof ApiError) return { status: err.status, message: err.message, details: err.details, log: false };
  if (err instanceof HttpError) return { status: err.status, message: err.message, log: false };
  const e = err as { code?: string; message?: string };
  if (e?.code === '28000') return { status: 401, message: e.message ?? 'not authorised', log: false };
  if (e?.code === '42501') return { status: 403, message: 'not permitted', log: false };
  if (e?.code === 'P0001' && e.message) {
    const m = e.message;
    const status = /not the approver|may not|only |not allowed|cannot act|permission/i.test(m) ? 403
      : /no such/i.test(m) ? 404 : 409;
    return { status, message: m, log: false };
  }
  if (e?.code === '23505') return { status: 409, message: 'already exists', log: false };
  if (e?.code === '23503') return { status: 409, message: 'refers to something that does not exist', log: false };
  if (e?.code === '23514') return { status: 422, message: 'a value is not allowed here', log: false };
  if (e?.code === '22P02' || e?.code === '22007' || e?.code === '22008') return { status: 400, message: 'a value could not be read', log: false };
  return { status: 500, message: 'internal error', log: true };
}

async function logCall(r: { tenantId: string; keyId: string | null; method: string; path: string; status: number; ms: number; ip: string | null; error: string | null }) {
  try {
    await getPool().query(
      `insert into public.api_requests (tenant_id, key_id, method, path, status, ms, ip, error) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.tenantId, r.keyId, r.method, r.path.slice(0, 500), r.status, r.ms, r.ip, r.error?.slice(0, 500) ?? null]);
  } catch (err) {
    console.error('[api] could not log a call', err instanceof Error ? err.message : err);
  }
}

export async function handleApi(request: Request, splat: string): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const path = splat.replace(/^\/+|\/+$/g, '');
  const method = request.method.toUpperCase();

  if (method === 'GET' && (path === '' || path === 'openapi.json')) {
    if (path === 'openapi.json') return json(200, openApiDocument(appUrl()), { 'access-control-allow-origin': '*' });
    return json(200, { name: 'Approval Management System API', version: 1, openapi: '/api/v1/openapi.json', docs: '/developers' });
  }

  const auth = await authenticate(request);
  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  const logged = url.pathname + (url.search.length > 1 ? url.search : '');
  if ('error' in auth) {
    if (auth.tenantId) {
      await logCall({ tenantId: auth.tenantId, keyId: auth.keyId ?? null, method, path: logged, status: 401, ms: Date.now() - started, ip, error: auth.error.message });
    }
    return json(401, { error: { status: 401, message: auth.error.message } }, { 'www-authenticate': 'Bearer' });
  }
  const { key } = auth;

  let status = 200;
  let response: Response;
  let errorText: string | null = null;
  try {
    const candidates = routes.filter((r) => r.pattern.test(path));
    const route = candidates.find((r) => r.method === method);
    if (!route) {
      throw candidates.length
        ? new ApiError(405, `use ${candidates.map((r) => r.method).join(' or ')} for /${path}`)
        : new ApiError(404, `there is no /api/v1/${path}`);
    }
    if (route.scope) need(key, route.scope);
    const params = (route.pattern.exec(path) ?? []).slice(1).map((p) => decodeURIComponent(p));
    const out = await route.handler({ key, url, params, request });
    status = out.raw?.status ?? out.status ?? 200;
    response = out.raw ?? json(status, out.body);
    // Decisions and new requests tell people, and other systems.
    if (method === 'POST') await kickMailer(key.tenantId);
  } catch (err) {
    const e = errorResponse(err);
    status = e.status;
    errorText = e.message;
    if (e.log) {
      console.error('[api]', err instanceof Error ? err.message : err);
      await logAppError(`api ${method} /${path.split('/')[0]}`, err, 500, key.tenantId);
    }
    response = json(status, { error: { status, message: e.message, ...(e.details ? { details: e.details } : {}) } });
  }
  await logCall({ tenantId: key.tenantId, keyId: key.id, method, path: logged, status, ms: Date.now() - started, ip, error: errorText });
  response.headers.set('x-request-ms', String(Date.now() - started));
  return response;
}
