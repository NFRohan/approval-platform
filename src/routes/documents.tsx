// =====================================================================
// Documents: /documents
//
// Every document on a request the person may see, in one place (SOW
// §2.1 r8; ABC portal: "same vendor/person may appear in different ABC
// cases ... tagging enables quick retrieval of all related records").
// By words, tag, form, reference, uploader, upload date and version;
// newest first, fifty a page. The database decides which requests'
// documents a person sees, as it does everywhere else.
// =====================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { FolderSearch } from "lucide-react";
import { db } from "@/lib/db";
import { listDocuments, type DocumentRow, type DocumentFilters } from "@/lib/attachment-fn";
import { AttachmentLink } from "@/components/AttachmentLink";
import { DateInput } from "@/components/DateInput";
import { Page, Pill } from "@/components/admin/kit";
import { fmtDate } from "@/lib/dates";

export const Route = createFileRoute("/documents")({
  head: () => ({ meta: [{ title: "Documents · Admin Services Portal" }] }),
  component: DocumentsPage,
});

const ctl: React.CSSProperties = { padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", borderRadius: 6, background: "#fff" };

function DocumentsPage() {
  const [f, setF] = useState<DocumentFilters>({ versions: "current", page: 0 });
  const [q, setQ] = useState("");
  const [ref, setRef] = useState("");
  const [data, setData] = useState<{ rows: DocumentRow[]; total: number; tags: string[]; forms: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<{ employee_id: string; name: string }[]>([]);

  useEffect(() => {
    void db.from("employees").select("employee_id, name").eq("active", true).order("name")
      .then(({ data: rows }) => setPeople((rows ?? []) as { employee_id: string; name: string }[]));
  }, []);

  // Typing settles before it searches.
  useEffect(() => {
    const t = window.setTimeout(() => setF((p) => ({ ...p, q, ref, page: 0 })), 300);
    return () => window.clearTimeout(t);
  }, [q, ref]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void listDocuments({ data: f }).then((r) => { if (alive) { setData(r); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [f]);

  const set = (patch: Partial<DocumentFilters>) => setF((p) => ({ ...p, ...patch, page: 0 }));
  const page = f.page ?? 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;
  const filtered = useMemo(() => Boolean(f.q || f.tag || f.form || f.ref || f.uploader || f.from || f.to), [f]);

  return (
    <Page full title="Documents"
      intro="Every document on the requests you can see: find one by its name, description or tag, by form or reference, by who uploaded it and when. Earlier versions are kept; show them to see a document's history.">
      <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="document-filters">
        <input aria-label="Search documents" placeholder="Name, description or tag" value={q} onChange={(e) => setQ(e.target.value)}
               style={{ ...ctl, flex: "1 1 220px", minWidth: 200 }} />
        <select aria-label="Tag" style={ctl} value={f.tag ?? ""} onChange={(e) => set({ tag: e.target.value || undefined })}>
          <option value="">Any tag</option>
          {data?.tags.map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
        <select aria-label="Form" style={ctl} value={f.form ?? ""} onChange={(e) => set({ form: e.target.value || undefined })}>
          <option value="">Any form</option>
          {data?.forms.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <input aria-label="Reference" placeholder="Reference, e.g. 00201" value={ref} onChange={(e) => setRef(e.target.value)}
               style={{ ...ctl, width: 170 }} />
        <select aria-label="Uploaded by" style={ctl} value={f.uploader ?? ""} onChange={(e) => set({ uploader: e.target.value || undefined })}>
          <option value="">Anybody</option>
          {people.map((p) => <option key={p.employee_id} value={p.employee_id}>{p.name}</option>)}
        </select>
        <span style={{ fontSize: 12.5, color: "#71717A" }}>Uploaded</span>
        <DateInput value={f.from ?? ""} onChange={(iso) => set({ from: iso || undefined })} aria-label="Uploaded from" style={{ ...ctl, width: 130 }} />
        <span style={{ fontSize: 12.5, color: "#71717A" }}>to</span>
        <DateInput value={f.to ?? ""} onChange={(iso) => set({ to: iso || undefined })} aria-label="Uploaded to" style={{ ...ctl, width: 130 }} />
        <select aria-label="Versions" style={ctl} value={f.versions ?? "current"} onChange={(e) => set({ versions: e.target.value as "current" | "all" })}>
          <option value="current">Current versions</option>
          <option value="all">Every version</option>
        </select>
        {filtered && (
          <button type="button" onClick={() => { setQ(""); setRef(""); setF({ versions: f.versions, page: 0 }); }}
                  style={{ ...ctl, cursor: "pointer", color: "#52525B" }}>Clear</button>
        )}
      </div>

      <div style={{ fontSize: 12.5, color: "#71717A", marginBottom: 8 }} data-testid="document-count">
        {data ? `${data.total} document${data.total === 1 ? "" : "s"}${filtered ? " match" : ""}` : " "}
      </div>

      <div className="rounded-xl bg-white overflow-x-auto" style={{ border: "1px solid #E4E4E7", opacity: loading ? 0.6 : 1 }}>
        <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse" }} data-testid="document-list">
          <thead>
            <tr style={{ textAlign: "left", color: "#71717A", fontSize: 11.5, borderBottom: "1px solid #F4F4F5" }}>
              <th style={{ padding: "10px 14px", fontWeight: 500 }}>Document</th>
              <th style={{ padding: "10px 8px", fontWeight: 500 }}>Request</th>
              <th style={{ padding: "10px 8px", fontWeight: 500 }}>Uploaded</th>
              <th style={{ padding: "10px 14px", fontWeight: 500 }}>Description and tags</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((d) => (
              <tr key={d.id} style={{ borderTop: "1px solid #F4F4F5", verticalAlign: "top" }}>
                <td style={{ padding: "10px 14px", minWidth: 220 }}>
                  <AttachmentLink file={d} />
                  <div style={{ fontSize: 11.5, color: "#71717A", marginTop: 4 }}>
                    {d.field_name} · version {d.version}{d.superseded_at ? ` · replaced ${fmtDate(d.superseded_at)}` : ""}
                  </div>
                </td>
                <td style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>
                  <Link to="/status/$submissionId" params={{ submissionId: d.submission_id }} style={{ color: "#4338CA", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {d.ref_number ?? "Request"}
                  </Link>
                  <div style={{ fontSize: 12, color: "#52525B" }}>{d.form}</div>
                </td>
                <td style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>
                  <div>{d.uploader_name ?? d.uploaded_by ?? "—"}</div>
                  <div style={{ fontSize: 12, color: "#71717A" }}>{fmtDate(d.created_at)}</div>
                </td>
                <td style={{ padding: "10px 14px", maxWidth: 420 }}>
                  {d.description && <div style={{ color: "#3F3F46" }}>{d.description}</div>}
                  <div className="flex flex-wrap gap-1" style={{ marginTop: d.description ? 4 : 0 }}>
                    {(d.tags ?? []).map((t) => (
                      <button key={t} type="button" onClick={() => set({ tag: t })} title={`Every document tagged ${t}`}
                              style={{ border: "none", background: "none", padding: 0, cursor: "pointer" }}>
                        <Pill>#{t}</Pill>
                      </button>
                    ))}
                    {!d.description && !(d.tags ?? []).length && <span style={{ color: "#A1A1AA" }}>—</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.rows.length === 0 && (
          <div className="flex flex-col items-center text-center" style={{ padding: "48px 20px", color: "#A1A1AA" }}>
            <FolderSearch size={28} />
            <div style={{ fontSize: 14, marginTop: 8 }}>{filtered ? "No document matches those filters" : "No documents on any request you can see"}</div>
          </div>
        )}
      </div>

      {data && pages > 1 && (
        <div className="flex items-center justify-end gap-2" style={{ marginTop: 12, fontSize: 13 }}>
          <button type="button" disabled={page === 0} onClick={() => setF((p) => ({ ...p, page: page - 1 }))} style={{ ...ctl, cursor: page === 0 ? "default" : "pointer", opacity: page === 0 ? 0.5 : 1 }}>Previous</button>
          <span style={{ color: "#71717A" }}>Page {page + 1} of {pages}</span>
          <button type="button" disabled={page + 1 >= pages} onClick={() => setF((p) => ({ ...p, page: page + 1 }))} style={{ ...ctl, cursor: page + 1 >= pages ? "default" : "pointer", opacity: page + 1 >= pages ? 0.5 : 1 }}>Next</button>
        </div>
      )}
    </Page>
  );
}
