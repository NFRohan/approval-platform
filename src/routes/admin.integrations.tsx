import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  BookOpen, CheckCircle2, Copy, Eye, FileUp, KeyRound, Pencil, Plus, RefreshCw, RotateCcw, Send, Trash2, Webhook, XCircle, Download, AlertTriangle,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  createApiKey, deleteWebhook, getDeliveryPayload, importLegacyTickets, legacySummary, listDeliveries, loadIntegrations,
  redeliverWebhook, revealWebhookSecret, revokeApiKey, sampleLegacyExport, saveWebhook, sendTestWebhook,
  type ApiCall, type ApiDay, type ApiKeyRow, type DeliveryRow, type LegacyImportResult, type WebhookRow,
} from "@/lib/integrations-fn";
import { API_SCOPES, WEBHOOK_EVENTS } from "@/lib/api-catalogue";
import { legacyCsv, readLegacyFile, type LegacyParse } from "@/lib/legacy-file";
import { downloadCsv } from "@/lib/csv";
import { Button, Card, Field, NoPermission, Notice, OneTimeSecret, Page, Pill, fmtWhen, inputStyle } from "@/components/admin/kit";
import { control } from "@/components/reports/ReportParts";
import { ServicedeskTab } from "@/components/admin/ServicedeskTab";
import { ChartCard, SimpleTable, Tip, SERIES_1, SERIES_2, GRID, AXIS, INK, MUTED } from "@/components/viz";

export const Route = createFileRoute("/admin/integrations")({
  head: () => ({ meta: [{ title: "Integrations · Admin Services Portal" }] }),
  component: IntegrationsPage,
});

type Data = {
  keys: ApiKeyRow[]; webhooks: WebhookRow[]; canManage: boolean; days: ApiDay[]; calls: ApiCall[];
  totals: { calls: number; failed: number; p50: number | null; p95: number | null };
};

const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 };

function IntegrationsPage() {
  const { can } = useCurrentUser();
  const allowed = can("integrations.manage") || can("audit.view");
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState("keys");

  // Only the latest load counts. A slower earlier one (the page opening)
  // could answer after the reload a revoke or delete asks for, and put
  // back the key as active or the webhook as still there.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await loadIntegrations();
    if (mine !== seq.current) return;
    if (!r.ok) return void toast.error(r.error);
    setData(r);
  }, []);
  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  if (!allowed) return <Page title="Integrations"><NoPermission need="integrations.manage" /></Page>;

  return (
    <div className="mx-auto" style={{ maxWidth: 1280, padding: "28px 28px 56px" }}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: INK, margin: 0 }}>Integrations</h1>
          <p style={{ marginTop: 6, fontSize: 14, color: MUTED, marginBottom: 18, maxWidth: 760 }}>
            Connect the ERP, Tableau and anything else: API keys to raise and follow requests, decide approvals and pull reports;
            webhooks that tell those systems the moment something happens; and tickets brought over from ManageEngine.
          </p>
        </div>
        <Link to="/developers" className="inline-flex items-center gap-1.5 rounded-md" style={{ padding: "8px 14px", fontSize: 13, fontWeight: 500, border: "1px solid #E4E4E7", background: "#fff", color: "#3F3F46" }}>
          <BookOpen size={14} /> API documentation
        </Link>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="keys">API keys</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
          <TabsTrigger value="traffic">API traffic</TabsTrigger>
          <TabsTrigger value="servicedesk">ServiceDesk Plus</TabsTrigger>
          <TabsTrigger value="migration">Migration</TabsTrigger>
        </TabsList>
        <TabsContent value="keys">{data && <Keys data={data} reload={load} />}</TabsContent>
        <TabsContent value="webhooks">{data && <Webhooks data={data} reload={load} onDeliveries={() => setTab("deliveries")} />}</TabsContent>
        <TabsContent value="deliveries"><Deliveries hooks={data?.webhooks ?? []} canManage={!!data?.canManage} /></TabsContent>
        <TabsContent value="traffic">{data && <Traffic data={data} reload={load} />}</TabsContent>
        <TabsContent value="servicedesk"><ServicedeskTab /></TabsContent>
        <TabsContent value="migration"><Migration /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------
