// =====================================================================
// The whitelist.
//
// The data endpoint takes a table name, a column list, filters and an
// ordering from the browser. Every one of those becomes a SQL
// identifier, so none may be passed through untrusted: they are matched
// against this map and rejected otherwise. Values are always bound as
// parameters, never interpolated.
//
// tenant_id appears in no writable list and no readable one. It is set
// by the column default and policed by row-level security; a client can
// neither choose it nor read it back.
//
// tenants, app_users and staff_audit are absent entirely. Those belong
// to the staff console, which is not this application.
//
// GENERATED from the live schema, then committed. Regenerate when the
// schema changes rather than editing by hand.
// =====================================================================

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type TableDef = {
  readable: readonly string[];
  writable: readonly string[];
  json: readonly string[];
};

const T = (
  readable: readonly string[],
  writable: readonly string[],
  json: readonly string[] = [],
): TableDef => ({ readable, writable, json });

export const TABLES: Record<string, TableDef> = {
  activity_log: T(
    ['id', 'actor_id', 'action', 'entity_type', 'entity_id', 'detail',
      'created_at'],
    ['actor_id', 'action', 'entity_type', 'entity_id', 'detail'],
    [],
  ),
  // Read freely, written only through the chain engine. Approving is
  // several writes that must all happen or none — mark the step, open
  // the next one, move the subject's status — so the client asks for the
  // action and the database performs it. Nothing here is writable.
  approval_requests: T(
    ['id', 'submission_id', 'notice_id', 'stationery_request_id',
      'maintenance_request_id', 'subject_id', 'subject_type',
      'approver_user_id', 'step_index', 'status', 'comment', 'acted_at',
      'deadline_at', 'reassigned_from', 'created_at',
      // Stage 1: a phase (step_index) runs lanes in parallel, each a
      // sequence of lane_step.
      'lane', 'lane_step', 'lane_label', 'quorum', 'stage_label',
      'require_signature', 'signature', 'signed_at'],
    [],
    [],
  ),
  approval_rules: T(
    ['id', 'subject_type', 'form_template_id', 'approver_user_id',
      'deadline_days', 'is_auto_added', 'label', 'step_index',
      'quorum', 'condition', 'stage_label', 'lane', 'position',
      'require_signature', 'flag'],
    ['subject_type', 'form_template_id', 'approver_user_id',
      'deadline_days', 'is_auto_added', 'label', 'step_index',
      'quorum', 'condition', 'stage_label', 'lane', 'position',
      'require_signature', 'flag'],
    ['condition'],
  ),
  // Read only: the engine writes the trail, and nothing else may.
  approval_events: T(
    ['id', 'request_id', 'subject_type', 'subject_id', 'actor_id', 'action',
      'comment', 'target_id', 'created_at'],
    [],
    [],
  ),
  // Read only: asked and answered through ask_question / answer_question,
  // which check that both people are on the request.
  approval_queries: T(
    ['id', 'subject_type', 'subject_id', 'asked_by', 'asked_to', 'question',
      'answer', 'answered_at', 'created_at'],
    [],
    [],
  ),
  // Stage 2. All read only here: written through add_note, set_cc,
  // link_submissions and the attachment functions, which check who is
  // acting.
  submission_links: T(
    ['id', 'from_id', 'to_id', 'note', 'created_by', 'created_at'],
    [],
    [],
  ),
  submission_cc: T(
    ['id', 'submission_id', 'employee_id', 'added_by', 'created_at'],
    [],
    [],
  ),
  ticket_notes: T(
    ['id', 'submission_id', 'author_id', 'body', 'created_at'],
    [],
    [],
  ),
  attachment_access: T(
    ['id', 'attachment_id', 'actor_id', 'accessed_at'],
    [],
    [],
  ),
  departments: T(
    ['id', 'name', 'head_employee_id', 'hrbp_employee_id', 'cxo_employee_id', 'created_at'],
    ['name', 'head_employee_id', 'hrbp_employee_id', 'cxo_employee_id'],
    [],
  ),
  approval_slabs: T(
    ['id', 'form_template_id', 'min_amount', 'max_amount',
      'approver_user_id', 'order_index'],
    ['form_template_id', 'min_amount', 'max_amount', 'approver_user_id',
      'order_index'],
    [],
  ),
  delegation_rules: T(
    ['id', 'delegator_id', 'delegate_id', 'start_date', 'end_date',
      'reason', 'form_template_ids', 'created_at'],
    ['delegator_id', 'delegate_id', 'start_date', 'end_date', 'reason',
      'form_template_ids'],
    [],
  ),
  // Stage 3: roles and who holds them are read here and written only
  // through the administration functions (src/lib/admin-fn.ts), which
  // check permission and maker-checker in the database.
  roles: T(
    ['id', 'name', 'description', 'permissions', 'status', 'pending_name',
      'pending_permissions', 'created_by', 'changed_by', 'approved_by',
      'created_at', 'updated_at'],
    [],
    [],
  ),
  employee_roles: T(
    ['employee_id', 'role_id', 'assigned_by', 'created_at'],
    [],
    [],
  ),
  employees: T(
    ['id', 'employee_id', 'name', 'designation', 'department',
      'line_manager_id', 'gate_pass_card_number', 'active', 'left_on', 'email'],
    ['employee_id', 'name', 'designation', 'department',
      'line_manager_id', 'gate_pass_card_number'],
    [],
  ),
  // EXCEPTION to the generation rule above: 'id' is writable here.
  // The builder mints a field's uuid with crypto.randomUUID() the moment
  // it lands on the canvas, and every later edit, reorder and delete
  // keys off that value. Letting the database choose instead would mean
  // the client never learns the real id and every subsequent write
  // targets a row that does not exist. The value is a v4 uuid, tenant_id
  // still comes from the column default, and row-level security still
  // decides where it may land — the client picks the key, not the tenant.
  // Keep this when regenerating.
  form_fields: T(
    ['id', 'form_template_id', 'field_type', 'field_name',
      'field_config', 'order_index', 'is_required'],
    ['id', 'form_template_id', 'field_type', 'field_name', 'field_config',
      'order_index', 'is_required'],
    ['field_config'],
  ),
  form_submissions: T(
    ['id', 'form_template_id', 'submitted_by', 'status', 'submitted_at',
      'parent_submission_id', 'ref_number', 'priority', 'flag'],
    // The reference is assigned by the database and the flag by the
    // chain; priority is the requester's to set.
    ['form_template_id', 'submitted_by', 'status', 'submitted_at', 'priority'],
    [],
  ),
  form_templates: T(
    ['id', 'name', 'category', 'created_by', 'status', 'created_at',
      'followup_template_id', 'audience_departments'],
    ['name', 'category', 'created_by', 'status', 'followup_template_id',
      'audience_departments'],
    [],
  ),
  item_stock: T(
    ['id', 'item_id', 'venue_id', 'quantity', 'reserved_quantity'],
    ['item_id', 'venue_id', 'quantity', 'reserved_quantity'],
    [],
  ),
  items: T(
    ['id', 'name', 'type'],
    ['name', 'type'],
    [],
  ),
  maintenance_items: T(
    ['id', 'name', 'category'],
    ['name', 'category'],
    [],
  ),
  maintenance_request_items: T(
    ['id', 'request_id', 'item_id', 'description', 'quantity'],
    ['request_id', 'item_id', 'description', 'quantity'],
    [],
  ),
  maintenance_requests: T(
    ['id', 'ref_number', 'requester_id', 'location', 'status',
      'assigned_to', 'admin_comment', 'created_at', 'updated_at'],
    ['ref_number', 'requester_id', 'location', 'status', 'assigned_to',
      'admin_comment'],
    [],
  ),
  movement_orders: T(
    ['id', 'ref_number', 'requester_id', 'item_name', 'item_type',
      'quantity', 'source_location', 'destination_location',
      'justification', 'preferred_time', 'assigned_mover_id', 'status',
      'admin_comment', 'item_id', 'source_venue_id',
      'destination_venue_id', 'created_at', 'updated_at'],
    ['ref_number', 'requester_id', 'item_name', 'item_type', 'quantity',
      'source_location', 'destination_location', 'justification',
      'preferred_time', 'assigned_mover_id', 'status', 'admin_comment',
      'item_id', 'source_venue_id', 'destination_venue_id'],
    [],
  ),
  notice_comments: T(
    ['id', 'notice_id', 'author_id', 'text', 'created_at'],
    ['notice_id', 'author_id', 'text'],
    [],
  ),
  notices: T(
    ['id', 'title', 'content', 'category', 'status', 'created_by',
      'current_approver_id', 'created_at', 'updated_at'],
    ['title', 'content', 'category', 'status', 'created_by',
      'current_approver_id'],
    [],
  ),
  notification_rules: T(
    ['id', 'form_template_id', 'notifyee_user_id', 'is_auto_added',
      'label'],
    ['form_template_id', 'notifyee_user_id', 'is_auto_added', 'label'],
    [],
  ),
  notifications: T(
    ['id', 'recipient_id', 'kind', 'title', 'body', 'entity_type',
      'entity_id', 'read_at', 'created_at'],
    ['recipient_id', 'kind', 'title', 'body', 'entity_type', 'entity_id',
      'read_at'],
    [],
  ),
  stationery_requests: T(
    ['id', 'kind', 'requester_id', 'name', 'designation', 'department',
      'division', 'email', 'contact_number', 'reason', 'comments',
      'status', 'current_approver_id', 'created_at', 'updated_at'],
    ['kind', 'requester_id', 'name', 'designation', 'department',
      'division', 'email', 'contact_number', 'reason', 'comments',
      'status', 'current_approver_id'],
    [],
  ),
  submission_values: T(
    ['id', 'submission_id', 'field_name', 'value'],
    ['submission_id', 'field_name', 'value'],
    [],
  ),
  venues: T(
    ['id', 'name', 'floor'],
    ['name', 'floor'],
    [],
  ),
};

