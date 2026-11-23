import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Megaphone, Search, Sparkles } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { STATUS_STYLE, dmy, money, pace, type Campaign } from "@/lib/campaigns";
import { Bar, Tile } from "@/components/campaigns/Bits";
import { Page } from "@/components/admin/kit";
import { control } from "@/components/reports/ReportParts";

export const Route = createFileRoute("/campaigns/")({
  head: () => ({ meta: [{ title: "Campaigns · Admin Services Portal" }] }),
  component: CampaignsPage,
});

const STATUSES = ["all", "ongoing", "upcoming", "completed", "discontinued", "discarded"] as const;

function CampaignsPage() {
  const { currentUser } = useCurrentUser();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [spent, setSpent] = useState<Record<string, number>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [audience, setAudience] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: cs }, { data: acts }, { data: emps }] = await Promise.all([
        db.from("campaigns").select("*").order("starts_on", { ascending: false }),
        db.from("campaign_actuals").select("campaign_id, cost").limit(5000),
        db.from("employees").select("employee_id, name"),
      ]);
      if (!alive) return;
      const totals: Record<string, number> = {};
      ((acts ?? []) as { campaign_id: string; cost: number }[]).forEach((a) => { totals[a.campaign_id] = (totals[a.campaign_id] ?? 0) + Number(a.cost); });
      setSpent(totals);
      setNames(Object.fromEntries(((emps ?? []) as { employee_id: string; name: string }[]).map((e) => [e.employee_id, e.name])));
      setCampaigns(((cs ?? []) as Campaign[]).map((c) => ({ ...c, budget: Number(c.budget) })));
    })();
    return () => { alive = false; };
  }, [currentUser.employee_id]);

  const shown = useMemo(() => (campaigns ?? []).filter((c) =>
    (status === "all" || c.status === status) && (!audience || c.audience === audience)
    && (!q || c.name.toLowerCase().includes(q.toLowerCase()))), [campaigns, status, audience, q]);

  const live = (campaigns ?? []).filter((c) => c.status === "ongoing");
  const liveBudget = live.reduce((s, c) => s + c.budget, 0);
  const liveSpent = live.reduce((s, c) => s + (spent[c.id] ?? 0), 0);
  const hot = live.filter((c) => (spent[c.id] ?? 0) >= c.budget * 0.95).length;
  const overPace = live.filter((c) => (pace(c, spent[c.id] ?? 0).projected ?? 0) > 100).length;

  return (
    <Page wide title="Campaigns"
      intro="Every campaign approved through an NFA: its KPI targets, what has actually been spent and achieved, and where each is in its life. Requesters are told at 95% of budget.">
      <div className="grid gap-3 mb-5 grid-cols-2 md:grid-cols-5" data-testid="campaign-kpis">
        <Tile label="Live campaigns" value={String(live.length)} />
        <Tile label="Budget, live" value={`BDT ${money(liveBudget)}`} />
        <Tile label="Spent, live" value={`BDT ${money(liveSpent)}`} sub={liveBudget ? `${Math.round((liveSpent / liveBudget) * 100)}% of budget` : undefined} />
        <Tile label="At 95% or more" value={String(hot)} warn={hot > 0} />
        <Tile label="On pace to overspend" value={String(overPace)} warn={overPace > 0} />
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="inline-flex rounded-md flex-wrap" style={{ border: "1px solid #E4E4E7", background: "#fff", padding: 2 }} role="group" aria-label="Status">
          {STATUSES.map((s) => (
            <button key={s} type="button" onClick={() => setStatus(s)} aria-pressed={status === s}
              style={{ padding: "5px 10px", fontSize: 12.5, borderRadius: 5, border: "none", cursor: "pointer",
                background: status === s ? "#18181B" : "transparent", color: status === s ? "#fff" : "#52525B", fontWeight: 500 }}>
              {s === "all" ? "All" : STATUS_STYLE[s].label}
              <span style={{ opacity: 0.6, marginLeft: 5 }}>{s === "all" ? campaigns?.length ?? 0 : (campaigns ?? []).filter((c) => c.status === s).length}</span>
            </button>
          ))}
        </div>
        <select aria-label="Audience" style={control} value={audience} onChange={(e) => setAudience(e.target.value)}>
          <option value="">Every audience</option>
          {[...new Set((campaigns ?? []).map((c) => c.audience).filter(Boolean))].map((a) => <option key={a!} value={a!}>{a}</option>)}
        </select>
        <span className="inline-flex items-center gap-1" style={{ ...control, padding: "0 8px", marginLeft: "auto" }}>
          <Search size={13} style={{ color: "#A1A1AA" }} />
          <input aria-label="Find a campaign" placeholder="Find a campaign" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ border: "none", outline: "none", padding: "6px 0", fontSize: 12.5, width: 180, background: "transparent" }} />
        </span>
      </div>

      <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7" }} data-testid="campaign-list">
        {shown.map((c, i) => {
          const s = spent[c.id] ?? 0;
          const p = pace(c, s);
          const st = STATUS_STYLE[c.status];
          const over95 = p.pct >= 95;
          return (
            <Link key={c.id} to="/campaigns/$campaignId" params={{ campaignId: c.id }}
              className="grid items-center gap-4 hover:bg-zinc-50"
              style={{ gridTemplateColumns: "minmax(0,2.2fr) 110px minmax(0,1.6fr) minmax(0,1fr)", padding: "14px 16px",
                       borderTop: i ? "1px solid #F4F4F5" : undefined, textDecoration: "none", color: "inherit" }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }} className="truncate">{c.name}</span>
                  {c.exceptional && (
                    <span className="inline-flex items-center gap-1 rounded-full" title="Approved on the exceptional route, CXO first"
                      style={{ padding: "1px 7px", fontSize: 10.5, fontWeight: 600, background: "#FDF2F8", color: "#BE185D", border: "1px solid #FBCFE8" }}>
                      <Sparkles size={10} /> Exceptional
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>
                  {c.modality} · {c.audience} · {dmy(c.starts_on)} – {dmy(c.ends_on)} · {names[c.requester_id ?? ""] ?? c.requester_id}
                </div>
              </div>
              <span className="rounded-full justify-self-start" style={{ padding: "2px 9px", fontSize: 11.5, fontWeight: 500, background: st.bg, color: st.fg, border: `1px solid ${st.bd}` }}>{st.label}</span>
              <div>
                <div className="flex justify-between" style={{ fontSize: 11.5, color: "#52525B", marginBottom: 4 }}>
                  <span>BDT {money(s)} of {money(c.budget)}</span>
                  <span style={{ fontWeight: 600, color: over95 ? "#B45309" : "#3F3F46" }} className="inline-flex items-center gap-1">
                    {over95 && <AlertTriangle size={11} />}{Math.round(p.pct)}%
                  </span>
                </div>
                <Bar pct={p.pct} />
              </div>
              <div style={{ fontSize: 12, color: "#71717A", textAlign: "right" }}>
                {c.status === "ongoing" && p.projected !== null ? (
                  <span style={{ color: p.projected > 100 ? "#B91C1C" : "#52525B" }}>
                    On pace for <strong>{Math.round(p.projected)}%</strong><br />{p.daysLeft} days left
                  </span>
                ) : c.status === "upcoming" ? <>Starts {dmy(c.starts_on)}</> : c.status_note ?? <>Ended {dmy(c.ends_on)}</>}
              </div>
            </Link>
          );
        })}
        {campaigns && shown.length === 0 && (
          <div className="flex flex-col items-center" style={{ padding: "48px 20px", color: "#A1A1AA", fontSize: 13 }}>
            <Megaphone size={22} style={{ marginBottom: 8 }} /> No campaigns match.
          </div>
        )}
        {!campaigns && <div style={{ padding: 20, color: "#A1A1AA", fontSize: 13 }}>Loading…</div>}
      </div>
    </Page>
  );
}

