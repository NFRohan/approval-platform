import { Link } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Copy, Plug, Plus, RefreshCw, RotateCcw, Send, Trash2, XCircle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  connectServicedeskCloud, fetchServicedeskNow, loadServicedesk, retryServicedeskEvent, saveServicedesk, saveServicedeskClearance,
  simulateServicedeskTicket, testServicedesk,
  type ClearanceTask, type FormMapRow, type ServicedeskEvent, type ServicedeskSettings,
} from "@/lib/servicedesk-fn";
import { Button, Card, Field, Notice, Pill, fmtWhen, inputStyle } from "@/components/admin/kit";

const INK = "#18181B";
const MUTED = "#71717A";
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 };

const STATUS: Record<string, { tone: "green" | "red" | "amber" | "zinc" | "brand"; word: string }> = {
  sent: { tone: "green", word: "Sent" }, received: { tone: "green", word: "Raised" }, queued: { tone: "amber", word: "Queued" },
  sending: { tone: "amber", word: "Sending" }, failed: { tone: "red", word: "Failed" }, refused: { tone: "red", word: "Refused" },
  skipped: { tone: "zinc", word: "Not connected" }, ignored: { tone: "zinc", word: "Ignored" },
};
const KIND: Record<string, string> = {
  webhook: "Ticket from webhook", fetched: "Ticket fetched", simulated: "Ticket typed in",
  note: "Note on the ticket", resolution: "Resolution", close: "Ticket closed",
  create: "IT clearance ticket raised", clearance: "IT clearance ticket checked",
};

type Draft = {
  enabled: boolean; base_url: string; token: string; allow_self_signed: boolean; default_form: string | null;
  form_map: FormMapRow[]; approved_closure: string; rejected_closure: string;
};

// ServiceDesk Plus Cloud, by data centre: where its portals are, and the
// Zoho accounts server that signs in for it.
const CLOUD = [
  { dc: "US", api: "https://sdpondemand.manageengine.com", accounts: "https://accounts.zoho.com" },
  { dc: "India", api: "https://sdpondemand.manageengine.in", accounts: "https://accounts.zoho.in" },
  { dc: "EU", api: "https://sdpondemand.manageengine.eu", accounts: "https://accounts.zoho.eu" },
  { dc: "Australia", api: "https://servicedeskplus.net.au", accounts: "https://accounts.zoho.com.au" },
  { dc: "Japan", api: "https://servicedeskplus.jp", accounts: "https://accounts.zoho.jp" },
  { dc: "Canada", api: "https://servicedeskplus.ca", accounts: "https://accounts.zohocloud.ca" },
  { dc: "Saudi Arabia", api: "https://servicedeskplus.sa", accounts: "https://accounts.zoho.sa" },
  { dc: "UK", api: "https://servicedeskplus.uk", accounts: "https://accounts.zoho.uk" },
];

