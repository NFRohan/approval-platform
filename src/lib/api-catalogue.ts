// =====================================================================
// The open API, described once: the scopes a key may hold, the events
// a webhook may listen for, and every endpoint. The OpenAPI document
// (/api/v1/openapi.json) and the developer page (/developers) are both
// made from this, so neither can drift from the other.
//
// Safe for the browser: no server imports.
// =====================================================================

export const API_SCOPES = [
  { key: 'requests:read', label: 'Read requests', detail: 'List and read requests, their answers, approvals and history.' },
  { key: 'requests:write', label: 'Raise requests', detail: 'Raise, submit, note and cancel requests for an employee.' },
  { key: 'approvals:write', label: 'Decide approvals', detail: 'Approve, reject or ask for clarification, as the approver.' },
  { key: 'forms:read', label: 'Read forms', detail: 'The published forms and their fields.' },
  { key: 'reports:read', label: 'Run reports', detail: 'Saved reports, as JSON or CSV — for Tableau and the like.' },
  { key: 'campaigns:read', label: 'Read campaigns', detail: 'Campaigns, their budgets and what has been spent.' },
  { key: 'audit:read', label: 'Read the audit trail', detail: 'The audit trail as a feed a SIEM or log platform pulls.' },
] as const;
export type ApiScope = (typeof API_SCOPES)[number]['key'];

export const WEBHOOK_EVENTS = [
  { key: 'request.submitted', label: 'Request submitted' },
  { key: 'request.completed', label: 'Request completed — every approval given' },
  { key: 'request.rejected', label: 'Request rejected' },
  { key: 'request.cancelled', label: 'Request cancelled' },
  { key: 'request.recalled', label: 'Request recalled by the requester' },
  { key: 'request.note_added', label: 'Note added' },
  { key: 'approval.approved', label: 'A step approved' },
  { key: 'approval.rejected', label: 'A step rejected' },
  { key: 'approval.clarification', label: 'Clarification asked for' },
] as const;

export type Param = { name: string; in: 'path' | 'query'; required?: boolean; description: string; example?: string };
export type Endpoint = {
  id: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  summary: string;
  description: string;
  scope: ApiScope | null;
  params?: Param[];
  body?: { description: string; example: Record<string, unknown> };
  response: { status: number; example: unknown };
  group: 'Requests' | 'Approvals' | 'Forms' | 'Reports' | 'Campaigns' | 'Audit' | 'Meta';
};

const REQUEST_EXAMPLE = {
  id: '6f1c2a0e-3d4b-4c7a-9e21-0b8f6d2c1a55',
  reference: 'AMS-2026-00418',
  form: { id: '11111111-0000-4000-8000-000000000001', name: 'Travel & Expense Reimbursement', category: 'Finance' },
  status: 'in_progress',
  priority: 'normal',
  flag: null,
  requester: { employee_id: 'EMP-2847', name: 'Tom Bexley', department: 'Operations' },
  submitted_at: '2026-11-20T04:12:09.000Z',
  archived_at: null,
  legacy: null,
  answers: { 'Purpose of travel': 'Client visit, Chattogram', 'Travel date': '2026-11-28', 'Amount claimed': '42000' },
};

