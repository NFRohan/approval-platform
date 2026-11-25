// =====================================================================
// The search box in the top bar.
//
// It was an <input> with no value, no onChange and no handler, next to a
// badge advertising a keyboard shortcut that did nothing. Two lies in
// about forty pixels, and the first thing anyone tries.
//
// It searches what the placeholder claims: submissions — by the values
// inside them, so a person's name finds their claim — plus forms,
// people, notices and maintenance. Every result goes
// somewhere real. A person opens the activity log filtered to them,
// which is the honest answer to "what has this person been doing" and
// the only page that can answer it.
// =====================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { db } from "@/lib/db";
import { searchDocuments, type TaggedDocument } from "@/lib/attachment-fn";

type Hit = {
  key: string;
  group: string;
  label: string;
  sub?: string;
  go: () => void;
};

const MIN_CHARS = 2;
const DEBOUNCE_MS = 220;
const PER_GROUP = 4;

export function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl-K still jumps to the search box; the badge is gone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Clicking anywhere else closes it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const run = useCallback(async (q: string) => {
    // % and _ are wildcards to LIKE, so an unescaped query means typing
    // "%" matched every row in six tables and "a_ex" found "Alex".
    // Backslash is the default escape character, so escaping is enough
    // and no ESCAPE clause is needed.
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    setBusy(true);

    const [forms, values, people, notices, maint, refs, docs] = await Promise.all([
      // Forms by name or by their keywords — "some keywords that will
      // identify the appropriate templates". There are few enough to
      // match here rather than in the query.
      db.from("form_templates").select("id, name, category, keywords").eq("status", "published").limit(200),
      db.from("submission_values").select("submission_id, field_name, value").ilike("value", like).limit(8),
      db.from("employees").select("employee_id, name, designation, department").ilike("name", like).limit(PER_GROUP),
      db.from("notices").select("id, title, category").ilike("title", like).limit(PER_GROUP),
      db.from("maintenance_requests").select("id, ref_number, location, status").ilike("ref_number", like).limit(PER_GROUP),
      // A request by its reference — how audit and compliance ask for one.
      db.from("form_submissions").select("id").ilike("ref_number", like).limit(PER_GROUP),
      // Documents by tag, description or name.
      searchDocuments({ data: { query: q } }).catch(() => [] as TaggedDocument[]),
    ]);

    const out: Hit[] = [];

    const term = q.trim().toLowerCase();
    const formHits = ((forms.data ?? []) as { id: string; name: string; category: string | null; keywords: string[] | null }[])
      .map((f) => ({ f, kw: (f.keywords ?? []).find((k) => k.toLowerCase().includes(term) || term.includes(k.toLowerCase())) }))
      .filter(({ f, kw }) => f.name.toLowerCase().includes(term) || kw)
      .slice(0, PER_GROUP);
    formHits.forEach(({ f, kw }) => out.push({
      key: `form:${f.id}`,
      group: "Forms",
      label: f.name,
      sub: [f.category, kw && !f.name.toLowerCase().includes(term) ? `keyword: ${kw}` : null].filter(Boolean).join(" · ") || undefined,
      go: () => navigate({ to: "/forms/$formId", params: { formId: f.id } }),
    }));

    // A submission has no name of its own, so it is found through the
    // values inside it — which is how a person actually looks for one.
    const subIds = Array.from(new Set([
      ...(refs.data ?? []).map((r) => r.id as string),
      ...((values.data ?? []).map((v) => v.submission_id).filter(Boolean) as string[]),
    ])).slice(0, PER_GROUP);
    if (subIds.length) {
      const { data: subs } = await db
        .from("form_submissions")
        .select("id, form_template_id, status, submitted_at, ref_number")
        .in("id", subIds);
      const templateIds = Array.from(new Set(
        (subs ?? []).map((r) => r.form_template_id).filter(Boolean) as string[]));
      const names: Record<string, string> = {};
      if (templateIds.length) {
        const { data: tpl } = await db.from("form_templates").select("id, name").in("id", templateIds);
        (tpl ?? []).forEach((t) => { names[t.id] = t.name; });
      }
      (subs ?? []).forEach((sub) => {
        const match = (values.data ?? []).find((v) => v.submission_id === sub.id);
        out.push({
          key: `sub:${sub.id}`,
          group: "Submissions",
          label: `${sub.form_template_id ? (names[sub.form_template_id] ?? "Submission") : "Submission"}${sub.ref_number ? ` · ${sub.ref_number}` : ""}`,
          sub: match ? `${match.field_name}: ${match.value}` : (sub.status ?? undefined),
          go: () => navigate({ to: "/status/$submissionId", params: { submissionId: sub.id } }),
        });
      });
    }

    docs.forEach((d) => out.push({
      key: `doc:${d.submission_id}:${d.field_name}`,
      group: "Documents",
      label: d.file_name,
      sub: [d.ref_number, d.tags.length ? `#${d.tags.join(" #")}` : null, d.description].filter(Boolean).join(" · "),
      go: () => navigate({ to: "/status/$submissionId", params: { submissionId: d.submission_id } }),
    }));

    (people.data ?? []).forEach((p) => out.push({
      key: `emp:${p.employee_id}`,
      group: "People",
      label: p.name,
      sub: [p.designation, p.department].filter(Boolean).join(" · ") || p.employee_id,
      // A function updater rather than an object, so following a result
      // does not drop the ?as= persona the viewer is acting as.
      go: () => navigate({ to: "/activity", search: (prev) => ({ ...prev, actor: p.employee_id }) }),
    }));

    (notices.data ?? []).forEach((n) => out.push({
      key: `notice:${n.id}`,
      group: "Notices",
      label: n.title,
      sub: n.category ?? undefined,
      go: () => navigate({ to: "/notices/$noticeId", params: { noticeId: n.id } }),
    }));

    (maint.data ?? []).forEach((m) => out.push({
      key: `mr:${m.id}`,
      group: "Maintenance",
      label: m.ref_number,
      sub: [m.location, m.status].filter(Boolean).join(" · "),
      go: () => navigate({ to: "/maintenance" }),
    }));


    setHits(out);
    setCursor(0);
    setBusy(false);
  }, [navigate]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) { setHits(null); setBusy(false); return; }
    const t = setTimeout(() => { void run(q); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, run]);

  // Grouped for display, but the cursor moves through one flat list.
  const grouped = useMemo(() => {
    const g: Array<[string, Hit[]]> = [];
    for (const h of hits ?? []) {
      const last = g[g.length - 1];
      if (last && last[0] === h.group) last[1].push(h);
      else g.push([h.group, [h]]);
    }
    return g;
  }, [hits]);

  const choose = (h: Hit) => {
    h.go();
    setOpen(false);
    setQuery("");
    setHits(null);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!hits?.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % hits.length); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + hits.length) % hits.length); }
    if (e.key === "Enter") { e.preventDefault(); choose(hits[cursor]); }
  };

  let flat = -1;

  return (
    <div ref={boxRef} className="flex-1 relative" style={{ maxWidth: 480 }}>
      <div
        className="flex items-center gap-2.5 rounded-[10px]"
        style={{ padding: "8px 14px", background: "var(--color-zinc-100)" }}
      >
        <Search size={14} className="text-zinc-500" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search submissions, forms, people…"
          className="flex-1 bg-transparent outline-none text-[13px] text-zinc-900 font-sans"
        />
      </div>

      {open && query.trim().length >= MIN_CHARS && (
        <div
          className="absolute left-0 right-0 bg-white rounded-xl border z-50 overflow-hidden"
          style={{
            top: 44,
            borderColor: "var(--color-zinc-200)",
            boxShadow: "0 12px 32px -8px rgba(0,0,0,0.18), 0 4px 8px -2px rgba(0,0,0,0.06)",
            maxHeight: 420,
            overflowY: "auto",
          }}
        >
          {busy && hits === null && (
            <div style={{ padding: "14px 16px", fontSize: 12.5, color: "var(--color-zinc-400)" }}>
              Searching…
            </div>
          )}

          {hits !== null && hits.length === 0 && !busy && (
            <div style={{ padding: "14px 16px", fontSize: 12.5, color: "var(--color-zinc-400)" }}>
              Nothing matches “{query.trim()}”.
            </div>
          )}

          {grouped.map(([group, items]) => (
            <div key={group}>
              <div
                className="font-mono uppercase"
                style={{
                  padding: "8px 16px 4px", fontSize: 10, letterSpacing: "0.11em",
                  color: "var(--color-zinc-400)", background: "var(--color-zinc-50)",
                }}
              >
                {group}
              </div>
              {items.map((h) => {
                flat += 1;
                const active = flat === cursor;
                return (
                  <button
                    key={h.key}
                    onMouseEnter={() => setCursor(hits!.indexOf(h))}
                    onClick={() => choose(h)}
                    className="w-full text-left flex items-center gap-3 cursor-pointer"
                    style={{
                      padding: "9px 16px",
                      background: active ? "var(--color-zinc-100)" : "transparent",
                      border: "none",
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-zinc-900" style={{ fontWeight: 500 }}>{h.label}</div>
                      {h.sub && (
                        <div className="text-[11.5px] text-zinc-500 truncate" style={{ marginTop: 1 }}>
                          {h.sub}
                        </div>
                      )}
                    </div>
                    {active && <CornerDownLeft size={12} className="text-zinc-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