// Database functions the browser may call, and the arguments each takes.
// Anything not named here is refused, so `rpc` cannot reach the
// provisioning functions.
export const RPCS: Record<string, readonly string[]> = {
  // The approval chain. Every transition goes through these rather than
  // through table writes, because each one is several statements that
  // have to agree, and because whose turn it is must be decided
  // somewhere the browser cannot skip.
  //
  // No amount: how far a claim climbs is read from the submission's own
  // money answer inside the function. It used to be a parameter here,
  // which let a caller route a 620,000 claim as 50.
  build_approval_chain: ['p_subject_type', 'p_subject_id', 'p_form_template_id'],
  // p_actor names who is acting, and the database refuses anybody who is
  // neither the step's approver nor a current, in-scope delegate of theirs.
  // p_signature is required by a step that asks for one.
  act_on_approval:      ['p_request_id', 'p_action', 'p_comment', 'p_actor', 'p_signature'],
  reassign_approval:    ['p_request_id', 'p_to', 'p_comment', 'p_actor'],
  add_reviewer:         ['p_request_id', 'p_employee', 'p_deadline_days', 'p_actor'],
  // No scheduler in a demo, so the approvals screen asks for this on
  // load. In a real deployment it would be a timer.
  remind_overdue:       [],
  // Stage 1. Each checks who is acting; see db/005_chain.sql.
  return_to_approver:   ['p_request_id', 'p_target_id', 'p_comment', 'p_actor'],
  recall_submission:    ['p_submission_id', 'p_actor'],
  cancel_submission:    ['p_submission_id', 'p_comment', 'p_actor'],
  ask_question:         ['p_subject_id', 'p_to', 'p_question', 'p_actor'],
  answer_question:      ['p_query_id', 'p_answer', 'p_actor'],
  // Read only: the planner the chain is built from, given the answers on
  // screen, so the review step shows exactly what will happen.
  preview_approval_chain: ['p_form_template_id', 'p_requester', 'p_answers'],
  // Stage 2.
  add_note:             ['p_submission_id', 'p_body', 'p_actor'],
  set_cc:               ['p_submission_id', 'p_people', 'p_actor'],
  link_submissions:     ['p_submission_id', 'p_other', 'p_note', 'p_actor'],
  unlink_submissions:   ['p_submission_id', 'p_other_id', 'p_actor'],
  copy_submission:      ['p_submission_id', 'p_actor'],
  hand_over:            ['p_leaver', 'p_successor', 'p_actor'],
  // Stage 3: a workflow's task settings — deadlines and signatures — for
  // somebody with forms.settings, who may not otherwise touch the design.
  update_rule_settings: ['p_rule', 'p_deadline_days', 'p_require_signature'],

  reserve_stock:       ['p_item_id', 'p_venue_id', 'p_qty'],
  release_reservation: ['p_item_id', 'p_venue_id', 'p_qty'],
  transfer_stock:      ['p_item_id', 'p_from_venue', 'p_to_venue', 'p_qty'],
  // Release, transfer and status in one transaction — see the note in
  // db/004_stock.sql for why these cannot be three calls.
  approve_movement_order: ['p_order_id', 'p_item_id', 'p_from_venue',
                           'p_to_venue', 'p_qty', 'p_mover', 'p_comment'],
};

export const OPERATORS: Record<string, string> = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'like', ilike: 'ilike',
};

export function resolveTable(name: string): TableDef & { name: string } {
  const def = TABLES[name];
  if (!def) throw new HttpError(400, `unknown table: ${name}`);
  return { name, ...def };
}

export function resolveColumn(table: TableDef & { name: string }, col: string): string {
  if (!table.readable.includes(col)) {
    throw new HttpError(400, `unknown column ${col} on ${table.name}`);
  }
  return col;
}

export function resolveWritable(table: TableDef & { name: string }, col: string): string {
  if (!table.writable.includes(col)) {
    throw new HttpError(400, `column ${col} is not writable on ${table.name}`);
  }
  return col;
}
