import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FileUp, RefreshCw } from "lucide-react";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  directoryStatus, importEmployees, listSyncs, syncDirectory,
  type DirectoryStatus, type ImportOutcome, type SyncRun,
} from "@/lib/admin-fn";
import { readHrFile, type HrParse } from "@/lib/hr-file";
import { Button, Card, NoPermission, Notice, Page, Pill, fmtWhen } from "@/components/admin/kit";

export const Route = createFileRoute("/admin/people")({
  head: () => ({ meta: [{ title: "People · Admin Services Portal" }] }),
  component: PeoplePage,
});

function Outcome({ o, preview }: { o: ImportOutcome; preview?: boolean }) {
  return (
    <div style={{ fontSize: 13, color: "#3F3F46" }} data-testid={preview ? "import-preview" : "import-result"}>
      <div className="flex gap-1.5 flex-wrap">
        <Pill tone="green">{o.added} added</Pill>
        <Pill tone="brand">{o.updated} updated</Pill>
        <Pill>{o.managers} line managers set</Pill>
        <Pill tone={o.left ? "amber" : "zinc"}>{o.left} marked as left</Pill>
        <Pill tone={o.skipped.length ? "red" : "zinc"}>{o.skipped.length} skipped</Pill>
      </div>
      {o.skipped.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#B91C1C" }}>
          Skipped: {o.skipped.slice(0, 12).join(", ")}{o.skipped.length > 12 ? ` and ${o.skipped.length - 12} more` : ""}
        </div>
      )}
    </div>
  );
}

