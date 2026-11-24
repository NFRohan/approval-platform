// =====================================================================
// What each email says, and how it looks.
//
// A template per kind of notification, in plain words with {{fields}}
// filled in when it is sent. An organisation can rewrite any of them or
// switch one off (email_templates); what is here is the wording used
// until it does. Pure, so the template editor previews exactly what the
// server sends.
// =====================================================================

export type EmailVars = {
  recipient_name?: string;
  title?: string;
  message?: string;
  ref?: string;
  form?: string;
  requester?: string;
  priority?: string;
  link?: string;
  report?: string;
  org?: string;
};

export const PLACEHOLDERS: { key: keyof EmailVars; label: string }[] = [
  { key: "recipient_name", label: "Who it is to" },
  { key: "title", label: "The notification's headline" },
  { key: "message", label: "The notification's detail" },
  { key: "ref", label: "Reference number" },
  { key: "form", label: "Form name" },
  { key: "requester", label: "Who raised it" },
  { key: "priority", label: "Priority" },
  { key: "link", label: "Link to open it" },
  { key: "report", label: "Report name (reports only)" },
  { key: "org", label: "Organisation" },
];

export type EmailTemplateDef = { kind: string; label: string; group: string; subject: string; body: string; action: string };

const T = (kind: string, group: string, label: string, subject: string, body: string, action = "Open the request"): EmailTemplateDef =>
  ({ kind, group, label, subject, body, action });

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplateDef[] = [
  T("approval.turn", "Approvals", "It is your turn to approve",
    "Approval needed: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\n{{requester}} has raised {{form}} ({{ref}}), and it now needs your approval.\n\n{{message}}", "Review and decide"),
  T("approval.review", "Approvals", "You are asked to review",
    "Review requested: {{ref}}",
    "Dear {{recipient_name}},\n\nYour review is requested on {{form}} ({{ref}}) before it is decided.\n\n{{message}}", "Review it"),
  T("approval.returned", "Approvals", "A request was returned to you",
    "Returned to you: {{ref}}",
    "Dear {{recipient_name}},\n\n{{form}} ({{ref}}) has been returned to you for another look.\n\n{{message}}"),
  T("approval.due_soon", "Approvals", "An approval is due soon",
    "Due soon: {{ref}}",
    "Dear {{recipient_name}},\n\nA reminder that {{form}} ({{ref}}) is waiting on you. {{message}}", "Review and decide"),
  T("approval.reminder", "Approvals", "A reminder at the step's interval",
    "Reminder: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\n{{form}} ({{ref}}) is still waiting on you. {{message}}", "Review and decide"),
  T("approval.overdue", "Approvals", "An approval is overdue",
    "Overdue: {{ref}}",
    "Dear {{recipient_name}},\n\n{{form}} ({{ref}}) has passed its deadline and is still waiting on you.\n\n{{message}}", "Review and decide"),
  T("approval.escalated", "Approvals", "An approval was escalated to you",
    "Escalated to you: {{ref}}",
    "Dear {{recipient_name}},\n\n{{message}}\n\nThe request is {{form}} ({{ref}}), raised by {{requester}}. As their line manager you may want to follow it up."),
  T("submission.raised", "Requests", "A request was raised on a form you watch",
    "New request: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\n{{requester}} has raised {{form}} ({{ref}}).\n\n{{message}}"),
  T("request.completed", "Requests", "Your request was approved",
    "Approved: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\nYour request {{form}} ({{ref}}) has been approved by everybody it needed. The approval record is attached.\n\n{{message}}"),
  T("request.rejected", "Requests", "Your request was rejected",
    "Rejected: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\nYour request {{form}} ({{ref}}) was not approved.\n\n{{message}}"),
  T("request.clarification", "Requests", "Your request needs clarification",
    "Clarification needed: {{ref}}",
    "Dear {{recipient_name}},\n\nAn approver needs more from you on {{form}} ({{ref}}) before they can decide.\n\n{{message}}", "Answer"),
  T("request.recalled", "Requests", "A request was taken back",
    "Taken back: {{ref}}",
    "Dear {{recipient_name}},\n\n{{requester}} has taken {{form}} ({{ref}}) back to change it. Nothing is waiting on you for now.\n\n{{message}}"),
  T("request.cancelled", "Requests", "A request was cancelled",
    "Cancelled: {{ref}}",
    "Dear {{recipient_name}},\n\n{{requester}} has cancelled {{form}} ({{ref}}). Nothing is waiting on you.\n\n{{message}}"),
  T("request.followup", "Requests", "A follow-up is ready",
    "Ready for you: {{form}}",
    "Dear {{recipient_name}},\n\n{{message}}\n\nIt is a draft with your earlier answers filled in; check it and send it when you are ready.", "Open the draft"),
  T("phase.lane_cleared", "Requests", "Another department has cleared",
    "{{title}} — {{ref}}",
    "Dear {{recipient_name}},\n\n{{title}} on {{form}} ({{ref}}).\n\n{{message}}"),
  T("question.asked", "Questions and notes", "A question for you",
    "Question on {{ref}}",
    "Dear {{recipient_name}},\n\nYou have been asked a question on {{form}} ({{ref}}):\n\n{{message}}", "Answer"),
  T("question.answered", "Questions and notes", "Your question was answered",
    "Answered: {{ref}}",
    "Dear {{recipient_name}},\n\nYour question on {{form}} ({{ref}}) has been answered:\n\n{{message}}"),
  T("note.added", "Questions and notes", "A note was added",
    "New note on {{ref}}",
    "Dear {{recipient_name}},\n\nA note was added to {{form}} ({{ref}}):\n\n{{message}}"),
  T("cc.added", "Copied", "You were copied on a request",
    "Copied: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\nYou have been copied on {{form}} ({{ref}}), raised by {{requester}}. You will hear when it is decided.\n\n{{message}}"),
  T("cc.raised", "Copied", "A request you are copied on was raised",
    "Raised: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\n{{requester}} has raised {{form}} ({{ref}}) and copied you on it.\n\n{{message}}"),
  T("cc.completed", "Copied", "A request you are copied on was approved",
    "Approved: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\n{{form}} ({{ref}}), which you are copied on, has been approved.\n\n{{message}}"),
  T("cc.rejected", "Copied", "A request you are copied on was rejected",
    "Rejected: {{form}} {{ref}}",
    "Dear {{recipient_name}},\n\n{{form}} ({{ref}}), which you are copied on, was not approved.\n\n{{message}}"),
  T("handover.received", "Approvals", "You took over from a leaver",
    "You have taken over from a colleague",
    "Dear {{recipient_name}},\n\n{{message}}", "See your approvals"),
  T("campaign.created", "Campaigns", "A campaign is approved and tracked",
    "Approved and tracked: {{title}}",
    "Dear {{recipient_name}},\n\n{{message}}", "Open the campaign"),
  T("campaign.budget", "Campaigns", "A campaign is near or over its budget",
    "{{title}}",
    "Dear {{recipient_name}},\n\n{{message}}", "Open the campaign"),
  T("campaign.extended", "Campaigns", "A campaign extension is approved",
    "Extension approved",
    "Dear {{recipient_name}},\n\n{{title}}. {{message}}", "Open the campaign"),
  T("report.sent", "Reports", "A report was sent to you",
    "Report: {{report}}",
    "Dear {{recipient_name}},\n\nThe {{report}} report is attached, as of now.", "Open it in the portal"),
  T("report.scheduled", "Reports", "A scheduled report",
    "{{report}} — scheduled report",
    "Dear {{recipient_name}},\n\nYour scheduled {{report}} report is attached.", "Open it in the portal"),
];

