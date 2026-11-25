// =====================================================================
// What a request carries besides its route, as panels on its page:
// notes, the people copied on it, the requests it is linked to, and its
// documents with their versions, descriptions and tags.
//
// Each loads its own rows and writes through the functions that check
// who is acting (add_note, set_cc, link_submissions, the attachment
// functions); nothing here writes a table directly.
// =====================================================================

import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { CornerDownRight, FileText, Link2, MessageSquare, Tag, Upload, UserPlus, Users, X } from "lucide-react";
import { db } from "@/lib/db";
import { addNote, linkSubmissions, setCc, unlinkSubmissions } from "@/lib/chain";
import {
  MAX_ATTACHMENT_BYTES,
  describeAttachment,
  listAttachments,
  uploadAttachment,
  type AttachmentInfo,
} from "@/lib/attachment-fn";
import { AttachmentLink } from "@/components/AttachmentLink";
import { fmtDateTime } from "@/lib/dates";

type Person = { employee_id: string; name: string; designation: string | null };

const card: React.CSSProperties = { border: "1px solid #E4E4E7", padding: "14px 16px" };
const heading = "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider mb-3";
const input: React.CSSProperties = { padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", borderRadius: 6, background: "#fff" };
const button: React.CSSProperties = { padding: "7px 12px", fontSize: 13, borderRadius: 6, fontWeight: 500 };

function usePeople() {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    void db.from("employees").select("employee_id, name, designation").order("name")
      .then(({ data }) => setPeople((data ?? []) as Person[]));
  }, []);
  return people;
}

