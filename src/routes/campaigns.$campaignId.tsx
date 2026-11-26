import { createFileRoute, Link } from "@tanstack/react-router";
import { setCrumbLabel } from "@/lib/crumb";
import { DateInput } from "@/components/DateInput";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, ArrowLeft, CalendarPlus, FileSpreadsheet, PauseCircle, Plus, Sparkles, Ticket } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { STATUS_STYLE, dmy, money, pace, type Campaign } from "@/lib/campaigns";
import { parseCsv } from "@/lib/hr-file";
import { Bar, Tile } from "@/components/campaigns/Bits";
import { Button, Card, Field, Notice, Pill, inputStyle } from "@/components/admin/kit";

export const Route = createFileRoute("/campaigns/$campaignId")({
  head: () => ({ meta: [{ title: "Campaign · Admin Services Portal" }] }),
  component: CampaignPage,
});

type Actual = { id: string; on_date: string; cost: number; beneficiaries: number | null; transactions: number | null; volume: number | null; note: string | null; recorded_by: string | null };
type Coupon = { code: string; wallet: string | null; amount: number | null; issued_at: string | null; redeemed_at: string | null; redeemed_via: string | null };
type Extension = { id: string; submission_id: string | null; new_ends_on: string; added_budget: number; business_case: string | null; status: string; requested_by: string | null; created_at: string };

// One series, the first categorical slot (validated in Stage 4).
const SERIES = "#2a78d6";