export function defaultTemplate(kind: string): EmailTemplateDef {
  return DEFAULT_EMAIL_TEMPLATES.find((t) => t.kind === kind)
    ?? T(kind, "Other", kind, "{{title}}", "Dear {{recipient_name}},\n\n{{title}}\n\n{{message}}");
}

/** Fill {{fields}}. An unknown or empty one becomes nothing, and the blank lines it leaves are tidied. */
export function fill(text: string, vars: EmailVars): string {
  return text
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => String((vars as Record<string, unknown>)[k] ?? ""))
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!));

export type RenderedEmail = { subject: string; text: string; html: string };

/**
 * The email itself. Tables and inline styles, because that is what mail
 * clients render; one column, readable on a phone.
 */
export function renderEmail(
  tpl: { subject: string; body: string; action: string },
  vars: EmailVars,
  opts: { details?: [string, string][]; attachments?: string[] } = {},
): RenderedEmail {
  const subject = fill(tpl.subject, vars).replace(/\s+/g, " ");
  const body = fill(tpl.body, vars);
  const link = vars.link;
  const details = (opts.details ?? []).filter(([, v]) => v);

  const text = [
    body,
    details.length ? "\n" + details.map(([k, v]) => `${k}: ${v}`).join("\n") : "",
    link ? `\n${tpl.action}: ${link}` : "",
    opts.attachments?.length ? `\nAttached: ${opts.attachments.join(", ")}` : "",
    `\n—\n${vars.org ?? "Admin Services Portal"} · Approval Management`,
  ].join("\n").trim();

  const paragraphs = body.split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#27272A">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const table = details.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:6px 0 18px;border:1px solid #E4E4E7;border-radius:8px;border-collapse:separate">${
        details.map(([k, v], i) => `<tr><td style="padding:9px 14px;font-size:12px;color:#71717A;width:38%;${i ? "border-top:1px solid #F4F4F5;" : ""}">${esc(k)}</td><td style="padding:9px 14px;font-size:13px;color:#18181B;font-weight:600;${i ? "border-top:1px solid #F4F4F5;" : ""}">${esc(v)}</td></tr>`).join("")
      }</table>`
    : "";
  const button = link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 8px"><tr><td style="border-radius:8px;background:#4F46E5"><a href="${esc(link)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px">${esc(tpl.action)}</a></td></tr></table>`
    : "";
  const attached = opts.attachments?.length
    ? `<p style="margin:14px 0 0;font-size:12px;color:#52525B">&#128206; Attached: ${opts.attachments.map(esc).join(", ")}</p>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F4F5;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${esc(body.split("\n").find((l) => l.trim() && !/^dear /i.test(l)) ?? subject)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F4F5"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px">
<tr><td style="padding:0 4px 14px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:28px;height:28px;background:#4F46E5;border-radius:7px;text-align:center;vertical-align:middle;color:#fff;font-size:16px;font-weight:700">&#10003;</td>
<td style="padding-left:10px;font-size:14px;font-weight:650;color:#18181B">${esc(vars.org ?? "Admin Services Portal")}</td></tr></table></td></tr>
<tr><td style="background:#FFFFFF;border:1px solid #E4E4E7;border-radius:12px;padding:26px 26px 22px">
<h1 style="margin:0 0 16px;font-size:18px;line-height:1.35;color:#18181B">${esc(subject)}</h1>
${paragraphs}${table}${button}${attached}
</td></tr>
<tr><td style="padding:14px 6px;font-size:11.5px;line-height:1.5;color:#A1A1AA">Sent by the Approval Management System. You are receiving this because of your part in the request above.</td></tr>
</table></td></tr></table></body></html>`;

  return { subject, text, html };
}

/** Plausible values, for previewing a template before anything has happened. */
export const SAMPLE_VARS: EmailVars = {
  recipient_name: "Sam Lindqvist",
  title: "Your approval is needed",
  message: "Travel & Expense Reimbursement from Tom Bexley is waiting on you.",
  ref: "AMS-2026-00042",
  form: "Travel & Expense Reimbursement",
  requester: "Tom Bexley",
  priority: "High",
  link: "https://portal.example.com/status/00000000",
  report: "Approver performance",
  org: "Admin Services Portal",
};