function PeoplePage() {
  const { can, currentUser } = useCurrentUser();
  const manage = can("org.manage");
  const [syncs, setSyncs] = useState<SyncRun[]>([]);
  const [dir, setDir] = useState<DirectoryStatus | null>(null);

  const load = useCallback(async () => { setSyncs(await listSyncs()); }, []);
  useEffect(() => {
    void load();
    void directoryStatus().then(setDir).catch(() => setDir({ configured: false, host: null }));
  }, [load, currentUser.employee_id]);

  if (!manage && !can("audit.view")) return <Page title="People"><NoPermission need="org.manage" /></Page>;

  return (
    <Page
      wide
      title="People"
      intro="The org chart — who works here, their department, title and line manager — comes from the HR master file or the directory. Approval routes read it: a requester's own manager, their department's head, HR business partner and CXO."
    >
      {manage && <HrImport onDone={load} />}
      {manage && <Directory status={dir} onDone={load} />}

      <Card title="Sync history">
        {syncs.length === 0 ? (
          <div style={{ fontSize: 13, color: "#A1A1AA" }}>Nothing has been imported yet.</div>
        ) : (
          <div className="flex flex-col" data-testid="sync-history">
            {syncs.map((s) => (
              <div key={s.id} className="flex items-center gap-3 flex-wrap" style={{ padding: "9px 2px", borderTop: "1px solid #F4F4F5", fontSize: 13 }}>
                <span style={{ width: 128, color: "#71717A" }}>{fmtWhen(s.created_at)}</span>
                <Pill tone={s.source === "csv" ? "zinc" : "brand"}>
                  {s.source === "csv" ? "HR file" : s.source === "ldap" ? "Directory" : "Daily sync"}
                </Pill>
                {s.error ? (
                  <span style={{ color: "#B91C1C" }}>Failed: {s.error}</span>
                ) : s.result ? (
                  <span style={{ color: "#3F3F46" }}>
                    {s.result.added} added, {s.result.updated} updated, {s.result.left} left, {s.result.skipped?.length ?? 0} skipped
                  </span>
                ) : null}
                <span style={{ marginLeft: "auto", color: "#A1A1AA", fontSize: 12 }}>{s.run_by ?? "scheduled"}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Page>
  );
}

function HrImport({ onDone }: { onDone: () => Promise<void> }) {
  const [file, setFile] = useState<string | null>(null);
  const [parsed, setParsed] = useState<HrParse | null>(null);
  const [markLeft, setMarkLeft] = useState(false);
  const [preview, setPreview] = useState<ImportOutcome | null>(null);
  const [done, setDone] = useState<ImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(f: File | undefined) {
    setPreview(null); setDone(null); setError(null);
    if (!f) return;
    setFile(f.name);
    setParsed(readHrFile(await f.text()));
  }

  async function run(isPreview: boolean) {
    if (!parsed) return;
    setBusy(true); setError(null);
    const r = await importEmployees({ data: { rows: parsed.rows, markMissingLeft: markLeft, preview: isPreview } });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (isPreview) setPreview(r.outcome);
    else { setDone(r.outcome); setPreview(null); toast.success("HR file imported"); await onDone(); }
  }

  return (
    <Card title={<span className="inline-flex items-center gap-2"><FileUp size={15} /> HR master file</span>}>
      <p style={{ fontSize: 13, color: "#52525B", margin: "0 0 12px" }}>
        A CSV with a header row. Needs an employee id and a name; reads department, designation, line manager id
        and work email when present. Managers may come after the people who report to them.
      </p>
      <input type="file" accept=".csv,text/csv" name="hr-file" onChange={(e) => void choose(e.target.files?.[0])} />
      {parsed && (
        <div className="flex flex-col gap-3" style={{ marginTop: 14 }}>
          {parsed.missing.length ? (
            <Notice tone="red">{file} has no column for: {parsed.missing.join(", ")}.</Notice>
          ) : (
            <>
              <div style={{ fontSize: 13, color: "#3F3F46" }}>
                <strong>{parsed.rows.length}</strong> people in {file}. Columns found:{" "}
                {Object.entries(parsed.columns).map(([k, v]) => <Pill key={k}>{v} → {k}</Pill>)}
              </div>
              <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
                <input type="checkbox" name="mark-left" checked={markLeft} onChange={(e) => { setMarkLeft(e.target.checked); setPreview(null); }} />
                This is everybody — mark anyone not in it as having left
              </label>
              {preview && <Outcome o={preview} preview />}
              {done && <Outcome o={done} />}
              {error && <Notice tone="red">{error}</Notice>}
              <div className="flex gap-2">
                <Button busy={busy} onClick={() => void run(true)}>Preview</Button>
                <Button tone="brand" busy={busy} disabled={!preview} onClick={() => void run(false)}>Apply</Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function Directory({ status, onDone }: { status: DirectoryStatus | null; onDone: () => Promise<void> }) {
  const [markLeft, setMarkLeft] = useState(true);
  const [preview, setPreview] = useState<{ outcome: ImportOutcome; people: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(isPreview: boolean) {
    setBusy(true); setError(null);
    const r = await syncDirectory({ data: { markMissingLeft: markLeft, preview: isPreview } });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (isPreview) setPreview({ outcome: r.outcome, people: r.people });
    else { setPreview(null); toast.success(`Synced ${r.people} people from the directory`); await onDone(); }
  }

  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><RefreshCw size={15} /> Directory (LDAP / Active Directory)</span>}
      aside={status?.configured ? <Pill tone="green">connected · {status.host}</Pill> : <Pill>not connected</Pill>}
    >
      {!status?.configured ? (
        <p style={{ fontSize: 13, color: "#52525B", margin: 0 }}>
          No directory is connected to this organisation. Once one is, people are synced from it every night and
          on demand here, and accounts can sign in with their directory password.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p style={{ fontSize: 13, color: "#52525B", margin: 0 }}>
            Synced every night automatically. Sync now to pick up today's joiners and leavers.
          </p>
          <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={markLeft} onChange={(e) => { setMarkLeft(e.target.checked); setPreview(null); }} />
            Mark anyone no longer in the directory as having left
          </label>
          {preview && (
            <>
              <div style={{ fontSize: 13 }}>{preview.people} people in the directory.</div>
              <Outcome o={preview.outcome} preview />
            </>
          )}
          {error && <Notice tone="red">{error}</Notice>}
          <div className="flex gap-2">
            <Button busy={busy} onClick={() => void run(true)}>Preview</Button>
            <Button tone="brand" busy={busy} disabled={!preview} onClick={() => void run(false)}>Sync now</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
