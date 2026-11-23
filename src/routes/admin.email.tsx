import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Inbox, Paperclip, RefreshCw, RotateCcw, Send } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  getEmail, listEmailTemplates, listOutbox, resetEmailTemplate, retryEmail, saveEmailTemplate,
  type OutboxEntry, type TemplateEntry,
} from "@/lib/email-fn";
import { DEFAULT_EMAIL_TEMPLATES, PLACEHOLDERS, SAMPLE_VARS, renderEmail } from "@/lib/email-templates";
import { Button, Field, NoPermission, Notice, Page, Pill, fmtWhen, inputStyle } from "@/components/admin/kit";
import { control } from "@/components/reports/ReportParts";
import { InboundTab } from "@/components/admin/InboundTab";

export const Route = createFileRoute("/admin/email")({
  head: () => ({ meta: [{ title: "Email · Admin Services Portal" }] }),
  component: EmailPage,
});

const STATUS: Record<string, { tone: "green" | "brand" | "red" | "amber" | "zinc"; word: string }> = {
  sent: { tone: "green", word: "Sent" },
  captured: { tone: "brand", word: "Captured" },
  failed: { tone: "red", word: "Failed" },
  queued: { tone: "amber", word: "Queued" },
  sending: { tone: "amber", word: "Sending" },
  skipped: { tone: "zinc", word: "Skipped" },
};
const kindLabel = (k: string) => DEFAULT_EMAIL_TEMPLATES.find((t) => t.kind === k)?.label ?? k;

