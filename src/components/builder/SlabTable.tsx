// =====================================================================
// The amount bands, from the table that actually routes them.
//
// There were two hardcoded copies of this, and they disagreed with each
// other and with the database: one said the top band ended at 2,000,000
// and the next was "Board Approval", the other said 20,00,000 and "Board
// Committee", and approval_slabs said neither — its top band is
// unbounded and ends at the CFO. Enter three million and the interface
// named a committee while the routing sent it to the CFO.
//
// So there is one of these now and it reads the rows that do the
// routing. If a band is wrong on screen it is because the data is wrong,
// which is a thing somebody can fix.
//
// Bands are cumulative: a claim crosses every threshold below it, so
// 620,000 involves all three approvers rather than only the top one.
// That is what app.slab_approvers does, and what this says.
// =====================================================================

import { useEffect, useState } from "react";
import { DollarSign } from "lucide-react";
import { db } from "@/lib/db";

type Slab = {
  min_amount: string | number;
  max_amount: string | number | null;
  approver_user_id: string;
  order_index: number;
  name?: string;
  designation?: string | null;
};

const money = (v: string | number | null) =>
  v === null || v === undefined
    ? "no upper limit"
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

export function useSlabs(formTemplateId: string | null | undefined) {
  const [slabs, setSlabs] = useState<Slab[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!formTemplateId) {
        if (!cancelled) { setSlabs([]); setLoading(false); }
        return;
      }
      setLoading(true);
      const { data } = await db
        .from("approval_slabs")
        .select("min_amount, max_amount, approver_user_id, order_index")
        .eq("form_template_id", formTemplateId)
        .order("order_index");
      const rows = (data ?? []) as Slab[];

      // Names live on employees, so the band can say who rather than
      // which identifier.
      const ids = Array.from(new Set(rows.map((r) => r.approver_user_id).filter(Boolean)));
      if (ids.length) {
        const { data: emps } = await db
          .from("employees")
          .select("employee_id, name, designation")
          .in("employee_id", ids);
        const byId: Record<string, { name: string; designation: string | null }> = {};
        (emps ?? []).forEach((e) => { byId[e.employee_id] = { name: e.name, designation: e.designation }; });
        rows.forEach((r) => {
          r.name = byId[r.approver_user_id]?.name;
          r.designation = byId[r.approver_user_id]?.designation ?? null;
        });
      }
      if (!cancelled) { setSlabs(rows); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [formTemplateId]);

  return { slabs, loading };
}

/** The bordered table, shown beside a money field's configuration. */
export function SlabTable({ formTemplateId }: { formTemplateId?: string | null }) {
  const { slabs, loading } = useSlabs(formTemplateId);

  return (
    <div style={{ padding: "12px 16px 16px" }}>
      <p style={{ fontSize: 11.5, color: "#71717A", lineHeight: 1.45, margin: "0 0 12px" }}>
        The amount decides which finance approvers join the chain. Bands are cumulative —
        an amount crosses every band below it, and each one is a separate approval.
      </p>

      {loading ? (
        <p style={{ fontSize: 11.5, color: "#A1A1AA", margin: 0 }}>Loading bands…</p>
      ) : slabs.length === 0 ? (
        <p style={{ fontSize: 11.5, color: "#A1A1AA", margin: 0 }}>
          No amount bands are configured for this form, so no finance approver is added
          automatically.
        </p>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #E4E4E7" }}>
          <div
            className="grid uppercase font-semibold"
            style={{ gridTemplateColumns: "1fr 1fr 1.4fr", background: "#FAFAFA", borderBottom: "1px solid #E4E4E7", padding: "8px 10px", fontSize: 10, letterSpacing: "0.06em", color: "#71717A", gap: 8 }}
          >
            <span>From</span>
            <span>Applies</span>
            <span>Approver</span>
          </div>
          {slabs.map((s, i) => (
            <div
              key={s.order_index}
              className="grid items-center"
              style={{ gridTemplateColumns: "1fr 1fr 1.4fr", padding: "10px 10px", gap: 8, borderBottom: i === slabs.length - 1 ? "none" : "1px solid #F4F4F5", fontSize: 11.5 }}
            >
              <span className="font-mono" style={{ color: "#3F3F46" }}>{money(s.min_amount)}</span>
              <span style={{ color: "#71717A" }}>and above</span>
              <div>
                <div className="font-medium" style={{ color: "#18181B" }}>
                  {s.name ?? s.approver_user_id}
                </div>
                <div style={{ color: "#A1A1AA", fontSize: 10.5 }}>{s.designation ?? "—"}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The amber callout, shown against a slab-driven approver. */
export function SlabBreakdown({ formTemplateId }: { formTemplateId?: string | null }) {
  const { slabs, loading } = useSlabs(formTemplateId);

  return (
    <div className="rounded-lg overflow-hidden mt-3" style={{ border: "1px solid #FDE68A", background: "#FFFBEB" }}>
      <div className="flex items-center gap-2" style={{ padding: "8px 12px", borderBottom: "1px solid #FDE68A" }}>
        <DollarSign size={12} style={{ color: "#B45309" }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "#B45309", letterSpacing: "0.04em" }}>
          AMOUNT BANDS
        </span>
      </div>
      <div style={{ padding: "8px 12px" }}>
        {loading ? (
          <div style={{ fontSize: 11, color: "#B45309" }}>Loading…</div>
        ) : slabs.length === 0 ? (
          <div style={{ fontSize: 11, color: "#B45309" }}>None configured for this form.</div>
        ) : (
          slabs.map((s) => (
            <div
              key={s.order_index}
              className="flex items-baseline justify-between gap-3"
              style={{ fontSize: 11, color: "#78350F", padding: "3px 0" }}
            >
              <span className="font-mono">
                {money(s.min_amount)} and above
              </span>
              <span style={{ fontWeight: 500 }}>{s.name ?? s.approver_user_id}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