function Keys({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["requests:read"]);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const create = async () => {
    setBusy(true);
    const r = await createApiKey({ data: { name, scopes } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setMade({ name, key: r.key });
    setName(""); setScopes(["requests:read"]); setAdding(false);
    await reload();
  };
  const revoke = async (k: ApiKeyRow) => {
    if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working at its next call.`)) return;
    const r = await revokeApiKey({ data: { id: k.id } });
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${k.name} revoked`);
    await reload();
  };

  return (
    <div style={{ marginTop: 14 }}>
      {made && (
        <div data-testid="new-key">
          <OneTimeSecret label={`The key for ${made.name}. Copy it into the other system now.`} value={made.key} onDone={() => setMade(null)}
            note="Only a hash of it is kept, so it cannot be shown again. Lose it and you revoke it and make another." />
          <pre className="rounded-lg" style={{ ...mono, background: "#18181B", color: "#E4E4E7", padding: "12px 14px", marginTop: -6, marginBottom: 18, overflowX: "auto" }}>
{`curl ${origin()}/api/v1/me \\
  -H "Authorization: Bearer ${made.key}"`}
          </pre>
        </div>
      )}

      <Card title="Keys" aside={data.canManage && !adding ? <Button tone="brand" small onClick={() => setAdding(true)}><Plus size={12} /> New key</Button> : undefined}>
        {adding && (
          <div className="rounded-lg mb-4" style={{ border: "1px solid #E4E4E7", padding: 16, background: "#FAFAFA" }}>
            <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)" }}>
              <Field label="Which system is it for?" hint="Name it after the system, so the audit trail says who called.">
                <input aria-label="Key name" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="SAP S/4HANA — purchase requests" />
              </Field>
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46", marginBottom: 6 }}>What may it do?</div>
                <div className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  {API_SCOPES.map((s) => (
                    <label key={s.key} className="flex items-start gap-2 rounded-md" style={{ padding: "6px 8px", border: "1px solid #E4E4E7", background: "#fff", cursor: "pointer" }}>
                      <input type="checkbox" aria-label={s.key} checked={scopes.includes(s.key)} style={{ marginTop: 3 }}
                        onChange={(e) => setScopes(e.target.checked ? [...scopes, s.key] : scopes.filter((x) => x !== s.key))} />
                      <span>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>{s.label}</span>{" "}
                        <code style={{ ...mono, fontSize: 11, color: MUTED }}>{s.key}</code>
                        <div style={{ fontSize: 11.5, color: MUTED }}>{s.detail}</div>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <Button tone="brand" busy={busy} disabled={!name.trim() || scopes.length === 0} onClick={() => void create()}><KeyRound size={13} /> Create key</Button>
              <Button onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </div>
        )}
        <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse" }} data-testid="keys">
          <thead>
            <tr style={{ color: MUTED, fontSize: 11.5, textAlign: "left" }}>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>System</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Key</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Scopes</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Made</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Last used</th>
              <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>Calls, 30 days</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.keys.map((k) => (
              <tr key={k.id} style={{ borderTop: "1px solid #F4F4F5", opacity: k.revoked_at ? 0.6 : 1 }}>
                <td style={{ padding: "10px 8px" }}>
                  <div style={{ fontWeight: 600, color: INK }}>{k.name}</div>
                  {k.revoked_at ? <Pill tone="red">Revoked {fmtWhen(k.revoked_at)}</Pill> : <Pill tone="green">Active</Pill>}
                </td>
                <td style={{ padding: "10px 8px" }}><code style={mono}>ams_{k.prefix}_••••</code></td>
                <td style={{ padding: "10px 8px" }}><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Pill key={s} tone="brand">{s}</Pill>)}</div></td>
                <td style={{ padding: "10px 8px", color: "#3F3F46", fontSize: 12.5 }}>{fmtWhen(k.created_at)}<div style={{ color: MUTED, fontSize: 11.5 }}>{k.created_by_name ?? k.created_by ?? ""}</div></td>
                <td style={{ padding: "10px 8px", color: "#3F3F46", fontSize: 12.5 }}>{k.last_used_at ? fmtWhen(k.last_used_at) : "Never"}</td>
                <td style={{ padding: "10px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {k.calls_30d.toLocaleString("en-US")}
                  {k.errors_30d > 0 && <div style={{ fontSize: 11.5, color: "#B45309" }}>{k.errors_30d} refused or failed</div>}
                </td>
                <td style={{ padding: "10px 8px", textAlign: "right" }}>
                  {data.canManage && !k.revoked_at && <Button small tone="danger" onClick={() => void revoke(k)}>Revoke</Button>}
                </td>
              </tr>
            ))}
            {data.keys.length === 0 && <tr><td colSpan={7} style={{ padding: 18, color: MUTED, textAlign: "center" }}>No keys yet.</td></tr>}
          </tbody>
        </table>
      </Card>
      {!data.canManage && <Notice tone="zinc">Making and revoking keys needs the integrations.manage permission.</Notice>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------
type Draft = { id: string | null; name: string; url: string; events: string[]; active: boolean };
const blank: Draft = { id: null, name: "", url: "", events: ["request.completed", "request.rejected"], active: true };

function Webhooks({ data, reload, onDeliveries }: { data: Data; reload: () => Promise<void>; onDeliveries: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string; fresh: boolean } | null>(null);
  const [tested, setTested] = useState<Record<string, DeliveryRow | null>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const save = async (rotate = false, d = draft) => {
    if (!d) return;
    setBusy(true);
    const r = await saveWebhook({ data: { ...d, rotate } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    if (r.secret) setSecret({ name: d.name, value: r.secret, fresh: !d.id });
    toast.success(d.id ? (rotate ? "Secret rotated" : "Webhook saved") : "Webhook added");
    setDraft(null);
    await reload();
  };
  const remove = async (w: WebhookRow) => {
    if (!window.confirm(`Delete "${w.name}" and its delivery log?`)) return;
    const r = await deleteWebhook({ data: { id: w.id } });
    if (!r.ok) return void toast.error(r.error);
    await reload();
  };
  const reveal = async (w: WebhookRow) => {
    const r = await revealWebhookSecret({ data: { id: w.id } });
    if (!r.ok) return void toast.error(r.error);
    setSecret({ name: w.name, value: r.secret, fresh: false });
  };
  const test = async (w: WebhookRow) => {
    setTesting(w.id);
    const r = await sendTestWebhook({ data: { id: w.id } });
    setTesting(null);
    if (!r.ok) return void toast.error(r.error);
    setTested((t) => ({ ...t, [w.id]: r.delivery }));
    await reload();
  };

  return (
    <div style={{ marginTop: 14 }}>
      {secret && (
        <div className="rounded-lg mb-4" style={{ padding: "14px 16px", background: "#F0FDF4", border: "1px solid #BBF7D0" }} data-testid="webhook-secret">
          <div style={{ fontSize: 13, color: "#14532D", marginBottom: 8 }}>
            {secret.fresh ? `${secret.name} is listening. Its signing secret — give it to the receiving system:` : `The signing secret for ${secret.name}:`}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <code style={{ ...mono, fontSize: 13.5, padding: "6px 10px", background: "#fff", border: "1px solid #BBF7D0", borderRadius: 6, wordBreak: "break-all" }}>{secret.value}</code>
            <Button small onClick={() => void navigator.clipboard?.writeText(secret.value)}><Copy size={12} /> Copy</Button>
            <Button small onClick={() => setSecret(null)}>Done</Button>
          </div>
          <div style={{ fontSize: 11.5, color: "#166534", marginTop: 8 }}>Every delivery is signed with it — see <Link to="/developers" hash="webhooks" style={{ textDecoration: "underline" }}>how to verify one</Link>.</div>
        </div>
      )}

      {draft && (
        <Card title={draft.id ? `Edit ${draft.name}` : "New webhook"}>
          <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            <div className="flex flex-col gap-3">
              <Field label="Name"><input aria-label="Webhook name" style={inputStyle} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="SAP — purchase approvals" /></Field>
              <Field label="Address" hint={<>Where to POST each event. <button type="button" style={{ textDecoration: "underline", color: "inherit", background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => setDraft({ ...draft, url: "/webhooks/echo" })}>Use the built-in receiver</button> to try it out — it checks the signature and says what it found.</>}>
                <input aria-label="Webhook URL" style={inputStyle} value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://erp.example.com/hooks/ams" />
              </Field>
              <label className="flex items-center gap-2" style={{ fontSize: 13, color: "#3F3F46" }}>
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} aria-label="Active" /> Active
              </label>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46", marginBottom: 6 }}>Events</div>
              <div className="grid gap-1">
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev.key} className="flex items-center gap-2" style={{ fontSize: 12.5, color: "#3F3F46", cursor: "pointer" }}>
                    <input type="checkbox" aria-label={ev.key} checked={draft.events.includes(ev.key)}
                      onChange={(e) => setDraft({ ...draft, events: e.target.checked ? [...draft.events, ev.key] : draft.events.filter((x) => x !== ev.key) })} />
                    <code style={{ ...mono, fontSize: 11.5, minWidth: 170 }}>{ev.key}</code>
                    <span style={{ color: MUTED }}>{ev.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button tone="brand" busy={busy} disabled={!draft.name.trim() || !draft.url.trim() || !draft.events.length} onClick={() => void save()}>
              {draft.id ? "Save" : "Add webhook"}
            </Button>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      <div className="flex items-center justify-between mb-3">
        <div style={{ fontSize: 13, color: MUTED }}>Signed with HMAC-SHA256, retried after 1 and 5 minutes, every delivery logged.</div>
        {data.canManage && !draft && <Button tone="brand" small onClick={() => setDraft({ ...blank })}><Plus size={12} /> New webhook</Button>}
      </div>

      <div className="grid gap-3" data-testid="webhooks">
        {data.webhooks.map((w) => {
          const t = tested[w.id];
          return (
            <section key={w.id} className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
              <div className="flex items-start gap-3 flex-wrap">
                <span className="rounded-lg inline-flex items-center justify-center" style={{ width: 34, height: 34, background: "#EEF2FF", color: "#4338CA", flex: "none" }}><Webhook size={16} /></span>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span style={{ fontWeight: 600, color: INK, fontSize: 14 }}>{w.name}</span>
                    {w.active ? <Pill tone="green">Active</Pill> : <Pill>Paused</Pill>}
                    {w.url.startsWith("/") && <Pill tone="brand">Built-in receiver</Pill>}
                  </div>
                  <code style={{ ...mono, color: "#3F3F46" }}>{w.url.startsWith("/") ? origin() + w.url : w.url}</code>
                  <div className="flex flex-wrap gap-1 mt-2">{w.events.map((e) => <Pill key={e}>{e}</Pill>)}</div>
                </div>
                <div className="flex gap-4" style={{ fontSize: 12, color: MUTED }}>
                  <div><div style={{ fontSize: 18, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>{w.delivered_30d}</div>delivered, 30 days</div>
                  <div><div style={{ fontSize: 18, fontWeight: 700, color: w.failed_30d ? "#B91C1C" : INK, fontVariantNumeric: "tabular-nums" }}>{w.failed_30d}</div>failed</div>
                  <div><div style={{ fontSize: 12.5, color: "#3F3F46", marginTop: 4 }}>{w.last_delivery_at ? fmtWhen(w.last_delivery_at) : "—"}</div>last delivery</div>
                </div>
              </div>
              {t && (
                <div className="rounded-lg mt-3 flex items-center gap-2 flex-wrap" data-testid="test-result"
                  style={{ padding: "8px 12px", fontSize: 12.5, background: t.status === "delivered" ? "#F0FDF4" : "#FEF2F2", color: t.status === "delivered" ? "#14532D" : "#991B1B" }}>
                  {t.status === "delivered" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <strong>{t.status === "delivered" ? "Delivered" : t.status === "queued" ? "Not delivered yet — will retry" : "Failed"}</strong>
                  {t.response_status && <span>· {t.response_status}</span>}
                  {t.response_ms !== null && <span>· {t.response_ms} ms</span>}
                  {t.error && <span>· {t.error}</span>}
                  {t.response_body && <code style={{ ...mono, fontSize: 11.5 }}>{t.response_body.slice(0, 140)}</code>}
                </div>
              )}
              {data.canManage && (
                <div className="flex gap-2 flex-wrap mt-3">
                  <Button small busy={testing === w.id} onClick={() => void test(w)}><Send size={12} /> Send a test</Button>
                  <Button small onClick={() => setDraft({ id: w.id, name: w.name, url: w.url, events: w.events, active: w.active })}><Pencil size={12} /> Edit</Button>
                  <Button small onClick={() => void reveal(w)}><Eye size={12} /> Signing secret</Button>
                  <Button small onClick={() => { if (window.confirm("Rotate the secret? The receiver must be given the new one.")) void save(true, { id: w.id, name: w.name, url: w.url, events: w.events, active: w.active }); }}><RotateCcw size={12} /> Rotate secret</Button>
                  <Button small onClick={onDeliveries}>Deliveries</Button>
                  <Button small tone="danger" onClick={() => void remove(w)}><Trash2 size={12} /> Delete</Button>
                </div>
              )}
            </section>
          );
        })}
        {data.webhooks.length === 0 && <div className="rounded-xl text-center" style={{ padding: 32, border: "1px dashed #E4E4E7", color: MUTED, fontSize: 13 }}>No webhooks yet.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------
const DSTATUS: Record<string, { tone: "green" | "red" | "amber" | "zinc"; word: string }> = {
  delivered: { tone: "green", word: "Delivered" }, failed: { tone: "red", word: "Failed" },
  queued: { tone: "amber", word: "Retrying" }, sending: { tone: "amber", word: "Sending" },
};

function Deliveries({ hooks, canManage }: { hooks: WebhookRow[]; canManage: boolean }) {
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("");
  const [hook, setHook] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await listDeliveries({ data: { status: status || undefined, webhook: hook || undefined } });
    if (!r.ok) return void toast.error(r.error);
    setRows(r.deliveries); setCounts(r.counts);
    setSelected((s) => (s && r.deliveries.some((d) => d.id === s) ? s : r.deliveries[0]?.id ?? null));
  }, [status, hook]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setPayload(null);
    if (!selected) return;
    void getDeliveryPayload({ data: { id: selected } }).then((r) => r.ok && setPayload(r.payload));
  }, [selected]);

  const d = rows.find((x) => x.id === selected);
  const redeliver = async () => {
    if (!d) return;
    setBusy(true);
    const r = await redeliverWebhook({ data: { id: d.id } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(r.delivery?.status === "delivered" ? "Delivered" : "Sent — " + (r.delivery?.error ?? "will retry"));
    await load();
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        {(["delivered", "queued", "failed"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(status === s ? "" : s)} data-testid={`dcount-${s}`}
            className="rounded-lg text-left" style={{ padding: "8px 12px", minWidth: 100, border: `1px solid ${status === s ? "#C7D2FE" : "#E4E4E7"}`, background: status === s ? "#EEF2FF" : "#fff", cursor: "pointer" }}>
            <div style={{ fontSize: 11.5, color: MUTED }}>{DSTATUS[s].word}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>{counts[s] ?? 0}</div>
          </button>
        ))}
        <span style={{ fontSize: 11.5, color: "#A1A1AA" }}>last 30 days</span>
        <div className="flex items-center gap-2" style={{ marginLeft: "auto" }}>
          <select aria-label="Webhook" style={control} value={hook} onChange={(e) => setHook(e.target.value)}>
            <option value="">Every webhook</option>
            {hooks.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <Button small onClick={() => void load()}><RefreshCw size={12} /> Refresh</Button>
        </div>
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)" }}>
        <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", maxHeight: 640, overflowY: "auto" }} data-testid="deliveries">
          {rows.map((r) => {
            const s = DSTATUS[r.status] ?? DSTATUS.queued;
            const on = r.id === selected;
            return (
              <button key={r.id} type="button" onClick={() => setSelected(r.id)} className="w-full text-left"
                style={{ display: "block", padding: "10px 14px", borderBottom: "1px solid #F4F4F5", background: on ? "#F5F7FF" : "#fff", borderLeft: `3px solid ${on ? "var(--color-brand-500)" : "transparent"}`, cursor: "pointer" }}>
                <div className="flex items-center gap-2">
                  <code style={{ ...mono, color: INK }}>{r.event}</code>
                  <Pill tone={s.tone}>{s.word}</Pill>
                  <span style={{ marginLeft: "auto", fontSize: 11.5, color: MUTED }}>{fmtWhen(r.created_at)}</span>
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {r.webhook} · {r.response_status ?? "no answer"}{r.response_ms !== null ? ` · ${r.response_ms} ms` : ""} · {r.attempts} attempt{r.attempts === 1 ? "" : "s"}
                </div>
              </button>
            );
          })}
          {rows.length === 0 && <div style={{ padding: 24, color: MUTED, fontSize: 13, textAlign: "center" }}>Nothing delivered yet.</div>}
        </div>
        <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: 16 }}>
          {d ? (
            <>
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <code style={{ ...mono, fontSize: 13.5, color: INK, fontWeight: 600 }}>{d.event}</code>
                <Pill tone={(DSTATUS[d.status] ?? DSTATUS.queued).tone}>{(DSTATUS[d.status] ?? DSTATUS.queued).word}</Pill>
                {canManage && d.status !== "sending" && <span style={{ marginLeft: "auto" }}><Button small busy={busy} onClick={() => void redeliver()}><RotateCcw size={12} /> Redeliver</Button></span>}
              </div>
              <dl className="grid gap-x-4 gap-y-1" style={{ gridTemplateColumns: "auto 1fr", fontSize: 12.5, marginBottom: 12 }}>
                <dt style={{ color: MUTED }}>Webhook</dt><dd style={{ margin: 0 }}>{d.webhook}</dd>
                <dt style={{ color: MUTED }}>Queued</dt><dd style={{ margin: 0 }}>{fmtWhen(d.created_at)}</dd>
                <dt style={{ color: MUTED }}>Delivered</dt><dd style={{ margin: 0 }}>{d.delivered_at ? fmtWhen(d.delivered_at) : "—"}</dd>
                {d.next_attempt_at && <><dt style={{ color: MUTED }}>Next try</dt><dd style={{ margin: 0 }}>{fmtWhen(d.next_attempt_at)}</dd></>}
                <dt style={{ color: MUTED }}>Answer</dt><dd style={{ margin: 0 }}>{d.response_status ?? "none"}{d.response_ms !== null ? ` in ${d.response_ms} ms` : ""}</dd>
                {d.error && <><dt style={{ color: MUTED }}>Error</dt><dd style={{ margin: 0, color: "#B91C1C" }}>{d.error}</dd></>}
              </dl>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Headers</div>
              <pre className="rounded-lg" style={{ ...mono, background: "#FAFAFA", border: "1px solid #F4F4F5", padding: 10, margin: "0 0 10px", whiteSpace: "pre-wrap" }}>
{`X-AMS-Event: ${d.event}
X-AMS-Delivery: ${d.id}
X-AMS-Timestamp: <seconds when signed>
X-AMS-Signature: sha256=<HMAC of "timestamp.body">`}
              </pre>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Body</div>
              <pre className="rounded-lg" data-testid="delivery-payload" style={{ ...mono, background: "#18181B", color: "#E4E4E7", padding: 12, margin: "0 0 10px", maxHeight: 300, overflow: "auto" }}>{payload ?? "…"}</pre>
              {d.response_body && <>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>The receiver said</div>
                <pre className="rounded-lg" style={{ ...mono, background: "#FAFAFA", border: "1px solid #F4F4F5", padding: 10, margin: 0, whiteSpace: "pre-wrap" }}>{d.response_body}</pre>
              </>}
            </>
          ) : <div style={{ color: MUTED, fontSize: 13 }}>Choose a delivery.</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// API traffic
// ---------------------------------------------------------------------
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function Traffic({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const t = data.totals;
  const rate = t.calls ? Math.round((t.failed / t.calls) * 1000) / 10 : 0;
  return (
    <div style={{ marginTop: 14 }} className="grid gap-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        {[
          ["Calls, last 30 days", t.calls.toLocaleString("en-US"), `${data.keys.filter((k) => !k.revoked_at).length} active keys`],
          ["Refused or failed", `${rate}%`, `${t.failed.toLocaleString("en-US")} calls`],
          ["Median response", t.p50 === null ? "—" : `${t.p50} ms`, "half answer faster"],
          ["95th percentile", t.p95 === null ? "—" : `${t.p95} ms`, "the slow tail"],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
            <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: INK, letterSpacing: "-0.02em", marginTop: 4, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</div>
            <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{sub}</div>
          </div>
        ))}
      </div>
      <ChartCard title="Calls per day" note="Complete days, Dhaka time. Answered, and refused or failed, stacked."
        legend={[{ color: SERIES_1, label: "Answered" }, { color: SERIES_2, label: "Refused or failed" }]}
        table={<SimpleTable head={["Day", "Answered", "Refused or failed"]} rows={data.days.map((d) => [d.day, d.ok, d.failed])} />}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data.days} margin={{ top: 4, right: 8, bottom: 0, left: -12 }} barCategoryGap={3}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="day" tickFormatter={dm} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} interval={4} />
            <YAxis tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip cursor={{ fill: "#F4F4F5" }} content={<Tip title={(p) => p.day} rows={(p) => [["Answered", p.ok, SERIES_1], ["Refused or failed", p.failed, SERIES_2]]} />} />
            <Bar dataKey="ok" stackId="a" fill={SERIES_1} stroke="#fff" strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="failed" stackId="a" fill={SERIES_2} stroke="#fff" strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <Card title="Recent calls" aside={<Button small onClick={() => void reload()}><RefreshCw size={12} /> Refresh</Button>}>
        <div style={{ maxHeight: 420, overflowY: "auto" }}>
          <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }} data-testid="api-calls">
            <thead><tr style={{ color: MUTED, fontSize: 11.5, textAlign: "left" }}>
              {["When", "Key", "Call", "Answer", "Time", "From"].map((h) => <th key={h} style={{ padding: "6px 8px", fontWeight: 500 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {data.calls.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid #F4F4F5" }}>
                  <td style={{ padding: "7px 8px", whiteSpace: "nowrap", color: "#3F3F46" }}>{fmtWhen(c.created_at)}</td>
                  <td style={{ padding: "7px 8px" }}>{c.key ?? "—"}</td>
                  <td style={{ padding: "7px 8px" }}><code style={mono}><strong>{c.method}</strong> {c.path.length > 70 ? c.path.slice(0, 69) + "…" : c.path}</code></td>
                  <td style={{ padding: "7px 8px" }}>
                    <Pill tone={c.status < 300 ? "green" : c.status < 500 ? "amber" : "red"} title={c.error ?? undefined}>{c.status}</Pill>
                    {c.error && <span style={{ fontSize: 11.5, color: MUTED, marginLeft: 6 }}>{c.error.slice(0, 60)}</span>}
                  </td>
                  <td style={{ padding: "7px 8px", fontVariantNumeric: "tabular-nums" }}>{c.ms ?? "—"} ms</td>
                  <td style={{ padding: "7px 8px", color: MUTED }}>{c.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------
// Migration from ManageEngine
// ---------------------------------------------------------------------
function Migration() {
  const [summary, setSummary] = useState<{ sources: { source: string; n: number; first: string | null; last: string | null }[]; canManage: boolean } | null>(null);
  const [parsed, setParsed] = useState<(LegacyParse & { file: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LegacyImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await legacySummary();
    if (r.ok) setSummary(r);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setParsed({ ...readLegacyFile(text), file: f.name });
    setResult(null);
    if (input.current) input.current.value = "";
  };
  const sample = async () => {
    const r = await sampleLegacyExport();
    if (!r.ok) return void toast.error(r.error);
    downloadCsv("servicedesk-requests-export.csv", legacyCsv(r.rows));
  };
  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    const r = await importLegacyTickets({ data: { source: "ManageEngine", rows: parsed.rows } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setResult(r.result);
    setParsed(null);
    toast.success(`${r.result.imported} tickets imported`);
    await load();
  };
  const settled = useMemo(() => parsed?.rows.filter((r) => /^(closed|resolved|completed|cancel+ed|rejected)$/i.test(r.status ?? "")).length ?? 0, [parsed]);

  return (
    <div style={{ marginTop: 14 }}>
      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)" }}>
        <Card title="Bring closed tickets over from ManageEngine">
          <p style={{ fontSize: 13, color: "#3F3F46", lineHeight: 1.55, marginTop: 0 }}>
            In ServiceDesk Plus, open <strong>Requests</strong>, filter to closed and resolved, and use <strong>Export as CSV</strong>.
            Each settled ticket becomes an archived record here — found by search and by its old reference (<code style={mono}>SR-10237</code> becomes <code style={mono}>ME-SR-10237</code>),
            with its requester matched to the org chart where they still work here. Open tickets are left where they are. Importing the same file twice adds nothing.
          </p>
          {summary?.canManage ? (
            <div className="flex gap-2 flex-wrap">
              <input ref={input} type="file" accept=".csv,text/csv" aria-label="ManageEngine export" style={{ display: "none" }} onChange={(e) => void onFile(e.target.files?.[0])} />
              <Button tone="brand" onClick={() => input.current?.click()}><FileUp size={13} /> Choose an export</Button>
              <Button onClick={() => void sample()}><Download size={13} /> A sample export</Button>
            </div>
          ) : <Notice tone="zinc">Only someone with the Retention and archive permission can migrate records.</Notice>}
        </Card>
        <Card title="Migrated so far">
          {summary?.sources.length ? summary.sources.map((s) => (
            <div key={s.source} className="flex items-baseline justify-between" style={{ fontSize: 13, padding: "6px 0", borderBottom: "1px solid #F4F4F5" }}>
              <span><strong>{s.source}</strong> <span style={{ color: MUTED }}>{s.first?.slice(0, 4)}–{s.last?.slice(0, 4)}</span></span>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }} data-testid={`migrated-${s.source}`}>{s.n.toLocaleString("en-US")} records</span>
            </div>
          )) : <div style={{ color: MUTED, fontSize: 13 }}>Nothing yet.</div>}
          <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>
            Archived, so out of everybody's working lists. <Link to="/submissions" search={{ archived: 1 }} style={{ textDecoration: "underline" }}>See them in the archive</Link> or in the audit centre's retention view.
          </div>
        </Card>
      </div>

      {parsed && (
        <Card title={`${parsed.file} — ${parsed.rows.length} tickets`} aside={
          <Button tone="brand" busy={busy} disabled={parsed.missing.length > 0 || parsed.rows.length === 0} onClick={() => void run()}>Import {settled} settled tickets</Button>
        }>
          {parsed.missing.length > 0 && <Notice tone="red">This export has no {parsed.missing.join(", ")} column — add it to the list view in ServiceDesk and export again.</Notice>}
          <div className="flex flex-wrap gap-1.5 mb-3" style={{ fontSize: 12 }}>
            {Object.entries(parsed.columns).map(([k, v]) => <Pill key={k} tone="brand">{v} → {k}</Pill>)}
          </div>
          <div style={{ fontSize: 12.5, color: "#3F3F46", marginBottom: 8 }}>
            {settled} settled, {parsed.rows.length - settled} still open (left out){parsed.unreadableDates ? `, ${parsed.unreadableDates} with a date that could not be read` : ""}.
          </div>
          <div style={{ maxHeight: 300, overflow: "auto" }}>
            <table className="w-full" style={{ fontSize: 12, borderCollapse: "collapse" }} data-testid="legacy-preview">
              <thead><tr style={{ color: MUTED, textAlign: "left" }}>{["Reference", "Subject", "Requester", "Status", "Created", "Closed"].map((h) => <th key={h} style={{ padding: "5px 8px", fontWeight: 500 }}>{h}</th>)}</tr></thead>
              <tbody>{parsed.rows.slice(0, 50).map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid #F4F4F5" }}>
                  <td style={{ padding: "5px 8px" }}><code style={mono}>{r.ref}</code></td>
                  <td style={{ padding: "5px 8px" }}>{r.subject}</td>
                  <td style={{ padding: "5px 8px" }}>{r.requester}</td>
                  <td style={{ padding: "5px 8px" }}>{r.status}</td>
                  <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{r.created?.slice(0, 10) || <span style={{ color: "#B91C1C" }}>?</span>}</td>
                  <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{r.closed?.slice(0, 10)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}

      {result && (
        <Card title="Imported">
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }} data-testid="legacy-result">
            {[["Imported", result.imported], ["Already here", result.duplicates], ["Still open", result.open], ["Unreadable", result.invalid], ["Requester not found", result.unmatched_requesters]].map(([l, n]) => (
              <div key={l as string}><div style={{ fontSize: 12, color: MUTED }}>{l}</div><div style={{ fontSize: 22, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>{n}</div></div>
            ))}
          </div>
          {result.unmatched_requesters > 0 && <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>A requester who is not in the org chart any more is kept by name on the record.</div>}
          {result.errors.length > 0 && (
            <div className="mt-3" style={{ fontSize: 12.5 }}>
              {result.errors.map((e, i) => <div key={i} className="flex items-center gap-1.5" style={{ color: "#92400E" }}><AlertTriangle size={12} /> Row {e.row}{e.ref ? ` (${e.ref})` : ""} {e.error}</div>)}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

