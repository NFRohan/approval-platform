// =====================================================================
// The activity log and the audit trail, in words people use.
//
// Events are recorded as the system knows them ("persona_switched",
// "bKash.eval now acting as Farhana Sultana (EMP-0445)", "48 ticket(s)
// imported…", "approval.overdue · …"). The trail itself is never
// rewritten: it is evidence. These turn a row into a sentence when it
// is shown, so old entries read as well as new ones.
// =====================================================================

import { DEFAULT_EMAIL_TEMPLATES } from "@/lib/email-templates";

const KIND_LABEL = new Map(DEFAULT_EMAIL_TEMPLATES.map((t) => [t.kind, t.label]));

const sentence = (s: string) => s.replace(/^\s*([a-z])/, (_m, c: string) => c.toUpperCase());

/** "approval.overdue" → "An approval is overdue"; anything else as it is. */
export function kindLabel(kind: string): string {
  return KIND_LABEL.get(kind) ?? kind;
}

/** A recorded detail, as a sentence. */
export function plainDetail(action: string, detail: string | null | undefined): string | null {
  if (!detail) return null;
  let d = detail.trim();

  if (action === "persona_switched") {
    const m = /now acting as (.+?)(?: \([A-Z]+-\d+\))?$/.exec(d);
    if (m) return `Switched to ${m[1]}`;
  }
  if (action === "signed_in") {
    if (/^\S+ signed in$/.test(d)) return null;            // the row already says "Signed in"
    const m = /^\S+ signed in (with .+)$/.exec(d);
    if (m) return sentence(m[1]);
  }
  if (action === "legacy_import") {
    const m = /^(\d+) ticket\(s\) imported from (.+?);/.exec(d);
    if (m) {
      const n = Number(m[1]);
      return `Imported ${n} closed ${m[2]} ${n === 1 ? "ticket" : "tickets"}`;
    }
  }
  // A notification kind at the front ("approval.overdue · …") reads as its name.
  d = d.replace(/^([a-z]+(?:\.[a-z_]+)+)(\s*·\s*)/, (_m, kind: string, sep: string) => `${kindLabel(kind)}${sep}`);
  d = d.replace(/\((s)\)/g, "s");
  return sentence(d);
}

const ENTITY: Record<string, string> = {
  form_submission: "Request", movement_order: "Movement order", notice: "Notice",
  form_template: "Configuration", approval_rule: "Configuration", app_user: "Account",
  role: "Role", employee: "People", campaign: "Campaign", report_template: "Report",
};

/** What a row is about, as a word. */
export function entityWord(type: string | null | undefined): string {
  if (!type) return "";
  return ENTITY[type] ?? sentence(type.replace(/_/g, " "));
}

const ACTION: Record<string, string> = {
  persona_switched: "switched persona", signed_in: "signed in", legacy_import: "migrated tickets",
  configuration_changed: "changed configuration", clarification_requested: "asked for clarification",
};

/** The verb of an activity row, lower case, to follow a name. */
export function actionWords(action: string): string {
  return ACTION[action] ?? action.replace(/_/g, " ");
}
