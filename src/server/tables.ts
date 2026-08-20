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
  approval_requests: T(
    ['id', 'submission_id', 'approver_user_id', 'step_index', 'status', 
      'comment', 'acted_at', 'deadline_at', 'reassigned_from', 
      'created_at'],
    ['submission_id', 'approver_user_id', 'step_index', 'status', 
      'comment', 'acted_at', 'deadline_at', 'reassigned_from'],
    [],
  ),
  approval_rules: T(
    ['id', 'form_template_id', 'approver_user_id', 'deadline_days', 
      'is_auto_added', 'label', 'step_index'],
    ['form_template_id', 'approver_user_id', 'deadline_days', 
      'is_auto_added', 'label', 'step_index'],
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
  employees: T(
    ['id', 'employee_id', 'name', 'designation', 'department', 
      'line_manager_id', 'gate_pass_card_number'],
    ['employee_id', 'name', 'designation', 'department', 
      'line_manager_id', 'gate_pass_card_number'],
    [],
  ),
  form_fields: T(
    ['id', 'form_template_id', 'field_type', 'field_name', 
      'field_config', 'order_index', 'is_required'],
    ['form_template_id', 'field_type', 'field_name', 'field_config', 
      'order_index', 'is_required'],
    ['field_config'],
  ),
  form_submissions: T(
    ['id', 'form_template_id', 'submitted_by', 'status', 'submitted_at'],
    ['form_template_id', 'submitted_by', 'status', 'submitted_at'],
    [],
  ),
  form_templates: T(
    ['id', 'name', 'category', 'created_by', 'status', 'created_at'],
    ['name', 'category', 'created_by', 'status'],
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
  reserve_stock:       ['p_item_id', 'p_venue_id', 'p_qty'],
  release_reservation: ['p_item_id', 'p_venue_id', 'p_qty'],
  transfer_stock:      ['p_item_id', 'p_from_venue', 'p_to_venue', 'p_qty'],
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