export function ServicedeskTab() {
  const [settings, setSettings] = useState<ServicedeskSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [events, setEvents] = useState<ServicedeskEvent[]>([]);
  const [tasks, setTasks] = useState<ClearanceTask[]>([]);
  const [forms, setForms] = useState<string[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState("");
  const [test, setTest] = useState<{ connected: boolean; message: string; ms: number | null; tickets: number | null } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [where, setWhere] = useState<"onprem" | "cloud">("onprem");
  const [cloud, setCloud] = useState({ dc: "US", portal: "", client_id: "", client_secret: "", code: "" });

  const load = useCallback(async () => {
    const r = await loadServicedesk();
    if (!r.ok) return void toast.error(r.error);
    setSettings(r.settings); setEvents(r.events); setTasks(r.tasks); setForms(r.forms); setCanManage(r.canManage);
    setDraft((d) => {
      if (d) return d;
      // A cloud link, or an address that is a cloud portal, opens on the cloud.
      const c = CLOUD.find((x) => (r.settings.base_url ?? "").startsWith(x.api + "/app/") || x.accounts === r.settings.oauth_accounts_url);
      if (r.settings.auth_mode === "oauth" || c) {
        setWhere("cloud");
        setCloud((v) => ({
          ...v, dc: c?.dc ?? v.dc, client_id: r.settings.oauth_client_id ?? "",
          portal: /\/app\/([^/]+)/.exec(r.settings.base_url ?? "")?.[1] ?? "",
        }));
      }
      return {
        enabled: r.settings.enabled, base_url: r.settings.base_url ?? "", token: "", allow_self_signed: r.settings.allow_self_signed,
        default_form: r.settings.default_form, form_map: r.settings.form_map, approved_closure: r.settings.approved_closure,
        rejected_closure: r.settings.rejected_closure,
      };
    });
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!settings || !draft) return <div style={{ marginTop: 14, color: MUTED, fontSize: 13 }}>Loading…</div>;

  const dc = CLOUD.find((x) => x.dc === cloud.dc) ?? CLOUD[0];
  const cloudUrl = cloud.portal.trim() ? `${dc.api}/app/${cloud.portal.trim()}` : "";
  const address = where === "cloud" ? cloudUrl : draft.base_url;

  const save = async (rotate = false) => {
    setBusy(rotate ? "rotate" : "save");
    const r = await saveServicedesk({ data: {
      ...draft, base_url: address, token: where === "onprem" ? draft.token || null : null,
      allow_self_signed: where === "onprem" && draft.allow_self_signed, rotate_secret: rotate,
    } });
    setBusy("");
    if (!r.ok) return void toast.error(r.error);
    toast.success(rotate ? "New secret — give it to ServiceDesk's webhook" : "Saved");
    setDraft({ ...draft, token: "" });
    await load();
  };
  const runTest = async () => {
    setBusy("test");
    const r = await testServicedesk({ data: { base_url: address, token: where === "onprem" ? draft.token || null : null, allow_self_signed: where === "onprem" && draft.allow_self_signed } });
    setBusy("");
    if (!r.ok) return void toast.error(r.error);
    setTest(r);
  };
  // Cloud: the address first, then the code swapped for a refresh token.
  const signIn = async () => {
    if (!cloudUrl) return void toast.error("Give the portal's name first.");
    setBusy("signin");
    const saved = await saveServicedesk({ data: { ...draft, enabled: false, base_url: cloudUrl, token: null, allow_self_signed: false } });
    if (!saved.ok) { setBusy(""); return void toast.error(saved.error); }
    const r = await connectServicedeskCloud({ data: { accounts_url: dc.accounts, client_id: cloud.client_id, client_secret: cloud.client_secret, code: cloud.code } });
    setBusy("");
    if (!r.ok) return void toast.error(r.error);
    toast.success("Signed in with Zoho. Test the connection, then switch it on.");
    setCloud({ ...cloud, client_secret: "", code: "" });
    setDraft({ ...draft, base_url: cloudUrl, enabled: false });
    await load();
  };
  const fetchNow = async () => {
    setBusy("fetch");
    const r = await fetchServicedeskNow();
    setBusy("");
    if (!r.ok) return void toast.error(r.error);
    if (r.error) toast.error(r.error); else toast.success(`${r.seen} new ticket${r.seen === 1 ? "" : "s"}: ${r.raised} raised for approval, ${r.ignored} not needing one, ${r.refused} refused`);
    await load();
  };
  const retry = async (e: ServicedeskEvent) => {
    const r = await retryServicedeskEvent({ data: { id: e.id } });
    if (!r.ok) return void toast.error(r.error);
    toast[r.status === "sent" ? "success" : "error"](r.status === "sent" ? "Sent" : `${STATUS[r.status]?.word ?? r.status}: ${r.error ?? ""}`);
    await load();
  };
  const setRow = (i: number, row: FormMapRow | null) =>
    setDraft({ ...draft, form_map: row ? draft.form_map.map((r, j) => (j === i ? row : r)) : draft.form_map.filter((_, j) => j !== i) });

  const curl = `curl -X POST "${settings.inbound_url}" \\
  -H "X-AMS-Secret: ${settings.inbound_secret ?? "<secret>"}" \\
  -H "Content-Type: application/json" \\
  -d '{"id": "1234"}'`;

  return (
    <div style={{ marginTop: 14 }} data-testid="servicedesk">
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <span className="rounded-lg inline-flex items-center justify-center" style={{ width: 34, height: 34, background: "#EEF2FF", color: "#4338CA" }}><Plug size={16} /></span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>ManageEngine ServiceDesk Plus</div>
          <div style={{ fontSize: 12.5, color: MUTED }}>
            A ticket that needs approval is raised here as a request; every decision is written back to the ticket, and it is closed at the end.
          </div>
        </div>
        <span style={{ marginLeft: "auto" }}>{settings.enabled ? <Pill tone="green">Connected</Pill> : <Pill>Not connected</Pill>}</span>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
        <Card title="Connection" style={{ marginBottom: 0 }}>
          <div className="flex flex-col gap-3">
            <div className="inline-flex rounded-md" style={{ border: "1px solid #E4E4E7", overflow: "hidden", alignSelf: "flex-start" }} role="radiogroup" aria-label="Where ServiceDesk runs">
              {([["onprem", "On premises"], ["cloud", "Cloud (sdpondemand)"]] as const).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={where === k} disabled={!canManage} onClick={() => setWhere(k)}
                  style={{ padding: "6px 12px", fontSize: 12.5, border: 0, cursor: "pointer", background: where === k ? "#18181B" : "#fff", color: where === k ? "#fff" : "#3F3F46" }}>{label}</button>
              ))}
            </div>
            {where === "onprem" ? (
              <>
                <Field label="ServiceDesk's address" hint="As technicians open it, without a path — e.g. https://servicedesk.bkash.local:8080">
                  <input aria-label="ServiceDesk address" style={inputStyle} value={draft.base_url ?? ""} disabled={!canManage}
                    onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} placeholder="https://servicedesk.example.com:8080" />
                </Field>
                <Field label="Technician API key" hint={<>In ServiceDesk: your profile → <em>Generate API Key</em>, for a technician who may add notes and close requests. {settings.has_token ? "One is stored; type a new one to replace it." : ""}</>}>
                  <input aria-label="Technician API key" type="password" autoComplete="off" style={inputStyle} value={draft.token} disabled={!canManage}
                    onChange={(e) => setDraft({ ...draft, token: e.target.value })} placeholder={settings.has_token ? "•••••••• stored, sealed" : "6F2A…"} />
                </Field>
                <label className="flex items-center gap-2" style={{ fontSize: 12.5, color: "#3F3F46" }}>
                  <input type="checkbox" aria-label="Allow a self-signed certificate" checked={draft.allow_self_signed} disabled={!canManage}
                    onChange={(e) => setDraft({ ...draft, allow_self_signed: e.target.checked })} />
                  Allow a self-signed certificate — an on-premises server usually has one
                </label>
              </>
            ) : (
              <div className="flex flex-col gap-3" data-testid="servicedesk-cloud">
                <div className="grid gap-3" style={{ gridTemplateColumns: "140px 1fr" }}>
                  <Field label="Data centre">
                    <select aria-label="Data centre" style={inputStyle} value={cloud.dc} disabled={!canManage} onChange={(e) => setCloud({ ...cloud, dc: e.target.value })}>
                      {CLOUD.map((c) => <option key={c.dc} value={c.dc}>{c.dc}</option>)}
                    </select>
                  </Field>
                  <Field label="Portal" hint={<>The name in the portal's address — ESM Directory → Service Desk Instances. Calls go to <code style={mono}>{cloudUrl || `${dc.api}/app/…`}</code></>}>
                    <input aria-label="Portal name" style={inputStyle} value={cloud.portal} disabled={!canManage} onChange={(e) => setCloud({ ...cloud, portal: e.target.value.replace(/[^A-Za-z0-9._-]/g, "") })} placeholder="itdesk" />
                  </Field>
                </div>
                <div className="rounded-lg" style={{ background: "#FAFAFA", border: "1px solid #F4F4F5", padding: "10px 12px", fontSize: 12.5, color: "#3F3F46", lineHeight: 1.55 }}>
                  {settings.oauth_signed_in
                    ? <div className="flex items-center gap-2" style={{ color: "#14532D" }}><CheckCircle2 size={14} /> Signed in through {settings.oauth_accounts_url?.replace("https://", "")} as client {settings.oauth_client_id}. Sign in again below to replace it.</div>
                    : <div>Sign in once, with a <strong>Self Client</strong>:</div>}
                  <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    <li>Open <a href={dc.accounts.replace("accounts.", "api-console.")} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>{dc.accounts.replace("https://accounts.", "api-console.")}</a> → <em>Get started</em> → <strong>Self Client</strong> → Create. Copy the client id and secret.</li>
                    <li><em>Generate Code</em>: scope <code style={mono}>SDPOnDemand.requests.ALL</code>, 10 minutes, any description; choose the ServiceDesk portal if asked.</li>
                    <li>Paste the code here and sign in — within those minutes. The code is swapped for a refresh token, kept sealed.</li>
                  </ol>
                </div>
                <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <Field label="Client id"><input aria-label="Zoho client id" style={inputStyle} value={cloud.client_id} disabled={!canManage} onChange={(e) => setCloud({ ...cloud, client_id: e.target.value.trim() })} placeholder="1000.XXXX…" /></Field>
                  <Field label="Client secret"><input aria-label="Zoho client secret" type="password" autoComplete="off" style={inputStyle} value={cloud.client_secret} disabled={!canManage} onChange={(e) => setCloud({ ...cloud, client_secret: e.target.value.trim() })} /></Field>
                </div>
                <div className="flex items-end gap-2">
                  <div style={{ flex: 1 }}><Field label="Generated code"><input aria-label="Zoho code" style={inputStyle} value={cloud.code} disabled={!canManage} onChange={(e) => setCloud({ ...cloud, code: e.target.value.trim() })} placeholder="1000.xxxx.yyyy" /></Field></div>
                  {canManage && <Button tone="brand" busy={busy === "signin"} disabled={!cloud.portal || !cloud.client_id || !cloud.client_secret || !cloud.code} onClick={() => void signIn()} name="zoho-sign-in">Sign in with Zoho</Button>}
                </div>
              </div>
            )}
            <label className="flex items-center gap-2" style={{ fontSize: 13, color: "#3F3F46" }}>
              <Switch checked={draft.enabled} disabled={!canManage} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} aria-label="Connected" />
              Connected — fetch new tickets and write back to them
            </label>
            {test && (
              <div className="rounded-lg flex items-center gap-2" data-testid="servicedesk-test"
                style={{ padding: "8px 12px", fontSize: 12.5, background: test.connected ? "#F0FDF4" : "#FEF2F2", color: test.connected ? "#14532D" : "#991B1B" }}>
                {test.connected ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span>{test.message}{test.ms !== null ? ` · ${test.ms} ms` : ""}{test.tickets !== null ? ` · ${test.tickets.toLocaleString("en-US")} tickets` : ""}</span>
              </div>
            )}
            {canManage && (
              <div className="flex gap-2">
                <Button busy={busy === "test"} onClick={() => void runTest()} name="test-servicedesk"><Plug size={13} /> Test the connection</Button>
                <Button tone="brand" busy={busy === "save"} onClick={() => void save()} name="save-servicedesk">Save</Button>
              </div>
            )}
          </div>
        </Card>

        <Card title="Which tickets need approval" style={{ marginBottom: 0 }}>
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 10 }}>
            A ticket whose template or category matches becomes a request on that form, raised as the ticket's requester (matched by email).
            Anything else is left to the service desk.
          </div>
          <div className="flex flex-col gap-2" data-testid="servicedesk-map">
            {draft.form_map.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input aria-label={`Template or category ${i + 1}`} style={{ ...inputStyle, flex: 1 }} value={r.match} disabled={!canManage}
                  onChange={(e) => setRow(i, { ...r, match: e.target.value })} placeholder="Access" />
                <span style={{ color: MUTED }}>→</span>
                <select aria-label={`Form ${i + 1}`} style={{ ...inputStyle, flex: 1.3 }} value={r.form} disabled={!canManage} onChange={(e) => setRow(i, { ...r, form: e.target.value })}>
                  <option value="">Choose a form</option>
                  {forms.map((f) => <option key={f}>{f}</option>)}
                </select>
                {canManage && <button type="button" aria-label="Remove" onClick={() => setRow(i, null)} style={{ border: 0, background: "none", color: MUTED, cursor: "pointer" }}><Trash2 size={14} /></button>}
              </div>
            ))}
            {canManage && <div><Button small onClick={() => setDraft({ ...draft, form_map: [...draft.form_map, { match: "", form: "" }] })}><Plus size={12} /> Add a mapping</Button></div>}
          </div>
          <div className="grid gap-3 mt-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <Field label="Anything else">
              <select aria-label="Default form" style={inputStyle} value={draft.default_form ?? ""} disabled={!canManage} onChange={(e) => setDraft({ ...draft, default_form: e.target.value || null })}>
                <option value="">Leave it alone</option>
                {forms.map((f) => <option key={f}>{f}</option>)}
              </select>
            </Field>
            <Field label="Closure code, approved"><input aria-label="Approved closure code" style={inputStyle} value={draft.approved_closure} disabled={!canManage} onChange={(e) => setDraft({ ...draft, approved_closure: e.target.value })} /></Field>
            <Field label="Closure code, rejected"><input aria-label="Rejected closure code" style={inputStyle} value={draft.rejected_closure} disabled={!canManage} onChange={(e) => setDraft({ ...draft, rejected_closure: e.target.value })} /></Field>
          </div>
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6 }}>Closure codes are ServiceDesk's own names (Admin → Closure Code). Save with the connection.</div>
        </Card>
      </div>

      <div className="grid gap-4 mt-4" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)" }}>
        <Card title="Tickets in" style={{ marginBottom: 0 }}>
          <div style={{ fontSize: 13, color: "#3F3F46", lineHeight: 1.55 }}>
            <strong>As they are raised</strong>, from ServiceDesk's own webhook:
            <ol style={{ margin: "6px 0 10px", paddingLeft: 18 }}>
              <li>Admin → Developer Space → <strong>Webhooks</strong> → New. Method <code style={mono}>POST</code>, URL below, a header <code style={mono}>X-AMS-Secret</code> with the secret, content type JSON, and the payload <code style={mono}>{`{"id": "$`}<em>Request ID</em>{`"}`}</code> — type <code style={mono}>$</code> and choose the request's ID.</li>
              <li>Admin → Automation → <strong>Custom Triggers</strong> → Add Trigger: on <em>Create</em>, criteria for the templates mapped here, action <em>Webhook</em>, the one above.</li>
            </ol>
            The rest of the ticket is fetched through the API, so only the id has to be sent.
          </div>
          <div className="rounded-lg mt-2" style={{ background: "#FAFAFA", border: "1px solid #F4F4F5", padding: "8px 10px" }}>
            <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
              <span style={{ color: MUTED, width: 52 }}>URL</span><code style={{ ...mono, wordBreak: "break-all" }} data-testid="servicedesk-url">{settings.inbound_url}</code>
              <button type="button" aria-label="Copy the URL" onClick={() => void navigator.clipboard?.writeText(settings.inbound_url)} style={{ border: 0, background: "none", cursor: "pointer", color: MUTED }}><Copy size={12} /></button>
            </div>
            {settings.inbound_secret && (
              <div className="flex items-center gap-2 mt-1" style={{ fontSize: 12 }}>
                <span style={{ color: MUTED, width: 52 }}>Secret</span><code style={{ ...mono, wordBreak: "break-all" }} data-testid="servicedesk-secret">{settings.inbound_secret}</code>
                <button type="button" aria-label="Copy the secret" onClick={() => void navigator.clipboard?.writeText(settings.inbound_secret ?? "")} style={{ border: 0, background: "none", cursor: "pointer", color: MUTED }}><Copy size={12} /></button>
                {canManage && <Button small busy={busy === "rotate"} onClick={() => { if (window.confirm("A new secret? ServiceDesk's webhook must be given it.")) void save(true); }}><RotateCcw size={11} /> New</Button>}
              </div>
            )}
          </div>
          <details className="mt-2"><summary style={{ fontSize: 12, color: "#4338CA", cursor: "pointer" }}>What ServiceDesk sends, as a curl</summary>
            <pre className="rounded-lg" style={{ ...mono, background: "#18181B", color: "#E4E4E7", padding: 10, marginTop: 6, overflowX: "auto" }}>{curl}</pre>
          </details>
          <div style={{ fontSize: 13, color: "#3F3F46", marginTop: 12 }}>
            <strong>Or fetched from here</strong> — for an edition without webhooks, or to catch up: new tickets since the last look, every morning and on demand.
          </div>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {canManage && <Button small busy={busy === "fetch"} disabled={!settings.enabled} onClick={() => void fetchNow()} name="fetch-servicedesk"><RefreshCw size={12} /> Fetch new tickets now</Button>}
            <span style={{ fontSize: 12, color: MUTED }}>
              {settings.last_poll_at ? `Last looked ${fmtWhen(settings.last_poll_at)}` : "Not looked yet"}
              {settings.last_poll_result && !settings.last_poll_result.error ? ` — ${settings.last_poll_result.seen} new, ${settings.last_poll_result.raised} raised` : ""}
              {settings.last_poll_result?.error ? ` — ${settings.last_poll_result.error}` : ""}
            </span>
          </div>
        </Card>
        {canManage && <TryTicket forms={draft.form_map} onDone={load} />}
      </div>

      <ClearanceCard settings={settings} forms={forms} tasks={tasks} canManage={canManage} onSaved={load} />

      <Card title="Every exchange" style={{ marginTop: 16 }} aside={<Button small onClick={() => void load()}><RefreshCw size={12} /> Refresh</Button>}>
        {!settings.enabled && events.some((e) => e.status === "skipped") && (
          <Notice tone="zinc">Not connected, so what would have been written back to ServiceDesk is kept here, marked <em>Not connected</em>. Connect, then retry any of them.</Notice>
        )}
        <div style={{ maxHeight: 520, overflowY: "auto" }}>
          <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }} data-testid="servicedesk-events">
            <thead><tr style={{ color: MUTED, fontSize: 11.5, textAlign: "left" }}>
              {["", "When", "What", "Ticket", "Request", "Outcome", ""].map((h, i) => <th key={i} style={{ padding: "6px 8px", fontWeight: 500 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {events.map((e) => {
                const s = e.kind === "clearance"
                  ? (() => {
                      const out = (() => { try { return JSON.parse(e.payload)?.outcome as string | undefined; } catch { return undefined; } })();
                      return out === "cleared" ? { tone: "green" as const, word: "Cleared" } : { tone: "zinc" as const, word: out === "still open" ? "Still open" : "Noted" };
                    })()
                  : STATUS[e.status] ?? STATUS.queued;
                return (
                  <Fragment key={e.id}>
                    <tr style={{ borderTop: "1px solid #F4F4F5", cursor: "pointer" }} onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <td style={{ padding: "7px 8px", color: e.direction === "in" ? "#2a78d6" : "#eb6834" }} title={e.direction === "in" ? "From ServiceDesk" : "To ServiceDesk"}>
                        {e.direction === "in" ? <ArrowDownLeft size={14} aria-label="From ServiceDesk" /> : <ArrowUpRight size={14} aria-label="To ServiceDesk" />}
                      </td>
                      <td style={{ padding: "7px 8px", whiteSpace: "nowrap", color: "#3F3F46" }}>{fmtWhen(e.created_at)}</td>
                      <td style={{ padding: "7px 8px" }}>{KIND[e.kind] ?? e.kind}</td>
                      <td style={{ padding: "7px 8px" }}><code style={mono}>{e.ticket_id ? `#${e.ticket_id}` : "—"}</code></td>
                      <td style={{ padding: "7px 8px" }}>
                        {e.submission_id && e.reference
                          ? <Link to="/status/$submissionId" params={{ submissionId: e.submission_id }} onClick={(ev) => ev.stopPropagation()} className="font-mono" style={{ fontSize: 11.5, color: "#4338CA" }}>{e.reference}</Link>
                          : "—"}
                      </td>
                      <td style={{ padding: "7px 8px" }}>
                        <Pill tone={s.tone}>{s.word}</Pill>
                        {e.error && <span style={{ fontSize: 11.5, color: MUTED, marginLeft: 6 }}>{e.error.slice(0, 90)}</span>}
                      </td>
                      <td style={{ padding: "7px 8px", textAlign: "right" }}>
                        {canManage && e.direction === "out" && ["failed", "skipped"].includes(e.status) && (
                          <Button small onClick={() => void retry(e)}><Send size={11} /> Retry</Button>
                        )}
                      </td>
                    </tr>
                    {open === e.id && (
                      <tr><td colSpan={7} style={{ padding: "0 8px 10px" }}>
                        <pre className="rounded-lg" style={{ ...mono, fontSize: 11.5, background: "#18181B", color: "#E4E4E7", padding: 10, margin: 0, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap" }}>
                          {(e.direction === "out" ? "input_data = " : "") + JSON.stringify(JSON.parse(e.payload || "null"), null, 2)}
                          {e.response ? `\n\n← ${e.http_status ?? ""} ${e.response}` : ""}
                        </pre>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {events.length === 0 && <tr><td colSpan={7} style={{ padding: 20, color: MUTED, textAlign: "center" }}>Nothing yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function TryTicket({ forms, onDone }: { forms: FormMapRow[]; onDone: () => Promise<void> }) {
  const [t, setT] = useState({
    id: String(40000 + Math.floor(Math.random() * 9000)), subject: "Access to the finance ledger", requester_email: "",
    category: forms[0]?.match ?? "Access", priority: "Normal",
    description: "Need read access to the finance ledger for the quarter-end close.",
  });
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ outcome: string; reference?: string; submission_id?: string; reason?: string } | null>(null);
  const send = async () => {
    setBusy(true);
    const r = await simulateServicedeskTicket({ data: t });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setOut(r);
    setT({ ...t, id: String(Number(t.id) + 1) });
    await onDone();
  };
  return (
    <Card title="Try it with a ticket" style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 10 }}>A ticket as ServiceDesk would send it — to see the whole round without a server.</div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "90px 1fr" }}>
        <Field label="Ticket"><input aria-label="Ticket id" style={inputStyle} value={t.id} onChange={(e) => setT({ ...t, id: e.target.value })} /></Field>
        <Field label="Subject"><input aria-label="Ticket subject" style={inputStyle} value={t.subject} onChange={(e) => setT({ ...t, subject: e.target.value })} /></Field>
      </div>
      <div className="grid gap-2 mt-2" style={{ gridTemplateColumns: "1fr 1fr 100px" }}>
        <Field label="Requester's email"><input aria-label="Requester email" style={inputStyle} value={t.requester_email} onChange={(e) => setT({ ...t, requester_email: e.target.value })} placeholder="tom.bexley@example.com" /></Field>
        <Field label="Category or template"><input aria-label="Ticket category" style={inputStyle} value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })} list="sd-matches" /></Field>
        <Field label="Priority">
          <select aria-label="Ticket priority" style={inputStyle} value={t.priority} onChange={(e) => setT({ ...t, priority: e.target.value })}>
            {["Low", "Normal", "High", "Urgent"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
      </div>
      <datalist id="sd-matches">{forms.map((f) => <option key={f.match} value={f.match} />)}</datalist>
      <Field label="Description"><textarea aria-label="Ticket description" style={{ ...inputStyle, minHeight: 56, marginTop: 8 }} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} /></Field>
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <Button tone="brand" busy={busy} disabled={!t.id || !t.requester_email} onClick={() => void send()} name="send-ticket"><Send size={13} /> Send the ticket</Button>
        {out && (
          <span style={{ fontSize: 12.5 }} data-testid="ticket-outcome">
            {out.outcome === "raised" && out.submission_id
              ? <>Raised as <Link to="/status/$submissionId" params={{ submissionId: out.submission_id }} className="font-mono" style={{ color: "#4338CA" }}>{out.reference}</Link></>
              : out.outcome === "duplicate" ? <>Already raised as {out.reference}</> : <span style={{ color: "#B45309" }}>{out.outcome === "ignored" ? "Left alone" : "Refused"}: {out.reason}</span>}
          </span>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------
// A leaver's IT clearance: the exit clearance's IT track raises a ticket
// in ServiceDesk, and the track clears when the ticket is resolved there.
// ---------------------------------------------------------------------
const TASK: Record<ClearanceTask["status"], { tone: "green" | "red" | "amber" | "zinc" | "brand"; word: string }> = {
  opening: { tone: "amber", word: "Raising" }, open: { tone: "brand", word: "Open in ServiceDesk" },
  cleared: { tone: "green", word: "Cleared" }, failed: { tone: "red", word: "Not raised" },
};

function ClearanceCard({ settings, forms, tasks, canManage, onSaved }: {
  settings: ServicedeskSettings; forms: string[]; tasks: ClearanceTask[]; canManage: boolean; onSaved: () => Promise<void> | void;
}) {
  const [d, setD] = useState({
    enabled: settings.clearance_enabled, form: settings.clearance_form ?? "Employee Exit Clearance",
    track: settings.clearance_track ?? "Product & Technology", category: settings.clearance_category ?? "",
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await saveServicedeskClearance({ data: { enabled: d.enabled, form: d.form, track: d.track, category: d.category || null } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(d.enabled ? "Saved — the next leaver's IT clearance goes to ServiceDesk" : "Saved — IT clearance stays here");
    await onSaved();
  };
  return (
    <Card title="IT clearance for leavers" style={{ marginTop: 16 }} aside={<Pill tone={settings.clearance_enabled ? "green" : "zinc"}>{settings.clearance_enabled ? "On" : "Off"}</Pill>}>
      <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 10 }}>
        When a leaver's IT track opens, a ticket is raised in ServiceDesk for IT to recover equipment and close accounts.
        When it is resolved there, the track's checklist is ticked and the track clears here, with the ticket number on the history.
        A ServiceDesk trigger on <em>Edit</em> calling the same webhook tells this side at once; otherwise each look for new tickets checks them.
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "auto 1.2fr 1fr 1fr auto", alignItems: "end" }}>
        <Field label="On">
          <Switch aria-label="IT clearance through ServiceDesk" checked={d.enabled} disabled={!canManage} onCheckedChange={(v) => setD({ ...d, enabled: v })} />
        </Field>
        <Field label="Form">
          <select aria-label="Clearance form" style={inputStyle} value={d.form} disabled={!canManage} onChange={(e) => setD({ ...d, form: e.target.value })}>
            {forms.map((f) => <option key={f}>{f}</option>)}
          </select>
        </Field>
        <Field label="Track that is IT's">
          <input aria-label="Clearance track" style={inputStyle} value={d.track} disabled={!canManage} onChange={(e) => setD({ ...d, track: e.target.value })} />
        </Field>
        <Field label="Category there (optional)">
          <input aria-label="Clearance category" style={inputStyle} value={d.category} disabled={!canManage} placeholder="e.g. User Administration" onChange={(e) => setD({ ...d, category: e.target.value })} />
        </Field>
        {canManage && <Button tone="brand" busy={busy} onClick={() => void save()} name="save-clearance">Save</Button>}
      </div>
      {tasks.length > 0 && (
        <table className="w-full mt-4" style={{ fontSize: 12.5, borderCollapse: "collapse" }} data-testid="clearance-tasks">
          <thead><tr style={{ color: MUTED, fontSize: 11.5, textAlign: "left" }}>
            {["Leaver", "Request", "Ticket", "There", "Here", "Raised"].map((h) => <th key={h} style={{ padding: "6px 8px", fontWeight: 500 }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {tasks.map((k) => (
              <tr key={k.id} style={{ borderTop: "1px solid #F4F4F5" }}>
                <td style={{ padding: "7px 8px", color: INK }}>{k.leaver ?? "—"}</td>
                <td style={{ padding: "7px 8px" }}>
                  <Link to="/status/$submissionId" params={{ submissionId: k.submission_id }} style={{ color: "#4338CA" }}>{k.reference ?? "Open"}</Link>
                </td>
                <td style={{ padding: "7px 8px", ...mono }}>{k.ticket_id ? `#${k.ticket_id}` : "—"}</td>
                <td style={{ padding: "7px 8px", color: MUTED }}>{k.ticket_status ?? "—"}</td>
                <td style={{ padding: "7px 8px" }}><Pill tone={TASK[k.status].tone}>{TASK[k.status].word}</Pill></td>
                <td style={{ padding: "7px 8px", color: MUTED }}>{fmtWhen(k.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