// ---------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------
export function NotesPanel({ submissionId, actor, canWrite }: { submissionId: string; actor: string; canWrite: boolean }) {
  const people = usePeople();
  const [notes, setNotes] = useState<{ id: string; author_id: string; body: string; created_at: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await db.from("ticket_notes").select("id, author_id, body, created_at")
      .eq("submission_id", submissionId).order("created_at");
    setNotes((data ?? []) as typeof notes);
  }, [submissionId]);
  useEffect(() => { void load(); }, [load]);

  const name = (id: string) => people.find((p) => p.employee_id === id)?.name ?? id;

  async function post() {
    if (!draft.trim()) return;
    setBusy(true);
    const { error } = await addNote(submissionId, draft, actor);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setDraft("");
    toast.success("Note added — everybody on the request was told");
    void load();
  }

  return (
    <div className="rounded-xl bg-white mb-6" style={card}>
      <div className={heading} style={{ color: "#52525B" }}><MessageSquare size={13} /> Notes</div>
      {notes.length === 0 && <div className="text-[12.5px] mb-2" style={{ color: "#A1A1AA" }}>No notes yet.</div>}
      <div className="flex flex-col gap-2.5">
        {notes.map((n) => (
          <div key={n.id} className="rounded-lg" style={{ padding: "9px 12px", background: "#FAFAFA", border: "1px solid #F4F4F5" }}>
            <div className="text-[12px]" style={{ color: "#71717A" }}>{name(n.author_id)} · {fmtDateTime(n.created_at)}</div>
            <div className="text-[13.5px] mt-1" style={{ color: "#18181B", whiteSpace: "pre-wrap" }}>{n.body}</div>
          </div>
        ))}
      </div>
      {canWrite && (
        <div className="flex gap-2 mt-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void post(); }}
            placeholder="Add a note — everybody on the request will be told"
            aria-label="New note"
            className="flex-1"
            style={input}
          />
          <button onClick={post} disabled={busy || !draft.trim()} style={{ ...button, background: "var(--color-brand-500)", color: "#fff", opacity: busy || !draft.trim() ? 0.6 : 1 }}>
            Add note
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// People copied
// ---------------------------------------------------------------------
export function CcPanel({ submissionId, actor, isRequester }: { submissionId: string; actor: string; isRequester: boolean }) {
  const people = usePeople();
  const [cc, setCcState] = useState<string[]>([]);
  const [adding, setAdding] = useState("");

  const load = useCallback(async () => {
    const { data } = await db.from("submission_cc").select("employee_id").eq("submission_id", submissionId);
    setCcState((data ?? []).map((r) => r.employee_id as string));
  }, [submissionId]);
  useEffect(() => { void load(); }, [load]);

  async function save(next: string[]) {
    const { error } = await setCc(submissionId, next, actor);
    if (error) { toast.error(error.message); return; }
    void load();
  }

  if (!isRequester && cc.length === 0) return null;
  const name = (id: string) => people.find((p) => p.employee_id === id)?.name ?? id;

  return (
    <div className="rounded-xl bg-white mb-6" style={card}>
      <div className={heading} style={{ color: "#52525B" }}><Users size={13} /> Copied on this</div>
      <div className="flex flex-wrap gap-2">
        {cc.length === 0 && <span className="text-[12.5px]" style={{ color: "#A1A1AA" }}>Nobody is copied.</span>}
        {cc.map((id) => (
          <span key={id} className="inline-flex items-center gap-1.5 rounded-full text-[12.5px]" style={{ padding: "3px 10px", background: "#F4F4F5", border: "1px solid #E4E4E7" }}>
            {name(id)}
            {isRequester && (
              <button onClick={() => save(cc.filter((x) => x !== id))} aria-label={`Stop copying ${name(id)}`} style={{ color: "#71717A" }}>
                <X size={12} />
              </button>
            )}
          </span>
        ))}
      </div>
      {isRequester && (
        <div className="flex gap-2 mt-3">
          <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Copy somebody" className="flex-1" style={input}>
            <option value="">Copy somebody on it…</option>
            {people.filter((p) => p.employee_id !== actor && !cc.includes(p.employee_id)).map((p) => (
              <option key={p.employee_id} value={p.employee_id}>{p.name}{p.designation ? ` — ${p.designation}` : ""}</option>
            ))}
          </select>
          <button
            onClick={() => { if (adding) { void save([...cc, adding]); setAdding(""); } }}
            disabled={!adding}
            className="inline-flex items-center gap-1"
            style={{ ...button, border: "1px solid #E4E4E7", background: "#fff", opacity: adding ? 1 : 0.6 }}
          >
            <UserPlus size={13} /> Copy
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Linked requests
// ---------------------------------------------------------------------
type Linked = { id: string; ref_number: string | null; status: string | null; form_template_id: string; name?: string; note: string | null; kind: string };

export function LinksPanel({
  submissionId, actor, canWrite, parentId,
}: { submissionId: string; actor: string; canWrite: boolean; parentId: string | null }) {
  const [links, setLinks] = useState<Linked[]>([]);
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const [{ data: out }, { data: inc }, { data: kids }] = await Promise.all([
      db.from("submission_links").select("to_id, note").eq("from_id", submissionId),
      db.from("submission_links").select("from_id, note").eq("to_id", submissionId),
      db.from("form_submissions").select("id").eq("parent_submission_id", submissionId),
    ]);
    const entries: { id: string; note: string | null; kind: string }[] = [
      ...(parentId ? [{ id: parentId, note: null, kind: "Follows from" }] : []),
      ...((kids ?? []) as { id: string }[]).map((k) => ({ id: k.id, note: null, kind: "Follow-up" })),
      ...((out ?? []) as { to_id: string; note: string | null }[]).map((l) => ({ id: l.to_id, note: l.note, kind: l.note === "Copied from" ? "Copied from" : "Linked" })),
      ...((inc ?? []) as { from_id: string; note: string | null }[]).map((l) => ({ id: l.from_id, note: l.note, kind: l.note === "Copied from" ? "Copied to" : "Linked" })),
    ];
    if (!entries.length) { setLinks([]); return; }
    const { data: subs } = await db.from("form_submissions").select("id, ref_number, status, form_template_id")
      .in("id", entries.map((e) => e.id));
    const tplIds = Array.from(new Set((subs ?? []).map((s) => s.form_template_id as string)));
    const { data: tpls } = tplIds.length ? await db.from("form_templates").select("id, name").in("id", tplIds) : { data: [] };
    const names: Record<string, string> = {};
    (tpls ?? []).forEach((t) => { names[t.id] = t.name; });
    setLinks(entries.flatMap((e) => {
      const s = (subs ?? []).find((x) => x.id === e.id);
      return s ? [{ ...(s as Omit<Linked, "note" | "kind" | "name">), name: names[s.form_template_id as string], note: e.note, kind: e.kind }] : [];
    }));
  }, [submissionId, parentId]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!ref.trim()) return;
    const { error } = await linkSubmissions(submissionId, ref, actor, note);
    if (error) { toast.error(error.message); return; }
    setRef(""); setNote("");
    toast.success("Linked");
    void load();
  }

  async function remove(other: string) {
    const { error } = await unlinkSubmissions(submissionId, other, actor);
    if (error) { toast.error(error.message); return; }
    void load();
  }

  if (!canWrite && links.length === 0) return null;

  return (
    <div className="rounded-xl bg-white mb-6" style={card}>
      <div className={heading} style={{ color: "#52525B" }}><Link2 size={13} /> Linked requests</div>
      <div className="flex flex-col gap-2 text-[13px]">
        {links.length === 0 && <span className="text-[12.5px]" style={{ color: "#A1A1AA" }}>Not linked to anything.</span>}
        {links.map((l) => (
          <div key={l.kind + l.id} className="flex items-center gap-2 flex-wrap">
            <CornerDownRight size={13} style={{ color: "#A1A1AA" }} />
            <span style={{ color: "#71717A" }}>{l.kind}</span>
            {l.status === "draft" && l.kind === "Follow-up" ? (
              <Link to="/forms/$formId" params={{ formId: l.form_template_id }} search={{ draft: l.id }} style={{ color: "#4338CA" }}>
                {l.name ?? "request"} — a draft ready to check and submit
              </Link>
            ) : (
              <Link to="/status/$submissionId" params={{ submissionId: l.id }} style={{ color: "#4338CA" }}>
                {l.ref_number ?? l.id.slice(0, 8)} · {l.name ?? "request"} · {String(l.status ?? "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
              </Link>
            )}
            {l.note && l.kind === "Linked" && <span style={{ color: "#A1A1AA" }}>— {l.note}</span>}
            {canWrite && l.kind === "Linked" && (
              <button onClick={() => remove(l.id)} aria-label="Unlink" style={{ color: "#A1A1AA" }}><X size={12} /></button>
            )}
          </div>
        ))}
      </div>
      {canWrite && (
        <div className="flex gap-2 mt-3 flex-wrap">
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Reference, e.g. AMS-2026-00004" aria-label="Link to reference" style={{ ...input, width: 250 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional)" aria-label="Link note" className="flex-1" style={input} />
          <button onClick={add} disabled={!ref.trim()} style={{ ...button, border: "1px solid #E4E4E7", background: "#fff", opacity: ref.trim() ? 1 : 0.6 }}>Link</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------
export function DocumentsPanel({
  submissionId, actor, canWrite, fileFields,
}: { submissionId: string; actor: string; canWrite: boolean; fileFields: string[] }) {
  const [files, setFiles] = useState<AttachmentInfo[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [desc, setDesc] = useState("");
  const [tags, setTags] = useState("");
  const [field, setField] = useState("");
  const [pick, setPick] = useState<File | null>(null);
  const [newDesc, setNewDesc] = useState("");
  const [newTags, setNewTags] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFiles(await listAttachments({ data: { submissionId } }).catch(() => []));
  }, [submissionId]);
  useEffect(() => { void load(); }, [load]);

  const questions = Array.from(new Set([...files.map((f) => f.field_name), ...fileFields]));
  if (!canWrite && files.length === 0) return null;

  async function saveMeta(id: string) {
    const r = await describeAttachment({ data: { attachmentId: id, description: desc, tags, actor } });
    if (!r.ok) { toast.error(r.error); return; }
    setEditing(null);
    void load();
  }

  async function upload() {
    const q = field || questions[0];
    if (!pick || !q) return;
    if (pick.size > MAX_ATTACHMENT_BYTES) { toast.error(`${pick.name} is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit`); return; }
    const body = new FormData();
    body.set("submissionId", submissionId);
    body.set("fieldName", q);
    body.set("uploadedBy", actor);
    body.set("description", newDesc);
    body.set("tags", newTags);
    body.set("file", pick);
    setBusy(true);
    const r = await uploadAttachment({ data: body }).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "the upload failed" }));
    setBusy(false);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`Attached as version ${r.attachment.version}`);
    setPick(null); setNewDesc(""); setNewTags("");
    void load();
  }

  return (
    <div className="rounded-xl bg-white mb-6" style={card}>
      <div className={heading} style={{ color: "#52525B" }}><FileText size={13} /> Documents</div>
      {files.length === 0 && <div className="text-[12.5px] mb-2" style={{ color: "#A1A1AA" }}>No documents yet.</div>}
      <div className="flex flex-col gap-3">
        {questions.filter((q) => files.some((f) => f.field_name === q)).map((q) => {
          const versions = files.filter((f) => f.field_name === q);
          const current = versions.find((f) => !f.superseded_at) ?? versions[0];
          const older = versions.filter((f) => f.id !== current.id);
          return (
            <div key={q} className="rounded-lg" style={{ padding: "10px 12px", background: "#FAFAFA", border: "1px solid #F4F4F5" }}>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[12px]" style={{ color: "#71717A", minWidth: 120 }}>{q}</span>
                <AttachmentLink file={current} />
                {current.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-full text-[11px]" style={{ padding: "1px 8px", background: "#ECFDF5", color: "#047857", border: "1px solid #A7F3D0" }}>
                    <Tag size={10} />{t}
                  </span>
                ))}
                {canWrite && editing !== current.id && (
                  <button
                    onClick={() => { setEditing(current.id); setDesc(current.description ?? ""); setTags(current.tags.join(", ")); }}
                    className="text-[12px]" style={{ color: "#4338CA" }}
                  >
                    Describe / tag
                  </button>
                )}
              </div>
              {current.description && editing !== current.id && (
                <div className="text-[12.5px] mt-1.5" style={{ color: "#3F3F46" }}>{current.description}</div>
              )}
              {editing === current.id && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is this document?" aria-label="Document description" className="flex-1" style={input} />
                  <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma separated" aria-label="Document tags" style={{ ...input, width: 200 }} />
                  <button onClick={() => saveMeta(current.id)} style={{ ...button, background: "var(--color-brand-500)", color: "#fff" }}>Save</button>
                  <button onClick={() => setEditing(null)} style={{ ...button, border: "1px solid #E4E4E7", background: "#fff" }}>Cancel</button>
                </div>
              )}
              {older.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap mt-2 text-[11.5px]" style={{ color: "#A1A1AA" }}>
                  Earlier versions:
                  {older.map((f) => <AttachmentLink key={f.id} file={f} />)}
                </div>
              )}
              <div className="text-[11px] mt-1.5" style={{ color: "#A1A1AA" }}>
                Version {current.version}, {fmtDateTime(current.created_at)}
              </div>
            </div>
          );
        })}
      </div>
      {canWrite && questions.length > 0 && (
        <div className="mt-3 rounded-lg" style={{ padding: "10px 12px", border: "1px dashed #D4D4D8" }}>
          <div className="text-[12px] mb-2" style={{ color: "#52525B" }}>
            Add a document or a revised version — earlier versions are kept.
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {questions.length > 1 && (
              <select value={field || questions[0]} onChange={(e) => setField(e.target.value)} aria-label="For question" style={input}>
                {questions.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
            )}
            <label className="inline-flex items-center gap-1.5 rounded-md cursor-pointer" style={{ ...button, border: "1px solid #E4E4E7", background: "#fff" }}>
              <Upload size={13} /> {pick ? pick.name : "Choose a file"}
              <input type="file" aria-label="Document file" style={{ display: "none" }} onChange={(e) => { setPick(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            </label>
            <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description" aria-label="New document description" className="flex-1" style={{ ...input, minWidth: 160 }} />
            <input value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="tags" aria-label="New document tags" style={{ ...input, width: 140 }} />
            <button onClick={upload} disabled={!pick || busy} style={{ ...button, background: "var(--color-brand-500)", color: "#fff", opacity: !pick || busy ? 0.6 : 1 }}>
              {busy ? "Attaching…" : "Attach"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