export const ENDPOINTS: Endpoint[] = [
  {
    id: 'list-requests', group: 'Requests', method: 'GET', path: '/requests', scope: 'requests:read',
    summary: 'List requests',
    description: 'Newest first, a page at a time. Archived requests — and tickets migrated from ManageEngine — are left out unless you ask for them. For an ERP that keeps itself in step, poll with updated_since, or listen for webhooks instead. paging.total is exact up to 10,000; above that it is null and total_at_least says 10,000 — follow next_offset.',
    params: [
      { name: 'status', in: 'query', description: 'draft, submitted, in_progress, on_hold, completed, rejected or cancelled', example: 'completed' },
      { name: 'form', in: 'query', description: "A form's id or exact name", example: 'Travel & Expense Reimbursement' },
      { name: 'requester', in: 'query', description: 'Employee id of who raised it', example: 'EMP-2847' },
      { name: 'since', in: 'query', description: 'Raised on or after this date (ISO 8601)', example: '2026-11-01' },
      { name: 'updated_since', in: 'query', description: 'Anything happened to it on or after this time', example: '2026-11-22T00:00:00Z' },
      { name: 'include_archived', in: 'query', description: 'true to include archived and migrated records', example: 'false' },
      { name: 'limit', in: 'query', description: 'At most 500; 100 if not given', example: '100' },
      { name: 'offset', in: 'query', description: 'Skip this many — next_offset from the previous page', example: '0' },
    ],
    response: { status: 200, example: { data: [REQUEST_EXAMPLE], paging: { limit: 100, offset: 0, next_offset: null, total: 1 } } },
  },
  {
    id: 'get-request', group: 'Requests', method: 'GET', path: '/requests/{id}', scope: 'requests:read',
    summary: 'Read one request',
    description: 'By its id or its reference (AMS-2026-00418, or ME-SR-10237 for a migrated ticket): the answers, every approval step with who and when, the history, and the notes.',
    params: [{ name: 'id', in: 'path', required: true, description: 'The id or the reference', example: 'AMS-2026-00418' }],
    response: {
      status: 200,
      example: {
        data: {
          ...REQUEST_EXAMPLE,
          approvals: [{ id: '0d6c…', step: 1, stage: 'Line manager', lane: null, approver: { employee_id: 'EMP-1134', name: 'Sam Lindqvist' }, status: 'approved', opened_at: '2026-11-20T04:12:10Z', deadline_at: '2026-11-22T04:12:10Z', acted_at: '2026-11-20T09:40:00Z', comment: 'Looks fine.' }],
          history: [{ at: '2026-11-20T04:12:09Z', action: 'submitted', actor: 'EMP-2847', comment: null }],
          notes: [],
        },
      },
    },
  },
  {
    id: 'create-request', group: 'Requests', method: 'POST', path: '/requests', scope: 'requests:write',
    summary: 'Raise a request',
    description: "For an employee — on_behalf_of — exactly as if they had filled in the form: the answers are checked against the form's required fields, the approval chain is built from the same rules, and the same people are told. Answers are keyed by the field's name as GET /forms shows it. With submit: false it is kept as the employee's draft.",
    body: {
      description: 'form is an id or exact name; answers are keyed by field name.',
      example: {
        form: 'Travel & Expense Reimbursement', on_behalf_of: 'EMP-2847', priority: 'normal', submit: true,
        answers: { 'Purpose of travel': 'Client visit, Chattogram', 'Travel date': '2026-11-28', 'Amount claimed': 42000 },
        cc: ['EMP-0312'],
      },
    },
    response: { status: 201, example: { data: { ...REQUEST_EXAMPLE, status: 'in_progress' } } },
  },
  {
    id: 'edit-request', group: 'Requests', method: 'PATCH', path: '/requests/{id}', scope: 'requests:write',
    summary: 'Edit a draft',
    description: "Change a draft's answers or priority, as whoever raised it. Only the answers given change; an answer set to null or \"\" is cleared. With submit: true it is then sent for approval, its required fields checked first.",
    params: [{ name: 'id', in: 'path', required: true, description: 'The id or the reference' }],
    body: {
      description: 'Who is editing, and what changes.',
      example: { on_behalf_of: 'EMP-2847', answers: { 'Amount claimed': 45500 }, priority: 'high', submit: false },
    },
    response: { status: 200, example: { data: { ...REQUEST_EXAMPLE, status: 'draft' } } },
  },
  {
    id: 'submit-request', group: 'Requests', method: 'POST', path: '/requests/{id}/submit', scope: 'requests:write',
    summary: 'Submit a draft',
    description: 'A draft raised with submit: false, sent for approval. on_behalf_of must be whoever raised it.',
    params: [{ name: 'id', in: 'path', required: true, description: 'The id or the reference' }],
    body: { description: 'Who is submitting it.', example: { on_behalf_of: 'EMP-2847' } },
    response: { status: 200, example: { data: { ...REQUEST_EXAMPLE, status: 'in_progress' } } },
  },
  {
    id: 'note-request', group: 'Requests', method: 'POST', path: '/requests/{id}/notes', scope: 'requests:write',
    summary: 'Add a note',
    description: 'A note on the ticket, from somebody on it — the requester, an approver or somebody copied. Everybody on it is told.',
    params: [{ name: 'id', in: 'path', required: true, description: 'The id or the reference' }],
    body: { description: 'The note, and who it is from.', example: { on_behalf_of: 'EMP-0312', body: 'PO 4500017321 raised in SAP.' } },
    response: { status: 201, example: { data: { ok: true } } },
  },
  {
    id: 'cancel-request', group: 'Requests', method: 'POST', path: '/requests/{id}/cancel', scope: 'requests:write',
    summary: 'Cancel a request',
    description: 'By the requester, while it is still open.',
    params: [{ name: 'id', in: 'path', required: true, description: 'The id or the reference' }],
    body: { description: 'Who is cancelling, and why.', example: { on_behalf_of: 'EMP-2847', comment: 'Trip postponed.' } },
    response: { status: 200, example: { data: { ...REQUEST_EXAMPLE, status: 'cancelled' } } },
  },
  {
    id: 'list-approvals', group: 'Approvals', method: 'GET', path: '/approvals', scope: 'requests:read',
    summary: 'List approval steps',
    description: "Steps waiting on somebody — an approver's queue — or any status you ask for.",
    params: [
      { name: 'approver', in: 'query', description: 'Employee id of the approver', example: 'EMP-1134' },
      { name: 'status', in: 'query', description: 'pending (the default), approved, rejected, clarification, waiting', example: 'pending' },
      { name: 'limit', in: 'query', description: 'At most 500; 100 if not given' },
    ],
    response: { status: 200, example: { data: [{ id: '0d6c…', step: 1, stage: 'Line manager', status: 'pending', approver: { employee_id: 'EMP-1134', name: 'Sam Lindqvist' }, opened_at: '2026-11-20T04:12:10Z', deadline_at: '2026-11-22T04:12:10Z', request: { id: REQUEST_EXAMPLE.id, reference: REQUEST_EXAMPLE.reference, form: REQUEST_EXAMPLE.form.name, requester: 'EMP-2847' } }] } },
  },
  {
    id: 'decide-approval', group: 'Approvals', method: 'POST', path: '/approvals/{id}/decision', scope: 'approvals:write',
    summary: 'Approve, reject or ask for clarification',
    description: "As the step's approver — or a delegate of theirs, named in on_behalf_of. Everything a decision on screen does happens: the next step opens, people are told, the trail records it. A step that asks for a signature needs one, as a data: URL of an image.",
    params: [{ name: 'id', in: 'path', required: true, description: "The approval step's id" }],
    body: { description: 'decision is approve, reject or clarification; a rejection needs a comment.', example: { decision: 'approve', comment: 'Budget confirmed in SAP.', on_behalf_of: 'EMP-1134' } },
    response: { status: 200, example: { data: { outcome: 'open', request: { ...REQUEST_EXAMPLE, status: 'in_progress' } } } },
  },
  {
    id: 'list-forms', group: 'Forms', method: 'GET', path: '/forms', scope: 'forms:read',
    summary: 'List published forms',
    description: 'Every form somebody can raise, with its fields — the names to key answers by, their types, which are required and the choices a select offers.',
    response: { status: 200, example: { data: [{ id: REQUEST_EXAMPLE.form.id, name: 'Travel & Expense Reimbursement', category: 'Finance', classification: 'budgetary', fields: [{ name: 'Purpose of travel', type: 'text', required: true }, { name: 'Amount claimed', type: 'money', required: true }] }] } },
  },
  {
    id: 'get-form', group: 'Forms', method: 'GET', path: '/forms/{id}', scope: 'forms:read',
    summary: 'Read one form',
    description: 'By id or exact name.',
    params: [{ name: 'id', in: 'path', required: true, description: 'The id or the name' }],
    response: { status: 200, example: { data: { id: REQUEST_EXAMPLE.form.id, name: 'Travel & Expense Reimbursement', fields: [] } } },
  },
  {
    id: 'list-reports', group: 'Reports', method: 'GET', path: '/reports', scope: 'reports:read',
    summary: 'List saved reports',
    description: 'The report templates the organisation has saved — the standard ones and its own.',
    response: { status: 200, example: { data: [{ id: '9b1e…', name: 'Turnaround by form', dataset: 'requests', columns: ['form', 'count', 'median_days'] }] } },
  },
  {
    id: 'run-report', group: 'Reports', method: 'GET', path: '/reports/{id}', scope: 'reports:read',
    summary: 'Run a report',
    description: 'With its saved filters. format=csv for a file Tableau, Power BI or Excel can read directly; json (the default) for rows with typed columns.',
    params: [
      { name: 'id', in: 'path', required: true, description: "The report template's id" },
      { name: 'format', in: 'query', description: 'json or csv', example: 'csv' },
    ],
    response: { status: 200, example: { data: { columns: [{ key: 'form', label: 'Form', type: 'text' }], rows: [{ form: 'Travel & Expense Reimbursement' }], truncated: false } } },
  },
  {
    id: 'list-campaigns', group: 'Campaigns', method: 'GET', path: '/campaigns', scope: 'campaigns:read',
    summary: 'List campaigns',
    description: 'Every campaign with its budget, what has been spent against it and its status — for a commercial dashboard.',
    params: [{ name: 'status', in: 'query', description: 'upcoming, ongoing, completed, discontinued or discarded' }],
    response: { status: 200, example: { data: [{ id: '2c9a…', name: 'Boishakhi Cashback 2026', status: 'ongoing', audience: 'Customer', modality: 'Cashback', starts_on: '2026-10-12', ends_on: '2026-12-11', budget: 4500000, spent: 4329000, utilisation: 0.962 }] } },
  },
  {
    id: 'audit-feed', group: 'Audit', method: 'GET', path: '/audit', scope: 'audit:read',
    summary: 'Read the audit trail',
    description: "The audit centre's trail — user, application, system and database activity — oldest first, for a SIEM or log platform to pull. Ask again with next.since to read on from where the last page ended. format=ndjson returns one JSON object a line.",
    params: [
      { name: 'since', in: 'query', description: 'An ISO time; entries after it. Default: 24 hours ago', example: '2026-11-25T00:00:00Z' },
      { name: 'until', in: 'query', description: 'An ISO time; entries up to it. Default: now. At most 31 days after since' },
      { name: 'category', in: 'query', description: 'user, application, system or database' },
      { name: 'limit', in: 'query', description: 'At most 1,000; default 500' },
      { name: 'format', in: 'query', description: 'json (default) or ndjson' },
    ],
    response: {
      status: 200,
      example: {
        data: [{ at: '2026-11-25T03:12:44.120Z', category: 'user', severity: 'warning', source: 'sign_in', action: 'sign_in_failed',
                 actor_id: null, actor: null, subject: 'dev.local', subject_id: null, detail: 'Wrong password' }],
        next: { since: '2026-11-25T03:12:44.120Z' },
      },
    },
  },
  {
    id: 'whoami', group: 'Meta', method: 'GET', path: '/me', scope: null,
    summary: 'This key',
    description: 'Which organisation the key belongs to and the scopes it holds — the first call to make, to check a key works.',
    response: { status: 200, example: { data: { key: 'SAP S/4HANA — finance sync', organisation: 'template', scopes: ['requests:read', 'requests:write'] } } },
  },
];