function EmailPage() {
  const { can } = useCurrentUser();
  const allowed = can("notifications.manage") || can("audit.view");
  if (!allowed) return <Page title="Email"><NoPermission need="notifications.manage or audit.view" /></Page>;
  return (
    <div className="mx-auto" style={{ maxWidth: 1280, padding: "28px 28px 56px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }}>Email</h1>
      <p style={{ marginTop: 6, fontSize: 14, color: "#71717A", marginBottom: 18 }}>
        Every notification is also an email. Here is each one that was written, what it said and what became of it, the wording each kind uses —
        and the mail that comes in, from partners and as replies to tickets.
      </p>
      <Tabs defaultValue="log">
        <TabsList>
          <TabsTrigger value="log">Delivery log</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="inbound">Inbound</TabsTrigger>
        </TabsList>
        <TabsContent value="log"><Log /></TabsContent>
        <TabsContent value="templates"><Templates canEdit={can("notifications.manage")} /></TabsContent>
        <TabsContent value="inbound"><InboundTab canManage={can("notifications.manage") || can("org.manage")} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Log() {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<"smtp" | "capture">("capture");
  const [canManage, setCanManage] = useState(false);
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await listOutbox({ data: { status: status || undefined, kind: kind || undefined, search: search || undefined } });
    if (!r.ok) return void toast.error(r.error);
    setEntries(r.entries); setCounts(r.counts); setMode(r.mode); setCanManage(r.canManage);
    setSelected((s) => s ?? r.entries[0]?.id ?? null);
  }, [status, kind, search]);
  useEffect(() => { void load(); }, [load]);

  const deliver = async (id: string | null) => {
    setBusy(true);
    const r = await retryEmail({ data: { id } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${r.sent} sent, ${r.captured} captured${r.failed ? `, ${r.failed} failed` : ""}`);
    await load();
  };

  return (
    <div style={{ marginTop: 14 }}>
      {mode === "capture" ? (
        <Notice tone="zinc">
          <strong>No mail server is connected.</strong> Every email is written in full and kept here, marked captured, exactly as it would be sent —
          attachments and all. Set <code>SMTP_URL</code> to deliver them.
        </Notice>
      ) : (
        <Notice tone="green">Delivering through the configured mail server.</Notice>
      )}

      <div className="flex items-center gap-2 flex-wrap mb-3">
        {(["sent", "captured", "queued", "failed", "skipped"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(status === s ? "" : s)} data-testid={`count-${s}`}
            className="rounded-lg text-left" style={{ padding: "8px 12px", minWidth: 96, border: `1px solid ${status === s ? "#C7D2FE" : "#E4E4E7"}`, background: status === s ? "#EEF2FF" : "#fff", cursor: "pointer" }}>
            <div style={{ fontSize: 11.5, color: "#71717A" }}>{STATUS[s].word}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#18181B", fontVariantNumeric: "tabular-nums" }}>{counts[s] ?? 0}</div>
          </button>
        ))}
        <span style={{ fontSize: 11.5, color: "#A1A1AA" }}>last 30 days</span>
        <div className="flex items-center gap-2" style={{ marginLeft: "auto" }}>
          <select aria-label="Kind" style={control} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Every kind</option>
            {DEFAULT_EMAIL_TEMPLATES.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}
          </select>
          <input aria-label="Search emails" placeholder="Person, address, subject" style={{ ...control, width: 200 }} value={search} onChange={(e) => setSearch(e.target.value)} />
          <Button small onClick={() => void load()}><RefreshCw size={12} /> Refresh</Button>
          {canManage && <Button small busy={busy} onClick={() => void deliver(null)}><Send size={12} /> Deliver queued</Button>}
        </div>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.05fr)" }}>
        <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", maxHeight: 720, overflowY: "auto" }} data-testid="email-log">
          {entries.map((e) => {
            const s = STATUS[e.status] ?? STATUS.queued;
            const on = e.id === selected;
            return (
              <button key={e.id} type="button" onClick={() => setSelected(e.id)}
                className="w-full text-left" data-email-kind={e.kind}
                style={{ display: "block", padding: "10px 14px", border: "none", borderBottom: "1px solid #F4F4F5", background: on ? "#F5F5FF" : "#fff", cursor: "pointer", borderLeft: `3px solid ${on ? "#4F46E5" : "transparent"}` }}>
                <div className="flex items-center gap-2">
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#18181B", flex: 1, minWidth: 0 }} className="truncate">
                    {e.subject ?? e.title ?? kindLabel(e.kind)}
                  </span>
                  {e.attachment_names.length > 0 && <Paperclip size={12} style={{ color: "#71717A" }} />}
                  <Pill tone={s.tone}>{s.word}</Pill>
                </div>
                <div className="flex items-center gap-2" style={{ fontSize: 11.5, color: "#71717A", marginTop: 3 }}>
                  <span className="truncate" style={{ flex: 1, minWidth: 0 }}>To {e.recipient ?? e.recipient_id ?? "—"} {e.to_address ? `<${e.to_address}>` : ""}</span>
                  <span>{fmtWhen(e.created_at)}</span>
                </div>
              </button>
            );
          })}
          {entries.length === 0 && (
            <div className="flex flex-col items-center" style={{ padding: "48px 20px", color: "#A1A1AA", fontSize: 13 }}>
              <Inbox size={22} style={{ marginBottom: 8 }} /> No emails match.
            </div>
          )}
        </div>
        <Preview id={selected} entry={entries.find((e) => e.id === selected) ?? null} canManage={canManage} onRetry={(id) => void deliver(id)} />
      </div>
    </div>
  );
}

function Preview({ id, entry, canManage, onRetry }: { id: string | null; entry: OutboxEntry | null; canManage: boolean; onRetry: (id: string) => void }) {
  const [mail, setMail] = useState<{ subject: string; html: string; attachments: string[]; to: string | null } | null>(null);
  useEffect(() => {
    setMail(null);
    if (!id) return;
    void getEmail({ data: { id } }).then((r) => (r.ok ? setMail(r) : toast.error(r.error)));
  }, [id, entry?.status]);

  if (!entry) return <div className="rounded-xl" style={{ border: "1px dashed #E4E4E7", padding: 40, textAlign: "center", color: "#A1A1AA", fontSize: 13 }}>Choose an email to read it.</div>;
  return (
    <div className="rounded-xl bg-white flex flex-col" style={{ border: "1px solid #E4E4E7", overflow: "hidden" }} data-testid="email-preview">
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #F4F4F5", fontSize: 12.5 }}>
        <div className="grid" style={{ gridTemplateColumns: "84px 1fr", rowGap: 4 }}>
          <span style={{ color: "#A1A1AA" }}>To</span><span>{entry.recipient ?? "—"} {mail?.to ? <span style={{ color: "#71717A" }}>&lt;{mail.to}&gt;</span> : null}</span>
          <span style={{ color: "#A1A1AA" }}>Subject</span><span style={{ fontWeight: 600 }}>{mail?.subject ?? entry.subject ?? "…"}</span>
          <span style={{ color: "#A1A1AA" }}>Kind</span><span>{kindLabel(entry.kind)}</span>
          <span style={{ color: "#A1A1AA" }}>Written</span><span>{fmtWhen(entry.created_at)}{entry.sent_at ? ` · delivered ${fmtWhen(entry.sent_at)}` : ""}{entry.attempts > 1 ? ` · ${entry.attempts} attempts` : ""}</span>
          {entry.attachment_names.length > 0 && (<><span style={{ color: "#A1A1AA" }}>Attached</span><span className="flex flex-wrap gap-1.5">{entry.attachment_names.map((a) => <Pill key={a}><Paperclip size={10} style={{ marginRight: 4 }} />{a}</Pill>)}</span></>)}
        </div>
        {entry.error && <div style={{ marginTop: 8, color: entry.status === "skipped" ? "#71717A" : "#B91C1C" }}>{entry.error}</div>}
        {canManage && entry.status === "failed" && (
          <div style={{ marginTop: 8 }}><Button small onClick={() => onRetry(entry.id)}><RotateCcw size={12} /> Try again</Button></div>
        )}
        {entry.status === "queued" && <div style={{ marginTop: 8, fontSize: 12, color: "#B45309" }}>Not delivered yet — shown as it will be sent.</div>}
      </div>
      {mail ? (
        <iframe title="Email preview" sandbox="" srcDoc={mail.html} style={{ width: "100%", height: 560, border: "none", background: "#F4F4F5" }} />
      ) : <div style={{ padding: 40, color: "#A1A1AA", fontSize: 13 }}>Loading…</div>}
    </div>
  );
}

function Templates({ canEdit }: { canEdit: boolean }) {
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [kind, setKind] = useState<string>("approval.turn");
  const load = useCallback(async () => {
    const r = await listEmailTemplates();
    if (r.ok) setTemplates(r.templates); else toast.error(r.error);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    const m = new Map<string, TemplateEntry[]>();
    for (const t of templates) m.set(t.group, [...(m.get(t.group) ?? []), t]);
    return [...m.entries()];
  }, [templates]);
  const t = templates.find((x) => x.kind === kind);

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "280px minmax(0, 1fr)", marginTop: 14 }}>
      <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: 8, alignSelf: "start" }} data-testid="template-list">
        {groups.map(([g, ts]) => (
          <div key={g} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#A1A1AA", textTransform: "uppercase", letterSpacing: "0.05em", padding: "8px 8px 4px" }}>{g}</div>
            {ts.map((x) => (
              <button key={x.kind} type="button" onClick={() => setKind(x.kind)}
                className="w-full text-left flex items-center gap-2 rounded-md"
                style={{ padding: "6px 8px", border: "none", background: x.kind === kind ? "#EEF2FF" : "transparent", cursor: "pointer", fontSize: 12.5, color: x.enabled ? "#18181B" : "#A1A1AA" }}>
                <span style={{ flex: 1 }}>{x.label}</span>
                {(x.subject || x.body) && <Pill tone="brand">custom</Pill>}
                {!x.enabled && <Pill>off</Pill>}
              </button>
            ))}
          </div>
        ))}
      </div>
      {t ? <TemplateEditor key={t.kind + (t.updatedAt ?? "")} t={t} canEdit={canEdit} onSaved={load} /> : <div />}
    </div>
  );
}

function TemplateEditor({ t, canEdit, onSaved }: { t: TemplateEntry; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [subject, setSubject] = useState(t.subject ?? t.defaultSubject);
  const [body, setBody] = useState(t.body ?? t.defaultBody);
  const [enabled, setEnabled] = useState(t.enabled);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => renderEmail({ subject, body, action: t.action }, SAMPLE_VARS, {
    details: [["Reference", SAMPLE_VARS.ref!], ["Form", SAMPLE_VARS.form!], ["Raised by", SAMPLE_VARS.requester!]],
    attachments: t.kind === "request.completed" ? ["AMS-2026-00042.pdf"] : t.kind.startsWith("report.") ? ["approver-performance.xlsx"] : [],
  }), [subject, body, t]);

  const save = async () => {
    setBusy(true);
    const same = subject === t.defaultSubject && body === t.defaultBody;
    const r = await saveEmailTemplate({ data: { kind: t.kind, subject: same ? null : subject, body: same ? null : body, enabled } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Template saved");
    await onSaved();
  };

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
      <div className="rounded-xl bg-white flex flex-col gap-3.5" style={{ border: "1px solid #E4E4E7", padding: 18 }} data-testid="template-editor">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#18181B" }}>{t.label}</div>
            <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>
              <code>{t.kind}</code> · {t.sent30} in the last 30 days
              {t.updatedBy && ` · changed by ${t.updatedBy} ${fmtWhen(t.updatedAt)}`}
            </div>
          </div>
          <label className="inline-flex items-center gap-2" style={{ fontSize: 12.5, color: "#52525B" }}>
            <Switch checked={enabled} disabled={!canEdit} onCheckedChange={setEnabled} aria-label="Send this kind of email" />
            {enabled ? "Sent" : "Not sent"}
          </label>
        </div>
        <Field label="Subject"><input name="template-subject" style={inputStyle} disabled={!canEdit} value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Message">
          <textarea name="template-body" rows={9} disabled={!canEdit} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div>
          <div style={{ fontSize: 11.5, color: "#71717A", marginBottom: 6 }}>Fill-ins — click to add one to the message</div>
          <div className="flex flex-wrap gap-1.5">
            {PLACEHOLDERS.map((p) => (
              <button key={p.key} type="button" disabled={!canEdit} title={p.label} onClick={() => setBody((b) => `${b}{{${p.key}}}`)}
                className="rounded-full" style={{ padding: "2px 9px", fontSize: 11.5, border: "1px solid #E4E4E7", background: "#FAFAFA", cursor: canEdit ? "pointer" : "default", fontFamily: "JetBrains Mono, monospace", color: "#3F3F46" }}>
                {`{{${p.key}}}`}
              </button>
            ))}
          </div>
        </div>
        {canEdit ? (
          <div className="flex gap-2">
            <Button tone="brand" busy={busy} onClick={() => void save()} name="save-template">Save</Button>
            {(t.subject || t.body || !t.enabled) && (
              <Button onClick={async () => {
                const r = await resetEmailTemplate({ data: { kind: t.kind } });
                if (!r.ok) return void toast.error(r.error);
                toast.success("Back to the built-in wording");
                await onSaved();
              }}><RotateCcw size={13} /> Built-in wording</Button>
            )}
          </div>
        ) : <Notice tone="zinc">Changing templates needs the notifications.manage permission.</Notice>}
      </div>
      <div className="rounded-xl overflow-hidden" style={{ border: "1px solid #E4E4E7", background: "#F4F4F5" }}>
        <div style={{ padding: "8px 14px", fontSize: 11.5, color: "#71717A", borderBottom: "1px solid #E4E4E7", background: "#fff" }}>
          Preview, with example details · <strong style={{ color: "#18181B" }}>{preview.subject}</strong>
        </div>
        <iframe title="Template preview" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: 600, border: "none" }} data-testid="template-preview" />
      </div>
    </div>
  );
}
