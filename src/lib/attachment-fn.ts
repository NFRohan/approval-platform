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
// should offer. Here there is no delete at all: you can list a
// submission's documents, attach one, describe and tag one, and find
// documents by tag.
//
// Attaching again does not replace. Supporting documents get revised
// after submission — the scope of work's "further claim adjustment" — and
// the earlier version is evidence too, so a new file becomes the next
// version of that question's document and the old one is kept, marked
// superseded. Before a request is routed that is just editing a draft;
// after, it is a supplemental, and the trail says so.
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
  description: string | null;
  tags: string[];
  version: number;
  /** Set when a later version replaced it; null for the current one. */
  superseded_at: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `id, field_name, file_name, content_type, size_bytes, uploaded_by,
                 created_at::text as created_at, description, tags, version,
                 superseded_at::text as superseded_at`;

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

/** Tags as typed: comma separated, trimmed, lower case, unique, short. */
export function cleanTags(raw: string | string[] | null | undefined): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return Array.from(new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean)))
    .map((t) => t.slice(0, 40))
    .slice(0, 12);
}

function cleanDescription(raw: unknown): string | null {
  const d = String(raw ?? '').trim();
  return d ? d.slice(0, 500) : null;
}

/** Every version of every document on a submission, newest version first within each question. */
export const listAttachments = createServerFn({ method: 'GET' })
  .inputValidator((input: { submissionId: string }) => {
    if (!UUID.test(String(input?.submissionId ?? ''))) throw new HttpError(400, 'not a submission id');
    return input;
  })
  .handler(async ({ data }): Promise<AttachmentInfo[]> => {
    const ctx = await resolveContext();
    return withContext(ctx, async (client) => {
      const { rows } = await client.query(
        `select ${COLUMNS}
           from public.attachments
          where submission_id = $1
          order by field_name, version desc`,
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
    const claimedBy = String(data.get('uploadedBy') ?? '').trim() || null;
    const description = cleanDescription(data.get('description'));
    const tags = cleanTags(String(data.get('tags') ?? ''));
    const file = data.get('file');

    if (!UUID.test(submissionId)) return { ok: false, error: 'That is not a submission.' };
    if (!fieldName) return { ok: false, error: 'Which question is this file for?' };
    if (!(file instanceof File)) return { ok: false, error: 'No file arrived.' };
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `${file.name} is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.` };
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const ctx = await resolveContext();
    // Who uploaded it is the session's to say; the form's claim is used
    // only where there is no employee in the session at all.
    const uploadedBy = ctx.employeeId ?? claimedBy;

    return withContext(ctx, async (client) => {
      const { rows: subs } = await client.query(
        `select s.status, s.submitted_by,
                exists (select 1 from public.approval_requests ar
                         where ar.submission_id = s.id) as routed
           from public.form_submissions s
          where s.id = $1`,
        [submissionId],
      );
      const sub = subs[0];
      if (!sub) return { ok: false as const, error: 'That submission does not exist.' };
      if (sub.status === 'cancelled') {
        return { ok: false as const, error: 'A cancelled request takes no more documents.' };
      }
      // A supplemental is somebody on the request adding to it — the
      // requester with a revised claim, an approver with what they
      // checked against. Nobody off it.
      if (sub.routed) {
        const { rows: inv } = await client.query('select app.involved_in($1, $2) as ok', [submissionId, uploadedBy]);
        if (!inv[0]?.ok) {
          return { ok: false as const, error: 'Only somebody on this request can add a document to it.' };
        }
      }

      // The current version of this question's document, if there is
      // one, is superseded — never deleted.
      const { rows: prev } = await client.query(
        `update public.attachments set superseded_at = now()
          where submission_id = $1 and field_name = $2 and superseded_at is null
          returning version`,
        [submissionId, fieldName],
      );
      const { rows: top } = await client.query(
        'select coalesce(max(version), 0) as v from public.attachments where submission_id = $1 and field_name = $2',
        [submissionId, fieldName],
      );
      const version = Number(top[0]?.v ?? 0) + 1;

      const { rows } = await client.query(
        `insert into public.attachments
           (submission_id, field_name, file_name, content_type, size_bytes, data, uploaded_by,
            description, tags, version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning ${COLUMNS}`,
        [submissionId, fieldName, cleanName(file.name), cleanType(file.type),
         bytes.length, bytes, uploadedBy, description, tags, version],
      );

      if (sub.routed) {
        await client.query(
          `select app.log_event(null, 'form_submission', $1, $2, $3, $4, null)`,
          [submissionId, uploadedBy, prev.length ? 'document_revised' : 'document_added',
           `${fieldName}: ${cleanName(file.name)} (version ${version})`],
        );
      }
      return { ok: true as const, attachment: rows[0] as AttachmentInfo };
    });
  });

/** Describe and tag a document already attached. */
export const describeAttachment = createServerFn({ method: 'POST' })
  .inputValidator((input: { attachmentId: string; description: string; tags: string; actor: string }) => {
    if (!UUID.test(String(input?.attachmentId ?? ''))) throw new HttpError(400, 'not an attachment id');
    return input;
  })
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const ctx = await resolveContext();
    return withContext(ctx, async (client) => {
      const { rows } = await client.query(
        `select a.submission_id, app.involved_in(a.submission_id, app.acting($2)) as ok
           from public.attachments a where a.id = $1`,
        [data.attachmentId, data.actor],
      );
      if (!rows[0]) return { ok: false as const, error: 'No such document.' };
      if (!rows[0].ok) return { ok: false as const, error: 'Only somebody on this request can describe its documents.' };
      await client.query(
        'update public.attachments set description = $2, tags = $3 where id = $1',
        [data.attachmentId, cleanDescription(data.description), cleanTags(data.tags)],
      );
      return { ok: true as const };
    });
  });

export type TaggedDocument = {
  submission_id: string;
  ref_number: string | null;
  file_name: string;
  field_name: string;
  tags: string[];
  description: string | null;
};

/**
 * Documents by tag or by words in their description or name. "Same
 * vendor/person may appear in different ABC cases ... tagging enables
 * quick retrieval of all related records."
 */
export const searchDocuments = createServerFn({ method: 'GET' })
  .inputValidator((input: { query: string }) => ({ query: String(input?.query ?? '').trim().slice(0, 80) }))
  .handler(async ({ data }): Promise<TaggedDocument[]> => {
    if (data.query.length < 2) return [];
    const term = data.query.toLowerCase();
    const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const ctx = await resolveContext();
    return withContext(ctx, async (client) => {
      const { rows } = await client.query(
        `select a.submission_id, s.ref_number, a.file_name, a.field_name, a.tags, a.description
           from public.attachments a
           join public.form_submissions s on s.id = a.submission_id
          where a.superseded_at is null
            and ($1 = any (a.tags) or lower(a.file_name) like $2 or lower(coalesce(a.description, '')) like $2
                 or exists (select 1 from unnest(a.tags) t where t like $2))
          order by a.created_at desc
          limit 8`,
        [term, like],
      );
      return rows as TaggedDocument[];
    });
  });
