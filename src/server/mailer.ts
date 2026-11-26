// =====================================================================
// Delivering email.
//
// The database queues an email for every notification (and every report
// sent); this renders each from the organisation's template, attaches
// what belongs with it — the approval record when a request completes,
// the report file when a report is sent — hands it to the mail server,
// and writes down what happened.
//
// With SMTP_URL set it sends through that server. Without one nothing
// leaves the building: the email is rendered in full and kept as
// "captured", so a demonstration can open and read exactly what would
// have been sent, attachments listed.
//
//   SMTP_URL    smtp://user:pass@mail.example.com:587 (smtps:// for 465)
//   MAIL_FROM   "Approvals <approvals@example.com>"
//   APP_URL     where links in emails point; defaults to the Vercel
//               production URL
//   MAIL_REDIRECT_TO  for a demonstration: deliver every email to this
//               address (or comma-separated addresses) instead of the
//               person's own. Each says at the top who it was for. The
//               demo's people have example.com addresses that reach
//               nobody; this lets one real inbox watch them all.
//
// Runs as the connecting role and names the tenant in every statement.
// =====================================================================

import nodemailer, { type Transporter } from 'nodemailer';
import type pg from 'pg';
import { getPool } from './db';
import { defaultTemplate, renderEmail, type EmailVars } from '@/lib/email-templates';
import { describeFilters, isDataset, type ReportFilters } from '@/lib/report-catalogue';
import { runReport } from './reports';
import { exportReport, fileName, CONTENT_TYPES, type ExportFormat } from './export';
import { loadRecord, recordPdf } from './record';
import { kickWebhooks } from './webhooks';
import { kickServicedesk } from './servicedesk';
import { kickPush } from './push';

export function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:3000';
}

let transport: Transporter | null | undefined;
function mailTransport(): Transporter | null {
  if (transport !== undefined) return transport;
  const url = process.env.SMTP_URL;
  if (!url) return (transport = null);
  // Timeouts ride on the URL, so a slow server cannot hold a request open.
  const u = new URL(url);
  for (const [k, v] of [['connectionTimeout', '5000'], ['greetingTimeout', '5000'], ['socketTimeout', '10000']]) {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  }
  transport = nodemailer.createTransport(u.toString());
  return transport;
}

/** For tests: forget the transport so a changed SMTP_URL is read again. */
export function resetMailTransport() { transport = undefined; }

export function mailMode(): 'smtp' | 'capture' {
  return process.env.SMTP_URL ? 'smtp' : 'capture';
}

type OutboxRow = {
  id: string; tenant_id: string; kind: string; recipient_id: string | null; to_address: string | null;
  context: Record<string, unknown>; entity_type: string | null; entity_id: string | null; report_id: string | null;
  attempts: number;
};

const PATHS: Record<string, (id: string) => string> = {
  form_submission: (id) => `/status/${id}`,
  notice: (id) => `/notices/${id}`,
  movement_order: () => '/movement-orders',
  campaign: (id) => `/campaigns/${id}`,
  report: (id) => `/reports/${id}`,
  role: () => '/admin/roles',
  app_user: () => '/admin/users',
};

export type BuiltEmail = {
  subject: string; text: string; html: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
};

/** Render one queued email, with its attachments. */
export async function buildEmail(client: pg.PoolClient, o: OutboxRow, opts: { attach?: boolean } = {}): Promise<BuiltEmail> {
  const { rows: [t] } = await client.query('select name from public.tenants where id = $1', [o.tenant_id]);
  const { rows: [who] } = await client.query(
    'select name from public.employees where tenant_id = $1 and employee_id = $2', [o.tenant_id, o.recipient_id]);
  const { rows: [override] } = await client.query(
    'select subject, body from public.email_templates where tenant_id = $1 and kind = $2', [o.tenant_id, o.kind]);
  const def = defaultTemplate(o.kind);
  const tpl = { subject: override?.subject || def.subject, body: override?.body || def.body, action: def.action };

  const vars: EmailVars = {
    recipient_name: who?.name ?? 'colleague',
    title: String(o.context?.title ?? ''),
    message: String(o.context?.body ?? ''),
    org: t?.name && !/^(template|local qa)$/i.test(t.name) ? `${t.name} · Admin Services Portal` : 'Admin Services Portal',
  };
  const details: [string, string][] = [];
  const attachments: BuiltEmail['attachments'] = [];

  if (o.entity_type === 'form_submission' && o.entity_id) {
    const { rows: [s] } = await client.query(
      `select s.ref_number, s.priority, s.status, ft.name as form, e.name as requester
         from public.form_submissions s
         join public.form_templates ft on ft.id = s.form_template_id
         left join public.employees e on e.employee_id = s.submitted_by and e.tenant_id = s.tenant_id
        where s.id = $1 and s.tenant_id = $2`, [o.entity_id, o.tenant_id]);
    if (s) {
      Object.assign(vars, { ref: s.ref_number ?? '', form: s.form, requester: s.requester ?? '', priority: s.priority });
      details.push(['Reference', s.ref_number ?? ''], ['Form', s.form], ['Raised by', s.requester ?? '']);
      if (s.priority && s.priority !== 'normal') details.push(['Priority', String(s.priority).replace(/^./, (c: string) => c.toUpperCase())]);
    }
  }
  if (o.kind === 'admin.request') vars.link = appUrl() + '/approvals';
  else if (o.kind === 'admin.alert') vars.link = appUrl() + '/admin/audit';
  else if (o.entity_type && o.entity_id && PATHS[o.entity_type]) vars.link = appUrl() + PATHS[o.entity_type](o.entity_id);
  if (!vars.link && o.kind.startsWith('approval.')) vars.link = appUrl() + '/approvals';

  // The approval record goes with the news that a request is approved.
  if (opts.attach !== false && o.kind === 'request.completed' && o.entity_type === 'form_submission' && o.entity_id) {
    const data = await loadRecord(client, o.entity_id);
    if (data && data.req.tenant_id === o.tenant_id) {
      attachments.push({
        filename: `${data.req.reference ?? 'approval-record'}.pdf`,
        content: Buffer.from(await recordPdf(data, vars.link ?? null)),
        contentType: 'application/pdf',
      });
    }
  }

  // A report, as of now.
  if (o.report_id) {
    const { rows: [r] } = await client.query(
      'select * from public.report_templates where id = $1 and tenant_id = $2', [o.report_id, o.tenant_id]);
    if (r) {
      vars.report = r.name;
      vars.link = `${appUrl()}/reports/${r.id}`;
      details.push(['Report', r.name], ['Filters', describeFilters(r.filters as ReportFilters)]);
      if (opts.attach !== false && isDataset(r.dataset)) {
        const result = await runReport(client, r.dataset, r.columns, r.filters as ReportFilters, undefined, o.tenant_id);
        const format = (r.format ?? 'xlsx') as ExportFormat;
        const at = new Date();
        attachments.push({
          filename: fileName(r.name, format, at),
          content: Buffer.from(await exportReport(result, {
            title: r.name, filters: describeFilters(r.filters as ReportFilters),
            generatedBy: o.kind === 'report.scheduled' ? `schedule (${r.schedule})` : 'on request', generatedAt: at,
          }, format)),
          contentType: CONTENT_TYPES[format],
        });
        details.push(['Rows', String(result.rows.length)]);
      }
    }
  }

  const rendered = renderEmail(tpl, vars, { details, attachments: attachments.map((a) => a.filename) });
  return { ...rendered, attachments };
}

