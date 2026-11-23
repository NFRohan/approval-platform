// "Fill from a Word document": upload the vetted NFA, see what was found,
// and fill the form — or, for an NFA with several business cases, make a
// draft for each.

import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Check, Download, FileText, Layers, Loader2, Upload, X } from "lucide-react";
import { draftsFromCases, extractFromWord } from "@/lib/docx-fn";
import type { Extraction, Match } from "@/lib/docx-types";

export type AppliedMatch = { fieldId: string; kind: string; value: unknown };

const display = (m: Match) => {
  if (m.kind === "multi_select") { try { return (JSON.parse(m.value) as string[]).join(", "); } catch { return m.value; } }
  if (m.kind === "date") return `${m.value.slice(8, 10)}/${m.value.slice(5, 7)}/${m.value.slice(0, 4)}`;
  if (m.kind === "number" || m.kind === "money") return Number(m.value).toLocaleString("en-US");
  return m.value;
};
const asValue = (m: Match): unknown => {
  if (m.kind === "multi_select") { try { return JSON.parse(m.value); } catch { return [m.value]; } }
  return m.value;
};

export function WordImport({ templateId, formId, showSample, onApply }: {
  templateId: string; formId: string; showSample: boolean; onApply: (values: AppliedMatch[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ ex: Extraction; file: string } | null>(null);
  const [caseIdx, setCaseIdx] = useState(0);
  const [drafts, setDrafts] = useState<{ id: string; ref: string | null; title: string }[] | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true); setDrafts(null);
    const fd = new FormData();
    fd.set("templateId", templateId);
    fd.set("file", file);
    const r = await extractFromWord({ data: fd });
    setBusy(false);
    // Cleared only now, so the same file can be chosen again: clearing it
    // while the upload was still reading a file chosen from disk sent it
    // empty.
    if (input.current) input.current.value = "";
    if (!r.ok) return void toast.error(r.error);
    const total = r.extraction.common.length + r.extraction.cases.reduce((s, c) => s + c.matches.length, 0);
    if (!total) return void toast.error("Nothing in that document matched this form's questions.");
    setFound({ ex: r.extraction, file: r.fileName });
    setCaseIdx(0);
  }

  const casesOf = (ex: Extraction) => ex.cases.length ? ex.cases : [{ title: "", matches: [] as Match[] }];
  const merged = (ex: Extraction, i: number): Match[] => {
    const own = casesOf(ex)[i]?.matches ?? [];
    return [...ex.common.filter((m) => !own.some((o) => o.fieldId === m.fieldId)), ...own];
  };

  async function makeDrafts() {
    if (!found) return;
    setBusy(true);
    const r = await draftsFromCases({ data: {
      templateId,
      cases: found.ex.cases.map((c, i) => ({
        title: c.title,
        values: Object.fromEntries(merged(found.ex, i).map((m) => [m.fieldLabel, m.value])),
      })),
    } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setDrafts(r.drafts);
    toast.success(`${r.drafts.length} drafts made — one for each business case`);
  }

  return (
    <div className="rounded-xl" style={{ border: "1px dashed #C7D2FE", background: "#F8F9FF", padding: "12px 14px", marginBottom: 6 }} data-testid="word-import">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center justify-center rounded-lg" style={{ width: 32, height: 32, background: "#EEF2FF", color: "#4338CA" }}>
          <FileText size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>Fill from a Word document</div>
          <div style={{ fontSize: 12, color: "#71717A" }}>Upload the vetted NFA; what it says fills the matching questions. Several business cases become a draft each.</div>
        </div>
        {showSample && (
          <a href="/samples/campaign-nfa" className="inline-flex items-center gap-1" style={{ fontSize: 12, color: "#4F46E5", textDecoration: "none" }}>
            <Download size={12} /> Sample NFA
          </a>
        )}
        <button type="button" onClick={() => input.current?.click()} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md" name="word-upload"
          style={{ padding: "7px 12px", fontSize: 12.5, fontWeight: 500, background: "#fff", border: "1px solid #C7D2FE", color: "#3730A3", cursor: "pointer" }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Choose .docx
        </button>
        <input ref={input} type="file" accept=".docx" hidden aria-label="Word document" onChange={(e) => void choose(e.target.files?.[0])} />
      </div>

      {found && !drafts && (
        <div style={{ marginTop: 12, borderTop: "1px solid #E0E7FF", paddingTop: 12 }} data-testid="word-found">
          <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, color: "#3F3F46" }}>
              From <strong>{found.file}</strong>
              {found.ex.cases.length > 1 ? <> — <strong>{found.ex.cases.length} business cases</strong></> : null}
            </span>
            <button type="button" onClick={() => setFound(null)} aria-label="Dismiss" style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "#71717A" }}><X size={14} /></button>
          </div>
          {found.ex.cases.length > 1 && (
            <div className="flex gap-1.5 flex-wrap" style={{ marginBottom: 8 }} role="tablist">
              {found.ex.cases.map((c, i) => (
                <button key={i} type="button" role="tab" aria-selected={i === caseIdx} onClick={() => setCaseIdx(i)}
                  style={{ padding: "4px 10px", fontSize: 12, borderRadius: 999, cursor: "pointer",
                    border: `1px solid ${i === caseIdx ? "#4F46E5" : "#E4E4E7"}`, background: i === caseIdx ? "#4F46E5" : "#fff", color: i === caseIdx ? "#fff" : "#3F3F46" }}>
                  {c.title || `Case ${i + 1}`}
                </button>
              ))}
            </div>
          )}
          <div className="rounded-lg bg-white" style={{ border: "1px solid #E0E7FF" }}>
            {merged(found.ex, caseIdx).map((m, i) => (
              <div key={m.fieldId} className="grid items-baseline gap-3"
                style={{ gridTemplateColumns: "16px 150px minmax(0,1fr) auto", fontSize: 12.5, padding: "6px 10px", borderTop: i ? "1px solid #EEF2FF" : undefined }}>
                <Check size={12} style={{ color: "#15803D" }} />
                <span style={{ color: "#71717A" }}>{m.fieldLabel}</span>
                <span style={{ color: "#18181B", fontWeight: 500, whiteSpace: "pre-line" }}>{display(m)}</span>
                <span title="What the document called it" style={{ fontSize: 11, color: "#A1A1AA", whiteSpace: "nowrap" }}>
                  {m.from.toLowerCase() !== m.fieldLabel.toLowerCase() ? `from “${m.from}”` : ""}
                </span>
              </div>
            ))}
          </div>
          {found.ex.unmatched.length > 0 && (
            <div style={{ fontSize: 11.5, color: "#A1A1AA", marginTop: 8 }}>
              Not used: {found.ex.unmatched.slice(0, 6).map((u) => u.label).join(", ")}{found.ex.unmatched.length > 6 ? "…" : ""}
            </div>
          )}
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 10 }}>
            <button type="button" name="word-apply"
              onClick={() => { onApply(merged(found.ex, caseIdx).map((m) => ({ fieldId: m.fieldId, kind: m.kind, value: asValue(m) }))); toast.success("Filled from the document — check it before you go on"); setFound(null); }}
              style={{ padding: "7px 12px", fontSize: 12.5, fontWeight: 500, borderRadius: 6, border: "none", background: "var(--color-brand-500)", color: "#fff", cursor: "pointer" }}>
              Fill this form{found.ex.cases.length > 1 ? ` with ${found.ex.cases[caseIdx].title || `case ${caseIdx + 1}`}` : ""}
            </button>
            {found.ex.cases.length > 1 && (
              <button type="button" name="word-drafts" onClick={() => void makeDrafts()} disabled={busy}
                className="inline-flex items-center gap-1.5"
                style={{ padding: "7px 12px", fontSize: 12.5, fontWeight: 500, borderRadius: 6, border: "1px solid #C7D2FE", background: "#fff", color: "#3730A3", cursor: "pointer" }}>
                <Layers size={13} /> Make a draft for each of the {found.ex.cases.length}
              </button>
            )}
          </div>
        </div>
      )}

      {drafts && (
        <div style={{ marginTop: 12, borderTop: "1px solid #E0E7FF", paddingTop: 12 }} data-testid="word-drafts">
          <div style={{ fontSize: 12.5, color: "#3F3F46", marginBottom: 6 }}>A draft for each business case, linked to one another. Open each to check it and submit:</div>
          {drafts.map((d) => (
            <Link key={d.id} to="/forms/$formId" params={{ formId }} search={{ draft: d.id } as never}
              className="flex items-center gap-2" style={{ fontSize: 13, padding: "5px 0", color: "#4338CA", textDecoration: "none" }}>
              <FileText size={13} /> {d.ref ?? "Draft"} — {d.title}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
