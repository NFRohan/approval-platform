import { LoadingRows } from "@/components/Loading";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { NoFormChosen } from "@/components/builder/NoFormChosen";
import { db } from "@/lib/db";
import { BuilderChrome, PrimaryButton, SecondaryButton } from "@/components/builder/BuilderChrome";
import { PeopleStep, type AutoEntry, type ManualEntry } from "@/components/builder/PeopleStep";
import { toast } from "sonner";
import { useBuilderAccess } from "@/components/builder/access";
import { ruleRole } from "@/lib/routing";
import { CONDITION_OPS, ROLE_OPTIONS } from "@/components/builder/stages";

// "Define the criteria for sending notifications": each person added by
// hand is told on the events ticked, and, with a condition, only when
// the request's answers meet it (db/009_sow_gaps.sql).
type When = { events: string[]; condition: { field: string; op: string; value: string } | null };
const EVENTS: { key: string; label: string }[] = [
  { key: "raised", label: "Raised" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];
const DEFAULT_WHEN: When = { events: ["raised"], condition: null };

// Roles a watcher may be instead of a named person. The approver's line
// manager is SOW 2.1's "approvers supervisor": told of a request raised
// (the manager of whoever it waits on), approved or rejected (of whoever
// decided). See app.watchers_for in db/009_sow_gaps.sql.
const WATCHER_ROLES: { value: string; label: string }[] = [
  { value: "approver_manager", label: "The approver's line manager" },
  ...ROLE_OPTIONS,
];
const roleLabel = (v: string) => WATCHER_ROLES.find((r) => `role:${r.value}` === v)?.label;

// Optional: opened with no form (a bookmark, a reload), it says so rather than failing.
const search = z.object({ templateId: z.string().optional() });

export const Route = createFileRoute("/builder/notifications")({
  validateSearch: search,
  head: () => ({
    meta: [{ title: "Notifications · Form Builder" }],
  }),
  component: Page,
});

function Page() {
  const { templateId } = Route.useSearch();
  return templateId ? <NotificationsStep templateId={templateId} /> : <NoFormChosen step="notifications" />;
}

type AutoEntryWithRequires = AutoEntry & { _requires?: string; label?: string };

// Who hears about a submission without being added by hand.
//
// Three of these are roles, resolved by the engine when a request is
// raised: the form's creator, the requester's own line manager, and the
// requester. They were four fixed employees, named here as people the
// org chart no longer had, so the "line manager" told was one person for
// every requester and the "submitter" told was always the same analyst.
// `label` is what the engine reads; see app.rule_role.
const BASE_AUTO_NOTIFY: AutoEntryWithRequires[] = [
  {
    id: "auto-creator",
    user_id: null,
    label: "creator",
    name: "Form creator",
    designation: "Whoever built this form",
    reason: "Added: Form creator",
  },
  {
    id: "auto-line-mgr",
    user_id: null,
    label: "line_manager",
    name: "Requester's line manager",
    designation: "From the org chart, when submitted",
    reason: "Added: Employee field",
    _requires: "employee",
  },
  {
    id: "auto-admin",
    user_id: "EMP-0445",
    label: "admin",
    name: "Admin Officer",
    designation: "Admin",
    reason: "Added: Default",
  },
  {
    id: "auto-submitter",
    user_id: null,
    label: "submitter",
    name: "The requester",
    designation: "Whoever submits it",
    reason: "Added: Submitter",
  },
];

// Thresholds are cumulative, so a slab has a floor and no ceiling — the
// upper bound the column once held was never read by either engine.
function formatSlabRange(min: number): string {
  const fmt = (n: number) => n.toLocaleString("en-IN");
  return min === 0 ? "Band: any amount" : `Band: ${fmt(min)} and above`;
}

function NotificationsStep({ templateId }: { templateId: string }) {
  const navigate = useNavigate();
  const access = useBuilderAccess(templateId);
  const [formName, setFormName] = useState("");
  const [manual, setManual] = useState<ManualEntry[]>([]);
  const [savedAgo, setSavedAgo] = useState("just now");
  const [publishing, setPublishing] = useState(false);
  const [fieldTypes, setFieldTypes] = useState<Set<string>>(new Set());
  const [slabNotify, setSlabNotify] = useState<AutoEntryWithRequires[]>([]);
  const [names, setNames] = useState<Record<string, { name: string; designation: string | null }>>({});
  // The automatic watchers this form was saved with, or null when it has
  // none saved — see autoNotify.
  const [savedAuto, setSavedAuto] = useState<{ label: string; user_id: string | null }[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [when, setWhen] = useState<Record<string, When>>({});
  const [fieldLabels, setFieldLabels] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      const [{ data: tpl }, { data: fields }, { data: slabRows }, { data: emps }, { data: rules }] = await Promise.all([
        db.from("form_templates").select("name").eq("id", templateId).maybeSingle(),
        db.from("form_fields").select("field_type, field_name").eq("form_template_id", templateId).order("order_index"),
        db.from("approval_slabs").select("*").eq("form_template_id", templateId).order("order_index"),
        db.from("employees").select("employee_id, name, designation"),
        db.from("notification_rules")
          .select("notifyee_user_id, is_auto_added, label, events, condition")
          .eq("form_template_id", templateId),
      ]);
      if (tpl?.name) setFormName(tpl.name);
      setFieldTypes(new Set((fields ?? []).map((f) => f.field_type ?? "").filter(Boolean)));
      setFieldLabels((fields ?? [])
        .filter((f) => f.field_name && !["section_header", "file", "signature"].includes(f.field_type ?? ""))
        .map((f) => f.field_name as string));
      // A watcher added by hand is a person, or a role kept as "role:<role>".
      const who = (r: { notifyee_user_id: string | null; label: string | null }) =>
        r.notifyee_user_id ?? (r.label && WATCHER_ROLES.some((x) => x.value === r.label) ? `role:${r.label}` : null);
      setWhen(Object.fromEntries((rules ?? [])
        .filter((r) => !r.is_auto_added && who(r))
        .map((r) => {
          const c = (r as { condition?: { field?: string; op?: string; value?: string } | null }).condition;
          return [who(r) as string, {
            events: ((r as { events?: string[] | null }).events ?? ["raised"]),
            condition: c?.field ? { field: c.field, op: c.op ?? "eq", value: c.value ?? "" } : null,
          }];
        })));
      setLoading(false);
      const empMap: Record<string, { name: string; designation: string | null }> = {};
      (emps ?? []).forEach((e) => { empMap[e.employee_id] = { name: e.name, designation: e.designation }; });
      setNames(empMap);
      // Watchers added by hand last time, so publishing again keeps them
      // instead of replacing every rule with only the automatic ones.
      setManual(
        (rules ?? [])
          .filter((r) => !r.is_auto_added && who(r))
          .map((r, i) => {
            const id = who(r) as string;
            const role = roleLabel(id);
            return {
              id: `saved-${i}`,
              user_id: id,
              name: role ?? empMap[id]?.name ?? id,
              designation: role ? "A role, found when it happens" : empMap[id]?.designation ?? "",
              deadlineDays: 0,
            };
          }),
      );
      // Finance band watchers are regenerated from the slabs each time,
      // so only the other automatic rules are carried over.
      setSavedAuto(
        rules && rules.length > 0
          ? rules
              .filter((r) => r.is_auto_added && !(r.label ?? "").startsWith("Band:"))
              .map((r) => ({ label: r.label ?? "", user_id: r.notifyee_user_id }))
          : null,
      );
      setSlabNotify(
        (slabRows ?? []).map((s, i) => ({
          id: `auto-finance-${i}`,
          user_id: s.approver_user_id,
          name: empMap[s.approver_user_id]?.name ?? s.approver_user_id,
          designation: empMap[s.approver_user_id]?.designation ?? "",
          reason: formatSlabRange(s.min_amount),
          _requires: "money",
        })),
      );
    })();
  }, [templateId]);

  const named = (a: AutoEntryWithRequires): AutoEntryWithRequires =>
    a.user_id && names[a.user_id]
      ? { ...a, name: names[a.user_id].name, designation: names[a.user_id].designation ?? a.designation }
      : a;

  // A new form gets the default watchers; a form that already has some
  // keeps them. Recomputing the defaults on every visit meant publishing
  // a seeded form again dropped the watcher it was seeded with and added
  // three it had never had.
  const autoNotify: AutoEntryWithRequires[] = (() => {
    const slabs = fieldTypes.has("money") ? slabNotify : [];
    if (savedAuto === null) {
      return [...BASE_AUTO_NOTIFY.filter((a) => !a._requires || fieldTypes.has(a._requires)).map(named), ...slabs];
    }
    const kept: AutoEntryWithRequires[] = savedAuto.map((r, i) => {
      const role = ruleRole(r.label);
      const def = BASE_AUTO_NOTIFY.find((a) => a.label === role && a.user_id === null);
      if (def) return def;
      return named({
        id: `saved-watch-${i}`,
        user_id: r.user_id,
        label: r.label,
        name: r.user_id ?? "Unassigned",
        designation: "",
        reason: r.label,
      });
    });
    const roles = new Set(kept.map((k) => ruleRole(k.label ?? null)));
    const added = BASE_AUTO_NOTIFY.filter((d) => d._requires && fieldTypes.has(d._requires) && !roles.has(d.label ?? null));
    const people = new Set(kept.map((k) => k.user_id).filter(Boolean));
    return [...kept, ...added, ...slabs.filter((sl) => !people.has(sl.user_id))];
  })();

  async function handlePublish() {
    if (access !== "full") {
      navigate({ to: "/forms" });
      return;
    }
    setPublishing(true);
    try {
      await db.from("notification_rules").delete().eq("form_template_id", templateId);

      const rows = [
        ...autoNotify.map((a) => ({
          form_template_id: templateId,
          notifyee_user_id: a.user_id,
          is_auto_added: true,
          // The role for the engine to resolve, or the band text for a
          // finance watcher, which is a fixed person.
          label: a.label ?? a.reason,
        })),
        ...manual.map((m) => {
          const w = when[m.user_id] ?? DEFAULT_WHEN;
          const role = m.user_id.startsWith("role:") ? m.user_id.slice(5) : null;
          return {
            form_template_id: templateId,
            notifyee_user_id: role ? null : m.user_id,
            is_auto_added: false,
            label: role ?? "Manually added",
            events: w.events.length ? w.events : ["raised"],
            condition: w.condition && w.condition.field ? w.condition : null,
          };
        }),
      ];
      const { error: nrErr } = await db.from("notification_rules").insert(rows);
      if (nrErr) {
        toast.error("Failed to save notifications: " + nrErr.message);
        return;
      }

      const { error: pubErr } = await db
        .from("form_templates")
        .update({ status: "published" })
        .eq("id", templateId);
      if (pubErr) {
        toast.error("Failed to publish form: " + pubErr.message);
        return;
      }

      setSavedAgo("just now");
      toast.success("Form published. Employees can now submit.");
      navigate({ to: "/forms" });
    } finally {
      setPublishing(false);
    }
  }

  function handleBack() {
    navigate({ to: "/builder/approvers", search: { templateId } });
  }

  return (
    <BuilderChrome formId={templateId}
      step={3}
      formName={formName}
      savedAgo={savedAgo}
      rightActions={
        <>
          <SecondaryButton onClick={handleBack}>← Back</SecondaryButton>
          <PrimaryButton onClick={handlePublish} disabled={publishing}>
            {publishing ? "Publishing…" : access === "full" ? "Publish Form" : "Done"}
          </PrimaryButton>
        </>
      }
    >
      {loading ? (
        <div style={{ padding: "4px 0 8px" }}>
          <LoadingRows rows={3} height={72} />
        </div>
      ) : (
      <PeopleStep
        formTemplateId={templateId}
        title="Who should be notified?"
        subtitle="These people receive a notification each time the form is submitted or progresses."
        autoEntries={autoNotify}
        showDeadline={false}
        manual={manual}
        onManualChange={setManual}
        manualRoles={WATCHER_ROLES}
      />
      )}
      {!loading && manual.length > 0 && (
        <section className="rounded-xl bg-white mt-4" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }} data-testid="notify-when">
          <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>When each is told</div>
          <div style={{ fontSize: 12, color: "#71717A", margin: "2px 0 10px" }}>
            Tick when each person hears about a request, and narrow it to requests whose answers meet a condition — e.g. only above an amount.
          </div>
          <div className="flex flex-col gap-2.5">
            {manual.map((m) => {
              const w = when[m.user_id] ?? DEFAULT_WHEN;
              const put = (patch: Partial<When>) => setWhen((all) => ({ ...all, [m.user_id]: { ...w, ...patch } }));
              const ctl = { padding: "5px 8px", fontSize: 12.5, border: "1px solid #E4E4E7", borderRadius: 6, background: "#fff" } as const;
              return (
                <div key={m.user_id} className="flex items-center gap-3 flex-wrap" data-watcher={m.user_id}>
                  <span style={{ fontSize: 13, color: "#18181B", minWidth: 160 }}>{m.name}</span>
                  {EVENTS.map((ev) => (
                    <label key={ev.key} className="inline-flex items-center gap-1" style={{ fontSize: 12.5, color: "#3F3F46" }}>
                      <input type="checkbox" aria-label={`${m.name}: ${ev.label}`} checked={w.events.includes(ev.key)}
                        onChange={(e) => put({ events: e.target.checked ? [...w.events, ev.key] : w.events.filter((x) => x !== ev.key) })} />
                      {ev.label}
                    </label>
                  ))}
                  <button type="button" onClick={() => put({ condition: w.condition ? null : { field: fieldLabels[0] ?? "", op: "gt", value: "" } })}
                    style={{ ...ctl, cursor: "pointer", color: w.condition ? "#4338CA" : "#71717A", background: w.condition ? "#EEF2FF" : "#fff" }}>
                    {w.condition ? "Only when…" : "Always"}
                  </button>
                  {w.condition && (
                    <>
                      <select aria-label={`${m.name}: condition field`} style={ctl} value={w.condition.field}
                        onChange={(e) => put({ condition: { ...w.condition!, field: e.target.value } })}>
                        {fieldLabels.map((f) => <option key={f}>{f}</option>)}
                      </select>
                      <select aria-label={`${m.name}: condition`} style={ctl} value={w.condition.op}
                        onChange={(e) => put({ condition: { ...w.condition!, op: e.target.value } })}>
                        {CONDITION_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      {!["empty", "not_empty"].includes(w.condition.op) && (
                        <input aria-label={`${m.name}: condition value`} style={{ ...ctl, width: 140 }} value={w.condition.value}
                          onChange={(e) => put({ condition: { ...w.condition!, value: e.target.value } })} />
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </BuilderChrome>
  );
}