function CampaignPage() {
  const { campaignId } = Route.useParams();
  const { currentUser, can } = useCurrentUser();
  const [c, setC] = useState<Campaign | null>(null);
  const [actuals, setActuals] = useState<Actual[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [exts, setExts] = useState<Extension[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [nfaRef, setNfaRef] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "actuals" | "extend" | "status" | "coupons">("none");

  const load = useCallback(async () => {
    const [{ data: cs }, { data: acts }, { data: cps }, { data: xs }, { data: emps }] = await Promise.all([
      db.from("campaigns").select("*").eq("id", campaignId).maybeSingle(),
      db.from("campaign_actuals").select("*").eq("campaign_id", campaignId).order("on_date"),
      db.from("campaign_coupons").select("code, wallet, amount, issued_at, redeemed_at, redeemed_via").eq("campaign_id", campaignId).limit(5000),
      db.from("campaign_extensions").select("*").eq("campaign_id", campaignId).order("created_at", { ascending: false }),
      db.from("employees").select("employee_id, name"),
    ]);
    const camp = cs as Campaign | null;
    if (camp) camp.budget = Number(camp.budget);
    setC(camp);
    if (camp) setCrumbLabel(`/campaigns/${camp.id}`, camp.name);
    setActuals(((acts ?? []) as Actual[]).map((a) => ({ ...a, cost: Number(a.cost), volume: a.volume === null ? null : Number(a.volume) })));
    setCoupons((cps ?? []) as Coupon[]);
    setExts((xs ?? []) as Extension[]);
    setNames(Object.fromEntries(((emps ?? []) as { employee_id: string; name: string }[]).map((e) => [e.employee_id, e.name])));
    if (camp?.submission_id) {
      const { data: s } = await db.from("form_submissions").select("ref_number").eq("id", camp.submission_id).maybeSingle();
      setNfaRef((s as { ref_number: string } | null)?.ref_number ?? null);
    }
  }, [campaignId]);
  useEffect(() => { void load(); }, [load, currentUser.employee_id]);

  const spent = actuals.reduce((s, a) => s + a.cost, 0);
  const totals = useMemo(() => ({
    beneficiaries: actuals.reduce((s, a) => s + (a.beneficiaries ?? 0), 0),
    transactions: actuals.reduce((s, a) => s + (a.transactions ?? 0), 0),
    volume: actuals.reduce((s, a) => s + (a.volume ?? 0), 0),
  }), [actuals]);
  const burn = useMemo(() => {
    let run = 0;
    return actuals.map((a) => ({ date: a.on_date, spent: (run += a.cost) }));
  }, [actuals]);

  if (!c) return <div className="mx-auto" style={{ maxWidth: 1280, padding: 28, color: "#A1A1AA", fontSize: 13 }}>Loading…</div>;

  const p = pace(c, spent);
  const st = STATUS_STYLE[c.status];
  const mine = currentUser.employee_id === c.requester_id || currentUser.employee_id === c.reviewer_id || can("reports.manage");
  const live = c.status === "ongoing" || c.status === "upcoming";
  const pending = exts.find((x) => x.status === "pending");

  const kpis: { key: string; label: string; target: number | undefined; actual: number; unit?: string }[] = [
    { key: "beneficiaries", label: "Beneficiaries", target: c.kpi.beneficiaries, actual: totals.beneficiaries },
    { key: "transactions", label: "Transactions", target: c.kpi.transactions, actual: totals.transactions },
    { key: "volume", label: "Transaction volume", target: c.kpi.volume, actual: totals.volume, unit: "BDT" },
    { key: "total_cost", label: "Cost", target: c.kpi.total_cost ?? c.budget, actual: spent, unit: "BDT" },
  ];

  return (
    <div className="mx-auto" style={{ maxWidth: 1280, padding: "24px 28px 56px" }}>
      <Link to="/campaigns" className="inline-flex items-center gap-1" style={{ fontSize: 12.5, color: "#71717A", textDecoration: "none", marginBottom: 10 }}>
        <ArrowLeft size={13} /> Campaigns
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }} data-testid="campaign-name">{c.name}</h1>
            <span className="rounded-full" data-testid="campaign-status" style={{ padding: "2px 10px", fontSize: 12, fontWeight: 500, background: st.bg, color: st.fg, border: `1px solid ${st.bd}` }}>{st.label}</span>
            {c.exceptional && (
              <span className="inline-flex items-center gap-1 rounded-full" style={{ padding: "2px 9px", fontSize: 11.5, fontWeight: 600, background: "#FDF2F8", color: "#BE185D", border: "1px solid #FBCFE8" }}>
                <Sparkles size={11} /> Exceptional approval
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "#71717A", marginTop: 6 }}>
            {c.modality} for {c.audience?.toLowerCase()}s · {c.product} · {dmy(c.starts_on)} – {dmy(c.ends_on)}
            {nfaRef && c.submission_id && <> · NFA <Link to="/status/$submissionId" params={{ submissionId: c.submission_id }} style={{ color: "#4F46E5" }}>{nfaRef}</Link></>}
          </div>
          <div style={{ fontSize: 12.5, color: "#52525B", marginTop: 4 }}>
            Requested by <strong>{names[c.requester_id ?? ""] ?? "—"}</strong> · reviewed by <strong>{names[c.reviewer_id ?? ""] ?? "—"}</strong>
          </div>
        </div>
        {mine && (
          <div className="flex gap-2 flex-wrap">
            {c.status !== "upcoming" && c.status !== "discarded" && <Button tone="brand" name="record-actuals" onClick={() => setPanel(panel === "actuals" ? "none" : "actuals")}><Plus size={14} /> Record actuals</Button>}
            {live && !pending && <Button name="extend" onClick={() => setPanel(panel === "extend" ? "none" : "extend")}><CalendarPlus size={14} /> Extend</Button>}
            {c.coupon && <Button onClick={() => setPanel(panel === "coupons" ? "none" : "coupons")}><Ticket size={14} /> Import coupons</Button>}
            {live && <Button onClick={() => setPanel(panel === "status" ? "none" : "status")}><PauseCircle size={14} /> Status</Button>}
          </div>
        )}
      </div>

      {c.status_note && <Notice tone="zinc">{c.status_note}</Notice>}
      {p.pct >= 95 && (
        <Notice tone={p.pct >= 100 ? "red" : "amber"}>
          <span className="inline-flex items-center gap-1.5"><AlertTriangle size={14} />
            <strong>{Math.round(p.pct * 10) / 10}% of the budget is spent.</strong>
            {c.alerted["95"] && ` ${names[c.requester_id ?? ""] ?? "The requester"} was told on ${dmy(c.alerted["95"].slice(0, 10))}.`}
          </span>
        </Notice>
      )}
      {pending && (
        <Notice tone="amber">
          An extension to <strong>{dmy(pending.new_ends_on)}</strong>{pending.added_budget ? <> with BDT {money(Number(pending.added_budget))} more</> : null} is waiting for approval.{" "}
          {pending.submission_id && <Link to="/status/$submissionId" params={{ submissionId: pending.submission_id }} style={{ color: "#92400E", fontWeight: 600 }}>See its approvals</Link>}
        </Notice>
      )}

      {panel === "actuals" && <ActualsForm campaign={c} onDone={async () => { setPanel("none"); await load(); }} />}
      {panel === "extend" && <ExtendForm campaign={c} onDone={async () => { setPanel("none"); await load(); }} />}
      {panel === "status" && <StatusForm campaign={c} onDone={async () => { setPanel("none"); await load(); }} />}
      {panel === "coupons" && <CouponImport campaign={c} onDone={async () => { setPanel("none"); await load(); }} />}

      <div className="grid gap-3 mb-4 grid-cols-2 md:grid-cols-4" data-testid="campaign-budget">
        <Tile label="Budget" value={`BDT ${money(c.budget)}`} />
        <Tile label="Spent" value={`BDT ${money(spent)}`} sub={`${Math.round(p.pct * 10) / 10}% of budget`} warn={p.pct >= 95} />
        <Tile label="Run rate" value={`BDT ${money(Math.round(p.runRate))}/day`} sub={`${p.elapsed} of ${p.length} days run`} />
        <Tile label={c.status === "ongoing" ? "On pace for" : "Days left"} value={c.status === "ongoing" && p.projected !== null ? `${Math.round(p.projected)}%` : String(p.daysLeft)}
          sub={c.status === "ongoing" ? `of budget by ${dmy(c.ends_on)}` : undefined} warn={(p.projected ?? 0) > 100} />
      </div>

      <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)" }}>
        <Card title="Spending against budget" style={{ marginBottom: 0 }}>
          {burn.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={burn} margin={{ top: 14, right: 16, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="#F1F1F3" />
                <XAxis dataKey="date" tickFormatter={(d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`} tick={{ fontSize: 11, fill: "#A1A1AA" }} axisLine={{ stroke: "#E4E4E7" }} tickLine={false} minTickGap={24} />
                <YAxis domain={[0, Math.max(c.budget * 1.05, spent * 1.05)]} tickFormatter={(v: number) => money(v).replace(" ", "\u00a0")} tick={{ fontSize: 11, fill: "#A1A1AA" }} axisLine={false} tickLine={false} width={72} />
                <ReferenceLine y={c.budget} stroke="#18181B" strokeWidth={1} label={{ value: "Budget", position: "insideBottomLeft", fontSize: 11, fill: "#3F3F46" }} />
                <ReferenceLine y={c.budget * 0.95} stroke="#D97706" strokeWidth={1} label={{ value: "95% of budget", position: "insideTopLeft", fontSize: 11, fill: "#B45309" }} />
                <Tooltip cursor={{ stroke: "#D4D4D8" }} content={({ active, payload }) => active && payload?.length ? (
                  <div className="rounded-lg" style={{ background: "#fff", border: "1px solid #E4E4E7", padding: "8px 10px", fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,.08)" }}>
                    <div style={{ fontWeight: 600 }}>{dmy(String(payload[0].payload.date))}</div>
                    <div>Spent to date: <strong>BDT {Number(payload[0].payload.spent).toLocaleString("en-US")}</strong></div>
                    <div style={{ color: "#71717A" }}>{Math.round((Number(payload[0].payload.spent) / c.budget) * 1000) / 10}% of budget</div>
                  </div>) : null} />
                <Line type="linear" dataKey="spent" stroke={SERIES} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : <div style={{ padding: "40px 0", textAlign: "center", fontSize: 13, color: "#A1A1AA" }}>Nothing spent yet.</div>}
        </Card>

        <Card title="KPI: target and actual" style={{ marginBottom: 0 }}>
          <div className="flex flex-col gap-3.5" data-testid="campaign-kpi">
            {kpis.map((k) => {
              const pct = k.target ? (k.actual / k.target) * 100 : 0;
              return (
                <div key={k.key}>
                  <div className="flex justify-between" style={{ fontSize: 12.5, marginBottom: 4 }}>
                    <span style={{ color: "#3F3F46" }}>{k.label}</span>
                    <span style={{ color: "#71717A", fontVariantNumeric: "tabular-nums" }}>
                      <strong style={{ color: "#18181B" }}>{k.unit ? `${k.unit} ` : ""}{money(Math.round(k.actual))}</strong> of {k.target ? money(k.target) : "—"}
                      <span style={{ marginLeft: 6 }}>({Math.round(pct)}%)</span>
                    </span>
                  </div>
                  <Bar pct={k.key === "total_cost" ? pct : Math.min(pct, 100)} height={6} budget={k.key === "total_cost"} />
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)" }}>
        <Card title="Reporting section" style={{ marginBottom: 0 }}>
          <dl className="grid gap-y-2" style={{ gridTemplateColumns: "120px 1fr", fontSize: 13, margin: 0 }}>
            <dt style={{ color: "#71717A" }}>Modality</dt><dd style={{ margin: 0 }}>{c.modality ?? "—"}</dd>
            <dt style={{ color: "#71717A" }}>Cost center</dt><dd style={{ margin: 0 }}>{c.cost_center ?? "—"}</dd>
            <dt style={{ color: "#71717A" }}>GL code</dt><dd style={{ margin: 0 }}>{c.gl_code ?? "—"}</dd>
            <dt style={{ color: "#71717A" }}>Product</dt><dd style={{ margin: 0 }}>{c.product ?? "—"}</dd>
            <dt style={{ color: "#71717A" }}>Beneficiary</dt><dd style={{ margin: 0 }}>{c.beneficiary ?? "—"}</dd>
          </dl>
          <div style={{ fontSize: 12, color: "#71717A", margin: "14px 0 6px" }}>Wallet-wise budget</div>
          {c.wallets.map((w) => (
            <div key={w.wallet} className="flex justify-between" style={{ fontSize: 13, padding: "4px 0", borderTop: "1px solid #F4F4F5" }}>
              <span>{w.wallet}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>BDT {Number(w.budget).toLocaleString("en-US")}</span>
            </div>
          ))}
        </Card>

        <Card title={`Actuals (${actuals.length})`} style={{ marginBottom: 0 }}>
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }} data-testid="campaign-actuals">
              <thead><tr style={{ color: "#71717A", textAlign: "left" }}>
                <th style={th}>Date</th><th style={{ ...th, textAlign: "right" }}>Cost</th><th style={{ ...th, textAlign: "right" }}>Beneficiaries</th>
                <th style={{ ...th, textAlign: "right" }}>Transactions</th><th style={th}>Recorded by</th>
              </tr></thead>
              <tbody>
                {[...actuals].reverse().map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid #F4F4F5" }}>
                    <td style={td}>{dmy(a.on_date)}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.cost.toLocaleString("en-US")}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.beneficiaries?.toLocaleString("en-US") ?? "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.transactions?.toLocaleString("en-US") ?? "—"}</td>
                    <td style={{ ...td, color: "#71717A" }}>{names[a.recorded_by ?? ""] ?? a.recorded_by ?? "—"}{a.note ? ` · ${a.note}` : ""}</td>
                  </tr>
                ))}
                {!actuals.length && <tr><td colSpan={5} style={{ ...td, color: "#A1A1AA" }}>Nothing recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {c.coupon && <Coupons coupons={coupons} />}

      {exts.length > 0 && (
        <Card title="Extensions">
          {exts.map((x) => (
            <div key={x.id} className="flex items-center gap-3 flex-wrap" style={{ fontSize: 13, padding: "8px 0", borderTop: "1px solid #F4F4F5" }}>
              <Pill tone={x.status === "approved" ? "green" : x.status === "rejected" ? "red" : "amber"}>{x.status}</Pill>
              <span>To <strong>{dmy(x.new_ends_on)}</strong>{Number(x.added_budget) ? <>, BDT {money(Number(x.added_budget))} more</> : null}</span>
              <span style={{ color: "#71717A", flex: 1, minWidth: 200 }} className="truncate">{x.business_case}</span>
              {x.submission_id && <Link to="/status/$submissionId" params={{ submissionId: x.submission_id }} style={{ color: "#4F46E5", fontSize: 12.5 }}>Approvals</Link>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 500, fontSize: 11.5 };
const td: React.CSSProperties = { padding: "7px 8px", color: "#27272A" };

function Coupons({ coupons }: { coupons: Coupon[] }) {
  const redeemed = coupons.filter((k) => k.redeemed_at);
  const byService = ["App", "USSD", "Agent", "Merchant"].map((s) => ({ s, n: redeemed.filter((k) => k.redeemed_via === s).length })).filter((x) => x.n);
  const max = Math.max(1, ...byService.map((b) => b.n));
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Ticket size={15} /> Coupons</span>}>
      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)" }} data-testid="campaign-coupons">
        <div>
          <div className="flex gap-6" style={{ marginBottom: 14 }}>
            <div><div style={{ fontSize: 11.5, color: "#71717A" }}>Issued</div><div style={{ fontSize: 22, fontWeight: 700 }}>{coupons.length.toLocaleString()}</div></div>
            <div><div style={{ fontSize: 11.5, color: "#71717A" }}>Redeemed</div><div style={{ fontSize: 22, fontWeight: 700 }}>{redeemed.length.toLocaleString()}</div></div>
            <div><div style={{ fontSize: 11.5, color: "#71717A" }}>Rate</div><div style={{ fontSize: 22, fontWeight: 700 }}>{coupons.length ? Math.round((redeemed.length / coupons.length) * 100) : 0}%</div></div>
          </div>
          <div style={{ fontSize: 12, color: "#71717A", marginBottom: 6 }}>Redeemed through</div>
          {byService.map((b) => (
            <div key={b.s} className="flex items-center gap-2" style={{ fontSize: 12.5, marginBottom: 6 }}>
              <span style={{ width: 70 }}>{b.s}</span>
              <div style={{ flex: 1, height: 14, background: "#F4F4F5", borderRadius: 4 }}>
                <div style={{ width: `${(b.n / max) * 100}%`, height: 14, background: SERIES, borderRadius: 4 }} />
              </div>
              <span style={{ width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{b.n}</span>
            </div>
          ))}
        </div>
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          <table className="w-full" style={{ fontSize: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ color: "#71717A", textAlign: "left" }}><th style={th}>Code</th><th style={th}>Wallet</th><th style={th}>Redeemed</th><th style={th}>Via</th></tr></thead>
            <tbody>
              {coupons.slice(0, 200).map((k) => (
                <tr key={k.code} style={{ borderTop: "1px solid #F4F4F5" }}>
                  <td style={{ ...td, fontFamily: "JetBrains Mono, monospace" }}>{k.code}</td>
                  <td style={td}>{k.wallet ? k.wallet.replace(/^(\d{3})\d+(\d{3})$/, "$1•••••$2") : "—"}</td>
                  <td style={td}>{k.redeemed_at ? dmy(k.redeemed_at.slice(0, 10)) : <span style={{ color: "#A1A1AA" }}>not yet</span>}</td>
                  <td style={td}>{k.redeemed_via ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function ActualsForm({ campaign, onDone }: { campaign: Campaign; onDone: () => Promise<void> }) {
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [cost, setCost] = useState("");
  const [ben, setBen] = useState("");
  const [tx, setTx] = useState("");
  const [vol, setVol] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const n = (v: string) => (v.trim() === "" ? null : Number(v.replace(/,/g, "")));
  return (
    <Card title="Record actuals">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
        <Field label="Day"><DateInput name="actual-date" style={inputStyle} value={on} max={new Date().toISOString().slice(0, 10)} onChange={(iso) => setOn(iso)} /></Field>
        <Field label="Cost (BDT)"><input name="actual-cost" inputMode="decimal" style={inputStyle} value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
        <Field label="Beneficiaries"><input inputMode="numeric" style={inputStyle} value={ben} onChange={(e) => setBen(e.target.value)} /></Field>
        <Field label="Transactions"><input inputMode="numeric" style={inputStyle} value={tx} onChange={(e) => setTx(e.target.value)} /></Field>
        <Field label="Volume (BDT)"><input inputMode="decimal" style={inputStyle} value={vol} onChange={(e) => setVol(e.target.value)} /></Field>
      </div>
      <div className="flex gap-3 items-end" style={{ marginTop: 10 }}>
        <div style={{ flex: 1 }}><Field label="Note"><input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        <Button tone="brand" busy={busy} disabled={!cost} name="save-actuals" onClick={async () => {
          setBusy(true);
          const { error } = await db.rpc("record_campaign_actuals", {
            p_campaign: campaign.id, p_on_date: on, p_cost: n(cost), p_beneficiaries: n(ben), p_transactions: n(tx), p_volume: n(vol), p_note: note || null,
          });
          setBusy(false);
          if (error) return void toast.error(error.message);
          toast.success("Recorded");
          await onDone();
        }}>Save</Button>
      </div>
    </Card>
  );
}

function ExtendForm({ campaign, onDone }: { campaign: Campaign; onDone: () => Promise<void> }) {
  const [end, setEnd] = useState("");
  const [budget, setBudget] = useState("");
  const [caseText, setCaseText] = useState("");
  const [route, setRoute] = useState("Regular");
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Extend this campaign">
      <p style={{ fontSize: 13, color: "#52525B", margin: "0 0 12px" }}>
        An extension keeps the modality it was approved with ({campaign.modality}). The updated business case goes to Business Finance, and the
        extension follows the regular or the exceptional approval route like the original.
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <Field label={`New end date (now ${dmy(campaign.ends_on)})`}><DateInput name="extend-end" style={inputStyle} min={campaign.ends_on} value={end} onChange={(iso) => setEnd(iso)} /></Field>
        <Field label="Additional budget (BDT)"><input name="extend-budget" inputMode="decimal" style={inputStyle} value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
        <Field label="Approval route">
          <select style={inputStyle} value={route} onChange={(e) => setRoute(e.target.value)}><option>Regular</option><option>Exceptional</option></select>
        </Field>
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label="Updated business case"><textarea name="extend-case" rows={3} style={{ ...inputStyle, resize: "vertical" }} value={caseText} onChange={(e) => setCaseText(e.target.value)} /></Field>
      </div>
      <div style={{ marginTop: 10 }}>
        <Button tone="brand" busy={busy} disabled={!end || !caseText.trim()} name="send-extension" onClick={async () => {
          setBusy(true);
          const { error } = await db.rpc("request_campaign_extension", {
            p_campaign: campaign.id, p_new_ends_on: end, p_added_budget: Number(budget.replace(/,/g, "")) || 0, p_business_case: caseText, p_route: route,
          });
          setBusy(false);
          if (error) return void toast.error(error.message);
          toast.success("Extension sent for approval");
          await onDone();
        }}>Send for approval</Button>
      </div>
    </Card>
  );
}

function StatusForm({ campaign, onDone }: { campaign: Campaign; onDone: () => Promise<void> }) {
  const [status, setStatus] = useState<Campaign["status"]>(campaign.status === "upcoming" ? "discarded" : "discontinued");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Change its status">
      <div className="flex gap-3 items-end flex-wrap">
        <Field label="Status">
          <select name="campaign-status" style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value as Campaign["status"])}>
            {campaign.status === "upcoming" && <option value="discarded">Discarded — it will not run</option>}
            {campaign.status === "ongoing" && <option value="discontinued">Discontinued — stopped early</option>}
            {campaign.status === "ongoing" && <option value="completed">Completed</option>}
          </select>
        </Field>
        <div style={{ flex: 1, minWidth: 240 }}><Field label="Why"><input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        <Button tone="danger" busy={busy} onClick={async () => {
          setBusy(true);
          const { error } = await db.rpc("set_campaign_status", { p_campaign: campaign.id, p_status: status, p_note: note || null });
          setBusy(false);
          if (error) return void toast.error(error.message);
          toast.success("Status changed");
          await onDone();
        }}>Change</Button>
      </div>
    </Card>
  );
}

function CouponImport({ campaign, onDone }: { campaign: Campaign; onDone: () => Promise<void> }) {
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><FileSpreadsheet size={15} /> Import coupon records</span>}>
      <p style={{ fontSize: 13, color: "#52525B", margin: "0 0 10px" }}>
        A CSV from the redemption services, with columns <code>code</code>, <code>wallet</code>, <code>amount</code>, <code>issued_on</code>,
        <code> redeemed_on</code> and <code>redeemed_via</code> (App, USSD, Agent or Merchant). A code already recorded is updated.
      </p>
      <label className="inline-flex items-center gap-2 rounded-md font-medium" style={{ padding: "7px 12px", fontSize: 13, border: "1px solid #E4E4E7", background: "#fff", color: "#3F3F46", cursor: "pointer" }}>
      <FileSpreadsheet size={13} /> {fileName ?? "Choose a CSV"}
      <input type="file" accept=".csv" aria-label="Coupon file" style={{ display: "none" }} onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        setFileName(f.name);
        const [head, ...body] = parseCsv(await f.text());
        const keys = (head ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
        setRows(body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""]))));
      }} />
      </label>
      {rows && (
        <div className="flex items-center gap-3" style={{ marginTop: 10 }}>
          <span style={{ fontSize: 13 }}>{rows.length} coupons in the file.</span>
          <Button tone="brand" busy={busy} onClick={async () => {
            setBusy(true);
            const { data, error } = await db.rpc("import_coupons", { p_campaign: campaign.id, p_rows: JSON.stringify(rows) });
            setBusy(false);
            if (error) return void toast.error(error.message);
            const r = data as { imported: number; skipped: number };
            toast.success(`${r.imported} imported${r.skipped ? `, ${r.skipped} skipped` : ""}`);
            await onDone();
          }}>Import</Button>
        </div>
      )}
    </Card>
  );
}

