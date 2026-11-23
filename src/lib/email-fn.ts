// =====================================================================
// The email log and the email templates.
//
// "Notification logs and monitoring" and "email and system templates".
// The log is the outbox: every email queued, what it said, what it
// carried and what became of it. Reading it needs notifications.manage
// or audit.view (row-level security; anybody sees their own), retrying
// needs notifications.manage, and so does rewording a template.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import type pg from 'pg';
import { withContext, resolveContext, getPool } from '@/server/db';
import { buildEmail, drainOutbox, mailMode } from '@/server/mailer';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-templates';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function refusal(err: unknown): { ok: false; error: string } {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'P0001' && e.message) return { ok: false, error: e.message };
  console.error('[email]', e?.message || err);
  return { ok: false, error: 'That did not work. Try again.' };
}

async function run<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withContext(await resolveContext(), fn);
}

export type OutboxEntry = {
  id: string; kind: string; recipient_id: string | null; recipient: string | null; to_address: string | null;
  subject: string | null; status: string; attempts: number; error: string | null; attachment_names: string[];
  created_at: string; sent_at: string | null; title: string | null;
};

export const listOutbox = createServerFn({ method: 'POST' })
  .inputValidator((input: { status?: string; kind?: string; search?: string }) => input ?? {})
  .handler(async ({ data }): Promise<Result<{ entries: OutboxEntry[]; counts: Record<string, number>; mode: 'smtp' | 'capture'; canManage: boolean }>> => {
    try {
      return await run(async (c) => {
        const like = data.search ? '%' + String(data.search).toLowerCase().slice(0, 80).replace(/[\\%_]/g, (x) => '\\' + x) + '%' : null;
        const { rows } = await c.query(
          `select o.id, o.kind, o.recipient_id, e.name as recipient, o.to_address, o.subject, o.status, o.attempts,
                  o.error, o.attachment_names, o.created_at, o.sent_at, o.context->>'title' as title
             from public.email_outbox o
             left join public.employees e on e.employee_id = o.recipient_id and e.tenant_id = o.tenant_id
            where ($1::text is null or o.status = $1) and ($2::text is null or o.kind = $2)
              and ($3::text is null or lower(coalesce(o.subject, o.context->>'title', '') || ' ' || coalesce(o.to_address, '') || ' ' || coalesce(e.name, '')) like $3)
            order by o.created_at desc limit 300`,
          [data.status || null, data.kind || null, like]);
        const { rows: counts } = await c.query(
          `select status, count(*)::int n from public.email_outbox where created_at >= now() - interval '30 days' group by status`);
        const { rows: [m] } = await c.query(`select app.has_permission('notifications.manage') as ok`);
        return {
          ok: true as const,
          entries: rows.map((r) => ({
            ...r,
            created_at: new Date(r.created_at).toISOString(),
            sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
          })) as OutboxEntry[],
          counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
          mode: mailMode(),
          canManage: m.ok === true,
        };
      });
    } catch (err) {
      return refusal(err);
    }
  });

/** One email as its recipient sees it. Rendered now if it has not been sent yet. */
export const getEmail = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result<{ subject: string; html: string; text: string; attachments: string[]; to: string | null }>> => {
    try {
      return await run(async (c) => {
        const { rows: [o] } = await c.query(
          `select id, tenant_id, kind, recipient_id, to_address, context, entity_type, entity_id, report_id, attempts,
                  subject, body_html, body_text, attachment_names
             from public.email_outbox where id = $1`, [data.id]);
        if (!o) return { ok: false as const, error: 'No such email.' };
        if (o.body_html) {
          return { ok: true as const, subject: o.subject, html: o.body_html, text: o.body_text ?? '', attachments: o.attachment_names, to: o.to_address };
        }
        const built = await buildEmail(c, o, { attach: false });
        return { ok: true as const, subject: built.subject, html: built.html, text: built.text, attachments: [], to: o.to_address };
      });
    } catch (err) {
      return refusal(err);
    }
  });

export const retryEmail = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string | null }) => input)
  .handler(async ({ data }): Promise<Result<{ sent: number; captured: number; failed: number }>> => {
    try {
      const ctx = await resolveContext();
      await withContext(ctx, async (c) => {
        const { rows: [m] } = await c.query(`select app.has_permission('notifications.manage') as ok`);
        if (!m.ok) throw Object.assign(new Error('You need the notifications.manage permission for that.'), { code: 'P0001' });
        if (data.id) {
          // The outbox is not writable through row-level security; the
          // permission was checked above, the tenant is named here.
          await getPool().query(
            `update public.email_outbox set status = 'queued', error = null, attempts = 0
              where id = $1 and tenant_id = $2 and status in ('failed', 'queued')`, [data.id, ctx.tenantId]);
        }
      });
      const out = await drainOutbox({ tenantId: ctx.tenantId, limit: 25 });
      return { ok: true, ...out };
    } catch (err) {
      return refusal(err);
    }
  });

export type TemplateEntry = {
  kind: string; label: string; group: string; action: string;
  defaultSubject: string; defaultBody: string;
  subject: string | null; body: string | null; enabled: boolean; updatedBy: string | null; updatedAt: string | null;
  sent30: number;
};

export const listEmailTemplates = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{ templates: TemplateEntry[] }>> => {
    try {
      return await run(async (c) => {
        const { rows: overrides } = await c.query(
          `select t.kind, t.subject, t.body, t.enabled, e.name as updated_by, t.updated_at
             from public.email_templates t
             left join public.employees e on e.employee_id = t.updated_by and e.tenant_id = t.tenant_id`);
        const { rows: counts } = await c.query(
          `select kind, count(*)::int n from public.email_outbox where created_at >= now() - interval '30 days' group by kind`);
        const by = new Map(overrides.map((o) => [o.kind, o]));
        const n = new Map(counts.map((r) => [r.kind, r.n]));
        return {
          ok: true as const,
          templates: DEFAULT_EMAIL_TEMPLATES.map((d) => {
            const o = by.get(d.kind);
            return {
              kind: d.kind, label: d.label, group: d.group, action: d.action,
              defaultSubject: d.subject, defaultBody: d.body,
              subject: o?.subject ?? null, body: o?.body ?? null, enabled: o ? o.enabled : true,
              updatedBy: o?.updated_by ?? null, updatedAt: o?.updated_at ? new Date(o.updated_at).toISOString() : null,
              sent30: n.get(d.kind) ?? 0,
            };
          }),
        };
      });
    } catch (err) {
      return refusal(err);
    }
  });

export const saveEmailTemplate = createServerFn({ method: 'POST' })
  .inputValidator((input: { kind: string; subject: string | null; body: string | null; enabled: boolean }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.save_email_template($1, $2, $3, $4)',
        [data.kind, data.subject?.slice(0, 300) ?? null, data.body?.slice(0, 5000) ?? null, data.enabled !== false]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const resetEmailTemplate = createServerFn({ method: 'POST' })
  .inputValidator((input: { kind: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.reset_email_template($1)', [data.kind]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });
