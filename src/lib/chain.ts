// =====================================================================
// Talking to the approval chain.
//
// Four kinds of thing get approved and they used to be approved three
// different ways: form submissions created every step at once, notices
// and stationery walked a hardcoded array in the frontend that named
// employees who no longer exist, and maintenance had no chain at all.
//
// There is one engine now and it lives in the database, because
// advancing a chain is several writes that must all happen or none, and
// because whose turn it is cannot be a client's opinion. This file is
// the thin part: it finds the step a subject is waiting on and asks.
// =====================================================================

import { db } from '@/lib/db';

export type SubjectType =
  | 'form_submission'
  | 'notice'
  | 'stationery_request'
  | 'maintenance_request';

export type ChainAction = 'approve' | 'reject' | 'clarification' | 'resume';

/** Each subject has its own column on approval_requests. */
const COLUMN: Record<SubjectType, string> = {
  form_submission: 'submission_id',
  notice: 'notice_id',
  stationery_request: 'stationery_request_id',
  maintenance_request: 'maintenance_request_id',
};

export type Step = {
  id: string;
  approver_user_id: string | null;
  step_index: number | null;
  status: string | null;
};

/**
 * The step a subject is waiting on, or null when nothing is open.
 *
 * Only ever one: everything above the live step is `waiting`, which is
 * the invariant the whole chain rests on.
 */
export async function openStep(type: SubjectType, subjectId: string): Promise<Step | null> {
  const { data } = await db
    .from('approval_requests')
    .select('id, approver_user_id, step_index, status')
    .eq(COLUMN[type], subjectId)
    .in('status', ['pending', 'clarification'])
    .order('step_index')
    .maybeSingle();
  return (data as Step) ?? null;
}

/** Every step of a subject's chain, in order — the timeline. */
export async function chainOf(type: SubjectType, subjectId: string): Promise<Step[]> {
  const { data } = await db
    .from('approval_requests')
    .select('id, approver_user_id, step_index, status, comment, acted_at, deadline_at, reassigned_from')
    .eq(COLUMN[type], subjectId)
    .order('step_index');
  return (data ?? []) as Step[];
}

/** Start a chain. Returns the number of steps it created. */
export async function startChain(
  type: SubjectType,
  subjectId: string,
  formTemplateId: string | null = null,
  amount = 0,
) {
  return db.rpc('build_approval_chain', {
    p_subject_type: type,
    p_subject_id: subjectId,
    p_form_template_id: formTemplateId,
    p_amount: amount,
  });
}

/**
 * Act on whatever step the subject is waiting on.
 *
 * The screens for notices, stationery and maintenance work on the
 * subject rather than the step — there is one button on the thing
 * itself — so the step is looked up here rather than passed in.
 */
export async function actOnSubject(
  type: SubjectType,
  subjectId: string,
  action: ChainAction,
  comment?: string,
): Promise<{ error: { message: string } | null }> {
  const step = await openStep(type, subjectId);
  if (!step) {
    return { error: { message: 'there is no approval step open on this' } };
  }
  return db.rpc('act_on_approval', {
    p_request_id: step.id,
    p_action: action,
    p_comment: comment?.trim() || null,
  });
}

// ---------------------------------------------------------------------
// What is this step attached to?
//
// A step hangs off one of four things and each names itself differently
// — a notice has a title, a maintenance request a reference number, a
// submission the name of its template. Any screen showing a queue needs
// the same answer, so it is worked out once here rather than per screen.
// ---------------------------------------------------------------------
export type SubjectRow = {
  subject_id: string | null;
  subject_type: string | null;
  submission_id: string | null;
};

export type SubjectInfo = { label: string; requester?: string };

export async function labelSubjects(rows: SubjectRow[]): Promise<Record<string, SubjectInfo>> {
  const out: Record<string, SubjectInfo> = {};
  const idsOf = (t: string) =>
    Array.from(new Set(
      rows.filter((r) => r.subject_type === t).map((r) => r.subject_id).filter(Boolean) as string[]));

  const submissionIds = idsOf('form_submission');
  if (submissionIds.length) {
    const { data: subs } = await db
      .from('form_submissions')
      .select('id, form_template_id, submitted_by')
      .in('id', submissionIds);
    const templateIds = Array.from(new Set(
      (subs ?? []).map((s) => s.form_template_id).filter(Boolean) as string[]));
    const names: Record<string, string> = {};
    if (templateIds.length) {
      const { data: forms } = await db
        .from('form_templates').select('id, name').in('id', templateIds);
      (forms ?? []).forEach((f) => { names[f.id] = f.name; });
    }
    (subs ?? []).forEach((s) => {
      out[s.id] = {
        label: s.form_template_id ? (names[s.form_template_id] ?? 'Submission') : 'Submission',
        requester: s.submitted_by ?? undefined,
      };
    });
  }

  const noticeIds = idsOf('notice');
  if (noticeIds.length) {
    const { data } = await db.from('notices').select('id, title, created_by').in('id', noticeIds);
    (data ?? []).forEach((n) => {
      out[n.id] = { label: n.title ?? 'Notice', requester: n.created_by ?? undefined };
    });
  }

  const stationeryIds = idsOf('stationery_request');
  if (stationeryIds.length) {
    const { data } = await db
      .from('stationery_requests').select('id, kind, name, requester_id').in('id', stationeryIds);
    (data ?? []).forEach((r) => {
      const kind = r.kind === 'business_card' ? 'Business card'
        : r.kind === 'stamp_seal' ? 'Stamp and seal' : String(r.kind ?? 'Stationery');
      out[r.id] = {
        label: r.name ? `${kind} — ${r.name}` : kind,
        requester: r.requester_id ?? undefined,
      };
    });
  }

  const maintenanceIds = idsOf('maintenance_request');
  if (maintenanceIds.length) {
    const { data } = await db
      .from('maintenance_requests').select('id, ref_number, location, requester_id').in('id', maintenanceIds);
    (data ?? []).forEach((m) => {
      out[m.id] = {
        label: [m.ref_number, m.location].filter(Boolean).join(' — ') || 'Maintenance',
        requester: m.requester_id ?? undefined,
      };
    });
  }

  return out;
}
