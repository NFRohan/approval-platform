// Mail to ticket, on the email screen: which partners' mail becomes a
// ticket and for whom, where the provider should post it, a way to send
// a message in by hand, and every message received.

import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Inbox, Paperclip, Send } from "lucide-react";
import { inboundOverview, saveInboundSettings, simulateInbound, type InboundOverview } from "@/lib/inbound-fn";
import { Button, Card, Field, Notice, Pill, fmtWhen, inputStyle } from "@/components/admin/kit";

const OUTCOME = {
  ticket: { tone: "green" as const, word: "Ticket raised" },
  note: { tone: "brand" as const, word: "Added to ticket" },
  rejected: { tone: "zinc" as const, word: "Not taken in" },
};

export function InboundTab({ canManage }: { canManage: boolean }) {
  const [o, setO] = useState<InboundOverview | null>(null);
  const [domains, setDomains] = useState("");
  const [poc, setPoc] = useState("");
  const [form, setForm] = useState("");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await inboundOverview();
    if (!r.ok) return void toast.error(r.error);
    setO(r.overview);
    setDomains(r.overview.domains.join(", "));
    setPoc(r.overview.poc ?? "");
    setForm(r.overview.form ?? "");
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!o) return <div style={{ padding: 20, color: "#A1A1AA", fontSize: 13 }}>Loading…</div>;
  const lastTicket = o.entries.find((e) => e.outcome === "ticket" && e.reference);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div style={{ marginTop: 14 }}>
      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
        <Card title="Partners' mail" style={{ marginBottom: 0 }}>
          <p style={{ fontSize: 13, color: "#52525B", margin: "0 0 12px" }}>
            Mail from these domains becomes a ticket for the telecom team to check. A reply that quotes a ticket's
            reference — a UAT result, say — is added to that ticket instead.
          </p>
          <div className="flex flex-col gap-3">
            <Field label="Partner domains" hint="Separated by commas"><input name="inbound-domains" style={inputStyle} disabled={!canManage} value={domains} onChange={(e) => setDomains(e.target.value)} /></Field>
            <Field label="Tickets are raised for">
              <select style={inputStyle} disabled={!canManage} value={poc} onChange={(e) => setPoc(e.target.value)}>
                <option value="">Nobody — partner mail is refused</option>
                {o.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designation ? ` — ${p.designation}` : ""}</option>)}
              </select>
            </Field>
            <Field label="On the form">
              <select style={inputStyle} disabled={!canManage} value={form} onChange={(e) => setForm(e.target.value)}>
                {o.forms.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            {canManage && <div><Button tone="brand" busy={busy} onClick={async () => {
              setBusy(true);
              const r = await saveInboundSettings({ data: { domains: domains.split(/[,\s]+/).filter(Boolean), poc: poc || null, form: form || null } });
              setBusy(false);
              if (!r.ok) return void toast.error(r.error ?? "Not saved.");
              toast.success("Saved"); await load();
            }}>Save</Button></div>}
          </div>
          <div className="rounded-lg" style={{ marginTop: 14, padding: "10px 12px", background: "#FAFAFA", border: "1px solid #E4E4E7", fontSize: 12, color: "#52525B", lineHeight: 1.6 }}>
            Point your mail provider's inbound webhook at<br />
            <code style={{ fontSize: 12, color: "#18181B", wordBreak: "break-all" }}>{origin}/inbound/email/{o.slug}</code><br />
            with the shared secret <code>INBOUND_SECRET</code> in an <code>x-inbound-secret</code> header.
          </div>
        </Card>

        <Card title="Send a message in" style={{ marginBottom: 0 }}>
          <p style={{ fontSize: 13, color: "#52525B", margin: "0 0 10px" }}>Runs exactly what the webhook runs, for a message typed here.</p>
          <div className="flex gap-2 flex-wrap" style={{ marginBottom: 10 }}>
            <Button small onClick={() => {
              setFrom(`Ayesha Siddiqua <ayesha.siddiqua@${o.domains[0] ?? "grameenphone.com"}>`);
              setSubject("Eid data bundle cashback — joint campaign proposal");
              setBody("Dear bKash team,\n\nWe propose a joint campaign: 10% cashback (up to BDT 50) when customers buy a data bundle of BDT 199 or more with bKash, running for the two weeks around Eid.\n\nExpected reach is 350,000 customers. Please find the brief attached.\n\nRegards,\nAyesha");
            }}>A partner's request</Button>
            {lastTicket && <Button small onClick={() => {
              setFrom("so.configuration@bkash.example");
              setSubject(`UAT passed — ${lastTicket.reference}`);
              setBody("UAT for the campaign configuration is complete. All 14 test cases passed; the campaign is ready to go live.");
            }}>A UAT result for {lastTicket.reference}</Button>}
          </div>
          <div className="flex flex-col gap-2.5">
            <Field label="From"><input name="inbound-from" style={inputStyle} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="name@partner.com" /></Field>
            <Field label="Subject"><input name="inbound-subject" style={inputStyle} value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
            <Field label="Message"><textarea name="inbound-body" rows={5} style={{ ...inputStyle, resize: "vertical" }} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
            <label className="inline-flex items-center gap-2 rounded-md" style={{ padding: "7px 10px", border: "1px dashed #D4D4D8", fontSize: 12.5, color: "#52525B", cursor: "pointer", alignSelf: "flex-start" }}>
              <Paperclip size={13} /> {file ? file.name : "Attach a file (optional)"}
              <input type="file" hidden aria-label="Attachment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <div><Button tone="brand" busy={busy} disabled={!canManage || !from} name="send-inbound" onClick={async () => {
              setBusy(true);
              const fd = new FormData();
              fd.set("from", from); fd.set("subject", subject); fd.set("body", body);
              if (file) fd.set("file", file);
              const r = await simulateInbound({ data: fd });
              setBusy(false);
              if (!r.ok) return void toast.error(r.error);
              const res = r.result;
              toast.success(res.outcome === "ticket" ? `Ticket ${res.reference} raised` : res.outcome === "note" ? `Added to ${res.reference}` : `Not taken in: ${res.reason}`);
              setFile(null); await load();
            }}><Send size={13} /> Send it in</Button></div>
            {!canManage && <Notice tone="zinc">Sending mail in needs the notifications.manage permission.</Notice>}
          </div>
        </Card>
      </div>

      <Card title="Received" style={{ marginTop: 16 }}>
        <div data-testid="inbound-log">
          {o.entries.map((e) => (
            <div key={e.id} className="flex items-center gap-3 flex-wrap" style={{ padding: "9px 2px", borderTop: "1px solid #F4F4F5", fontSize: 13 }}>
              <span style={{ width: 120, color: "#71717A", fontSize: 12 }}>{fmtWhen(e.received_at)}</span>
              <Pill tone={OUTCOME[e.outcome].tone}>{OUTCOME[e.outcome].word}</Pill>
              <span style={{ flex: 1, minWidth: 220 }} className="truncate">
                <strong>{e.subject || "(no subject)"}</strong> <span style={{ color: "#71717A" }}>from {e.from_address}</span>
                {e.reason && <span style={{ color: "#A1A1AA" }}> — {e.reason}</span>}
              </span>
              {e.attachments.length > 0 && <span style={{ fontSize: 12, color: "#71717A" }}>{e.attachments.length} attached</span>}
              {e.submission_id && (
                <Link to="/status/$submissionId" params={{ submissionId: e.submission_id }} style={{ color: "#4F46E5", fontSize: 12.5 }}>{e.reference}</Link>
              )}
            </div>
          ))}
          {o.entries.length === 0 && (
            <div className="flex flex-col items-center" style={{ padding: "36px 20px", color: "#A1A1AA", fontSize: 13 }}>
              <Inbox size={20} style={{ marginBottom: 6 }} /> Nothing received yet.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