export const API_ERRORS = [
  { status: 400, meaning: 'The request could not be read — malformed JSON, or a parameter of the wrong shape.' },
  { status: 401, meaning: 'No key, an unknown key, or a revoked one.' },
  { status: 403, meaning: "The key lacks the scope, or the employee named may not do that (not the step's approver, say)." },
  { status: 404, meaning: 'No such request, form, step or report in this organisation.' },
  { status: 409, meaning: 'The request is not in a state for that — the step is already decided, the draft already submitted.' },
  { status: 422, meaning: 'The answers do not satisfy the form: a required field is missing, or a field does not exist.' },
  { status: 500, meaning: 'Something went wrong here. It is logged in the audit centre.' },
];

/** The OpenAPI 3.1 document, built from the catalogue above. */
export function openApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of ENDPOINTS) {
    const p = (paths[e.path] ??= {});
    p[e.method.toLowerCase()] = {
      operationId: e.id,
      summary: e.summary,
      description: e.description + (e.scope ? `\n\nNeeds the \`${e.scope}\` scope.` : ''),
      tags: [e.group],
      security: [{ bearer: [] }],
      parameters: (e.params ?? []).map((x) => ({
        name: x.name, in: x.in, required: x.in === 'path' ? true : !!x.required, description: x.description,
        schema: { type: 'string' }, ...(x.example ? { example: x.example } : {}),
      })),
      ...(e.body ? {
        requestBody: { required: true, description: e.body.description, content: { 'application/json': { schema: { type: 'object' }, example: e.body.example } } },
      } : {}),
      responses: {
        [String(e.response.status)]: { description: 'OK', content: { 'application/json': { schema: { type: 'object' }, example: e.response.example } } },
        ...Object.fromEntries(API_ERRORS.filter((x) => x.status !== 400 || e.method !== 'GET').map((x) => [String(x.status), {
          description: x.meaning,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        }])),
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Approval Management System API',
      version: '1.0.0',
      description: 'Raise and follow requests, decide approvals and pull reports from another system — an ERP, Tableau. Authenticate with an API key issued under Administration → Integrations: `Authorization: Bearer ams_…`.',
    },
    servers: [{ url: serverUrl.replace(/\/$/, '') + '/api/v1' }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'An API key: ams_<prefix>_<secret>' } },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'object', properties: { status: { type: 'integer' }, message: { type: 'string' }, details: {} } } },
        },
      },
    },
    tags: ['Requests', 'Approvals', 'Forms', 'Reports', 'Campaigns', 'Audit', 'Meta'].map((name) => ({ name })),
    paths,
    'x-webhooks': {
      events: WEBHOOK_EVENTS.map((e) => e.key),
      signature: 'X-AMS-Signature: sha256=HMAC_SHA256(secret, X-AMS-Timestamp + "." + body)',
    },
  };
}