/** Say at the top of a redirected email who it was really for. */
function redirectNotice(built: BuiltEmail, to: string) {
  const esc = (v: string) => v.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
  const note = `Demonstration delivery — this email was addressed to ${to}.`;
  built.text = `[${note}]\n\n${built.text}`;
  built.html = built.html.replace(/<body([^>]*)>/,
    `<body$1><div style="background:#FEF3C7;color:#78350F;font:12.5px Inter,Segoe UI,Arial,sans-serif;padding:8px 14px;text-align:center">${esc(note)}</div>`);
}

/**
 * Deliver what is queued, oldest first: for one tenant, or every tenant
 * when none is named. Claims rows with SKIP LOCKED, so two deliveries
 * running at once never send the same email twice.
 */
export async function drainOutbox(opts: { tenantId?: string | null; limit?: number } = {}): Promise<{ sent: number; captured: number; failed: number }> {
  const client = await getPool().connect();
  const out = { sent: 0, captured: 0, failed: 0 };
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `update public.email_outbox o set status = 'sending', attempts = attempts + 1
        where o.id in (select id from public.email_outbox
                        -- A send that died part-way is tried again after ten minutes.
                        where (status = 'queued' or (status = 'sending' and created_at < now() - interval '10 minutes'))
                          and ($1::uuid is null or tenant_id = $1)
                        order by created_at limit $2 for update skip locked)
       returning o.id, o.tenant_id, o.kind, o.recipient_id, o.to_address, o.context, o.entity_type, o.entity_id, o.report_id, o.attempts`,
      [opts.tenantId ?? null, opts.limit ?? 10]);
    await client.query('commit');

    const mail = mailTransport();
    const redirect = process.env.MAIL_REDIRECT_TO?.trim() || null;
    for (const o of rows as OutboxRow[]) {
      try {
        const built = await buildEmail(client, o);
        if (redirect && o.to_address) redirectNotice(built, o.to_address);
        let status = 'captured';
        if (mail && o.to_address) {
          await mail.sendMail({
            from: process.env.MAIL_FROM || 'Admin Services Portal <no-reply@approvals.local>',
            to: redirect ?? o.to_address, subject: built.subject, text: built.text, html: built.html,
            attachments: built.attachments,
          });
          status = 'sent';
        }
        await client.query(
          `update public.email_outbox
              set status = $2, subject = $3, body_text = $4, body_html = $5, attachment_names = $6,
                  sent_at = now(), error = null
            where id = $1`,
          [o.id, status, built.subject, built.text, built.html, built.attachments.map((a) => a.filename)]);
        if (status === 'sent') out.sent++; else out.captured++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Three tries, then it waits for somebody to retry it by hand.
        await client.query(
          `update public.email_outbox set status = case when attempts >= 3 then 'failed' else 'queued' end, error = $2 where id = $1`,
          [o.id, message.slice(0, 500)]);
        out.failed++;
      }
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('[mail] delivery failed', err instanceof Error ? err.message : err);
  } finally {
    client.release();
  }
  return out;
}

/**
 * After something that may have notified somebody: deliver what it
 * queued, if anything. Cheap when there is nothing, and never fails the
 * request it follows.
 */
export async function kickMailer(tenantId: string | null | undefined): Promise<void> {
  if (!tenantId) return;
  // Whatever told somebody may also have told another system.
  await kickWebhooks(tenantId);
  await kickServicedesk(tenantId);
  // ...and the person's phone.
  await kickPush(tenantId);
  try {
    const { rows } = await getPool().query(
      `select exists (select 1 from public.email_outbox where tenant_id = $1 and status = 'queued') as any`, [tenantId]);
    if (rows[0]?.any) await drainOutbox({ tenantId, limit: 10 });
  } catch (err) {
    console.error('[mail] kick failed', err instanceof Error ? err.message : err);
  }
}
