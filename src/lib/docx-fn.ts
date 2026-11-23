// =====================================================================
// Filling a form from a Word document.
//
// The document is read on the server (src/server/docx.ts) and matched
// against the form's own questions; nothing is filled in until the
// person has seen what was found. One business case fills the form on
// screen; several become a draft each, linked together, for the
// requester to check and send.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { withContext, resolveContext } from '@/server/db';
import { extract, type FormField } from '@/server/docx';
import type { Extraction } from '@/lib/docx-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 10 * 1024 * 1024;

export const extractFromWord = createServerFn({ method: 'POST' })
  .inputValidator((input: FormData) => {
    if (!(input instanceof FormData)) throw new Error('expected a form upload');
    return input;
  })
  .handler(async ({ data }): Promise<{ ok: true; extraction: Extraction; fileName: string } | { ok: false; error: string }> => {
    const templateId = String(data.get('templateId') ?? '');
    const file = data.get('file');
    if (!UUID.test(templateId)) return { ok: false, error: 'Which form is this for?' };
    if (!(file instanceof File)) return { ok: false, error: 'No file arrived.' };
    if (file.size > MAX_BYTES) return { ok: false, error: 'That document is over 10 MB.' };
    if (!/\.docx$/i.test(file.name)) return { ok: false, error: 'Choose a Word document (.docx). Older .doc files need saving as .docx first.' };
    try {
      const ctx = await resolveContext();
      const fields = await withContext(ctx, async (c) => (await c.query(
        `select id, field_name as label, field_type as kind, field_config -> 'options' as options
           from public.form_fields where form_template_id = $1 order by order_index`, [templateId])).rows as FormField[]);
      if (!fields.length) return { ok: false, error: 'That form has no questions to fill.' };
      const extraction = extract(new Uint8Array(await file.arrayBuffer()), fields);
      return { ok: true, extraction, fileName: file.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/zip|Word document|invalid/i.test(message)) return { ok: false, error: 'That file could not be read as a Word document.' };
      console.error('[docx]', message);
      return { ok: false, error: 'The document could not be read.' };
    }
  });

/**
 * One draft per business case, each with the answers common to the
 * whole NFA and its own, linked to one another as one NFA's cases.
 */
export const draftsFromCases = createServerFn({ method: 'POST' })
  .inputValidator((input: { templateId: string; cases: { title: string; values: Record<string, string> }[] }) => {
    if (!UUID.test(String(input?.templateId ?? ''))) throw new Error('not a form');
    if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 20) throw new Error('between 1 and 20 cases');
    return input;
  })
  .handler(async ({ data }): Promise<{ ok: true; drafts: { id: string; ref: string | null; title: string }[] } | { ok: false; error: string }> => {
    try {
      const ctx = await resolveContext();
      const drafts = await withContext(ctx, async (c) => {
        const { rows: known } = await c.query('select field_name from public.form_fields where form_template_id = $1', [data.templateId]);
        const allowed = new Set(known.map((r) => r.field_name as string));
        const out: { id: string; ref: string | null; title: string }[] = [];
        for (const cs of data.cases) {
          const { rows: [s] } = await c.query(
            `insert into public.form_submissions (form_template_id, submitted_by, status)
             values ($1, app.current_employee(), 'draft') returning id, ref_number`, [data.templateId]);
          const entries = Object.entries(cs.values ?? {}).filter(([k, v]) => allowed.has(k) && typeof v === 'string' && v.length <= 8000);
          for (const [k, v] of entries) {
            await c.query('insert into public.submission_values (submission_id, field_name, value) values ($1, $2, $3)', [s.id, k, v]);
          }
          out.push({ id: s.id, ref: s.ref_number, title: String(cs.title ?? '').slice(0, 120) });
        }
        // The cases of one NFA, linked so each shows the others.
        for (let i = 1; i < out.length; i++) {
          await c.query(
            `insert into public.submission_links (from_id, to_id, note, created_by) values ($1, $2, $3, app.current_employee())`,
            [out[i].id, out[0].id, 'Business cases from the same NFA']);
        }
        return out;
      });
      return { ok: true, drafts };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'P0001' && e.message) return { ok: false, error: e.message };
      console.error('[docx]', e?.message ?? err);
      return { ok: false, error: 'The drafts could not be made.' };
    }
  });
