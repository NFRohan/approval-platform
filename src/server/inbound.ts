// =====================================================================
// Mail to ticket.
//
// A mail provider's inbound webhook (or the "simulate" button) hands us a
// message; app.receive_mail() decides what it is — a partner's request,
// which becomes a ticket for the telecom team, or a reply quoting a
// ticket's reference (a UAT result), which is added to that ticket — and
// its attachments are kept on the ticket like any other document.
//
// Two payload shapes are understood, so most providers can be pointed at
// it directly: a plain one ({from, subject, text, attachments: [{filename,
// contentType, content (base64)}]}) and Postmark's ({From, Subject,
// TextBody, Attachments: [{Name, ContentType, Content}]}).
// =====================================================================

import type pg from 'pg';

export type InboundMessage = {
  from: string;
  subject: string;
  text: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
};

const MAX_ATTACHMENT = 10 * 1024 * 1024;

export function normaliseInbound(body: Record<string, unknown>): InboundMessage | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const from = str(body.from) || str(body.From) || str((body.FromFull as { Email?: string } | undefined)?.Email);
  if (!from) return null;
  const subject = (str(body.subject) || str(body.Subject)).slice(0, 300);
  const html = str(body.html) || str(body.HtmlBody);
  const text = (str(body.text) || str(body.TextBody) || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).slice(0, 20000);
  const raw = (Array.isArray(body.attachments) ? body.attachments : Array.isArray(body.Attachments) ? body.Attachments : []) as Record<string, unknown>[];
  const attachments = raw.slice(0, 10).map((a) => ({
    filename: (str(a.filename) || str(a.Name) || 'attachment').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120),
    contentType: str(a.contentType) || str(a.ContentType) || 'application/octet-stream',
    content: Buffer.from(str(a.content) || str(a.Content), 'base64'),
  })).filter((a) => a.content.length > 0 && a.content.length <= MAX_ATTACHMENT);
  return { from: from.slice(0, 200), subject, text, attachments };
}

export type InboundOutcome = { outcome: 'ticket' | 'note' | 'rejected'; reason: string | null; submission_id: string | null; reference: string | null };

/** With the tenant already in context on this connection. */
export async function receiveMail(client: pg.PoolClient, msg: InboundMessage): Promise<InboundOutcome> {
  const { rows: [r] } = await client.query('select app.receive_mail($1, $2, $3, $4) as r',
    [msg.from, msg.subject, msg.text, msg.attachments.map((a) => a.filename)]);
  const out = r.r as InboundOutcome;
  if (out.submission_id && msg.attachments.length) {
    for (const a of msg.attachments) {
      const { rows: [v] } = await client.query(
        `select coalesce(max(version), 0) + 1 as v from public.attachments where submission_id = $1 and field_name = 'Email attachment'`,
        [out.submission_id]);
      await client.query(
        `insert into public.attachments (tenant_id, submission_id, field_name, file_name, content_type, size_bytes, data, description, tags, version)
         values (app.current_tenant(), $1, 'Email attachment', $2, $3, $4, $5, $6, array['email'], $7)`,
        [out.submission_id, a.filename, a.contentType, a.content.length, a.content, `From ${msg.from}: ${msg.subject}`.slice(0, 300), v.v]);
    }
  }
  return out;
}
