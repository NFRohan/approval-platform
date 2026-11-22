// =====================================================================
// Files attached to a submission.
//
// Outside src/server/ for the same reason as auth-fn.ts and data-fn.ts:
// the client imports the RPC stubs, and the framework refuses client
// imports of **/server/**. The handler bodies, and the database code they
// import, are stripped from the browser bundle.
//
// Not through the generic data endpoint, on purpose. That endpoint lets
// a caller delete from any table it lists, and an approver deleting the
// evidence a request was raised with is not an operation this system
// should offer. Here there are exactly two things you can do: list a
// submission's files without their bytes, and attach one while the
// submission is still yours to change.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { withContext, resolveContext } from '@/server/db';
import { HttpError } from '@/server/tables';

/**
 * Below what a serverless request body can carry: Vercel refuses
 * anything over 4.5 MB before the function sees it, and a refusal there
 * comes back as an opaque 413 rather than a sentence.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export type AttachmentInfo = {
  id: string;
  field_name: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A name that is safe to store and to put back in a header. */
function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const stripped = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (stripped || 'file').slice(0, 200);
}

/** A content type, or nothing at all if it is not shaped like one. */
function cleanType(type: string): string {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type) ? type.toLowerCase() : 'application/octet-stream';
}

export const listAttachments = createServerFn({ method: 'GET' })
  .inputValidator((input: { submissionId: string }) => {
    if (!UUID.test(String(input?.submissionId ?? ''))) throw new HttpError(400, 'not a submission id');
    return input;
  })
  .handler(async ({ data }): Promise<AttachmentInfo[]> => {
    const ctx = await resolveContext();
    return withContext(ctx, async (client) => {
      const { rows } = await client.query(
        `select id, field_name, file_name, content_type, size_bytes, uploaded_by,
                created_at::text as created_at
           from public.attachments
          where submission_id = $1
          order by created_at`,
        [data.submissionId],
      );
      return rows as AttachmentInfo[];
    });
  });

export const uploadAttachment = createServerFn({ method: 'POST' })
  .inputValidator((input: FormData) => {
    if (!(input instanceof FormData)) throw new HttpError(400, 'expected a form upload');
    return input;
  })
  .handler(async ({ data }): Promise<{ ok: true; attachment: AttachmentInfo } | { ok: false; error: string }> => {
    const submissionId = String(data.get('submissionId') ?? '');
    const fieldName = String(data.get('fieldName') ?? '').trim();
    const uploadedBy = String(data.get('uploadedBy') ?? '').trim() || null;
    const file = data.get('file');

    if (!UUID.test(submissionId)) return { ok: false, error: 'That is not a submission.' };
    if (!fieldName) return { ok: false, error: 'Which question is this file for?' };
    if (!(file instanceof File)) return { ok: false, error: 'No file arrived.' };
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `${file.name} is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.` };
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const ctx = await resolveContext();

    return withContext(ctx, async (client) => {
      // Policies already confine this to the caller's own tenant. What
      // they cannot express is *when*: once a submission has an approval
      // chain, the evidence it was routed on is fixed, so nobody can
      // swap the invoice an approver is looking at.
      const { rows: subs } = await client.query(
        `select s.status,
                exists (select 1 from public.approval_requests ar
                         where ar.submission_id = s.id) as routed
           from public.form_submissions s
          where s.id = $1`,
        [submissionId],
      );
      const sub = subs[0];
      if (!sub) return { ok: false as const, error: 'That submission does not exist.' };
      if (sub.routed || !['draft', 'submitted'].includes(sub.status)) {
        return { ok: false as const, error: 'Files cannot be changed once a request is with its approvers.' };
      }

      // One file per question: attaching again replaces it.
      await client.query(
        'delete from public.attachments where submission_id = $1 and field_name = $2',
        [submissionId, fieldName],
      );
      const { rows } = await client.query(
        `insert into public.attachments
           (submission_id, field_name, file_name, content_type, size_bytes, data, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, field_name, file_name, content_type, size_bytes, uploaded_by,
                   created_at::text as created_at`,
        [submissionId, fieldName, cleanName(file.name), cleanType(file.type),
         bytes.length, bytes, uploadedBy],
      );
      return { ok: true as const, attachment: rows[0] as AttachmentInfo };
    });
  });
