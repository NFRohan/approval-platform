// =====================================================================
// Mail to ticket: the settings, the log, and a way to try it.
//
// Which partner domains' mail becomes a ticket, for whom, on which form;
// every message received and what was done with it; and "simulate an
// email", which runs exactly what the webhook runs. Needs
// notifications.manage (or org.manage to change the settings).
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { withContext, resolveContext } from '@/server/db';
import { receiveMail, type InboundOutcome } from '@/server/inbound';
import { kickMailer } from '@/server/mailer';

export type InboundEntry = {
  id: string; from_address: string; subject: string | null; outcome: 'ticket' | 'note' | 'rejected';
  reason: string | null; submission_id: string | null; reference: string | null; attachments: string[]; received_at: string;
};
export type InboundOverview = {
  domains: string[]; poc: string | null; form: string | null; slug: string;
  forms: string[]; people: { id: string; name: string; designation: string | null }[];
  entries: InboundEntry[];
};

export const inboundOverview = createServerFn({ method: 'GET' })
  .handler(async (): Promise<{ ok: true; overview: InboundOverview } | { ok: false; error: string }> => {
    try {
      const ctx = await resolveContext();
      const overview = await withContext(ctx, async (c) => {
        const { rows: [t] } = await c.query(
          'select slug, inbound_domains, inbound_poc, inbound_form from public.tenants where id = app.current_tenant()');
        const forms = await c.query(`select name from public.form_templates where status = 'published' order by name`);
        const people = await c.query(`select employee_id as id, name, designation from public.employees where active order by name`);
        const log = await c.query(
          `select m.id, m.from_address, m.subject, m.outcome, m.reason, m.submission_id, s.ref_number as reference,
                  m.attachments, m.received_at
             from public.inbound_mail m left join public.form_submissions s on s.id = m.submission_id
            order by m.received_at desc limit 100`);
        return {
          domains: t.inbound_domains ?? [], poc: t.inbound_poc, form: t.inbound_form, slug: t.slug,
          forms: forms.rows.map((r) => r.name), people: people.rows,
          entries: log.rows.map((r) => ({ ...r, received_at: new Date(r.received_at).toISOString() })) as InboundEntry[],
        };
      });
      return { ok: true, overview };
    } catch (err) {
      console.error('[inbound]', err instanceof Error ? err.message : err);
      return { ok: false, error: 'The inbound mail settings could not be read.' };
    }
  });

export const saveInboundSettings = createServerFn({ method: 'POST' })
  .inputValidator((input: { domains: string[]; poc: string | null; form: string | null }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    try {
      const ctx = await resolveContext();
      await withContext(ctx, (c) => c.query('select public.set_inbound_settings($1, $2, $3)',
        [(data.domains ?? []).slice(0, 50), data.poc || null, data.form || null]));
      return { ok: true };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ok: false, error: e?.code === 'P0001' && e.message ? e.message : 'The settings could not be saved.' };
    }
  });

/** Exactly what the webhook does, for a message typed in here. */
export const simulateInbound = createServerFn({ method: 'POST' })
  .inputValidator((input: FormData) => {
    if (!(input instanceof FormData)) throw new Error('expected a form');
    return input;
  })
  .handler(async ({ data }): Promise<{ ok: true; result: InboundOutcome } | { ok: false; error: string }> => {
    const from = String(data.get('from') ?? '').trim();
    const subject = String(data.get('subject') ?? '').trim();
    const text = String(data.get('body') ?? '');
    const file = data.get('file');
    if (!from.includes('@')) return { ok: false, error: 'Who is it from? An email address.' };
    try {
      const ctx = await resolveContext();
      const result = await withContext(ctx, async (c) => {
        const { rows: [m] } = await c.query(
          `select app.has_permission('notifications.manage') or app.has_permission('org.manage') as ok`);
        if (!m.ok) throw Object.assign(new Error('You need the notifications.manage permission to simulate mail.'), { code: 'P0001' });
        const attachments = file instanceof File && file.size > 0 && file.size <= 10 * 1024 * 1024
          ? [{ filename: file.name, contentType: file.type || 'application/octet-stream', content: Buffer.from(await file.arrayBuffer()) }]
          : [];
        return receiveMail(c, { from, subject, text, attachments });
      });
      await kickMailer(ctx.tenantId);
      return { ok: true, result };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'P0001' && e.message) return { ok: false, error: e.message };
      console.error('[inbound]', e?.message ?? err);
      return { ok: false, error: 'That message could not be taken in.' };
    }
  });
