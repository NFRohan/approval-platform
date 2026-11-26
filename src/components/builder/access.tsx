// =====================================================================
// What the acting person may do in the builder.
//
//   full      forms.build: design the form and its routes
//   settings  forms.settings: change task settings — each step's
//             deadline and whether it needs a signature — and nothing else
//   read      everybody else: look, change nothing
//
// The database enforces all three (the builder tables need forms.build;
// task settings go through update_rule_settings). This only decides
// what the screens offer, so nobody is invited to make a change that
// will be refused.
// =====================================================================

import { Eye, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

export type BuilderAccess = "full" | "settings" | "read";

export function useBuilderAccess(formId?: string | null): BuilderAccess {
  const { can } = useCurrentUser();
  const base: BuilderAccess = can("forms.build") ? "full" : can("forms.settings") ? "settings" : "read";
  // On a particular form, what the person may do with that form: a
  // designer limited to one division designs that division's forms and
  // only looks at the rest (db/009_sow_gaps.sql may_design_form).
  const [perForm, setPerForm] = useState<BuilderAccess | null>(null);
  useEffect(() => {
    setPerForm(null);
    if (!formId || base === "read") return;
    let alive = true;
    void db.rpc("may_design_form", { p_form: formId }).then(({ data }) => {
      if (alive && (data === "full" || data === "settings" || data === "read")) setPerForm(data);
    });
    return () => { alive = false; };
  }, [formId, base]);
  return formId && perForm ? perForm : base;
}

export function AccessBanner({ access }: { access: BuilderAccess }) {
  if (access === "full") return null;
  const settings = access === "settings";
  return (
    <div
      role="status"
      data-testid="builder-access"
      className="flex items-center gap-2 shrink-0"
      style={{
        padding: "8px 20px", fontSize: 12.5,
        background: settings ? "#EEF2FF" : "#F4F4F5",
        color: settings ? "#3730A3" : "#52525B",
        borderBottom: `1px solid ${settings ? "#C7D2FE" : "#E4E4E7"}`,
      }}
    >
      {settings ? <SlidersHorizontal size={13} /> : <Eye size={13} />}
      {settings
        ? "You can change this workflow's task settings — each step's deadline and whether it needs a signature. Changing the form or who approves it needs the Workflow designer role."
        : "You are viewing this workflow. Changing it needs the Workflow designer role."}
    </div>
  );
}
