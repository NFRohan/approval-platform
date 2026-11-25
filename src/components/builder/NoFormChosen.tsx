import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";

/**
 * A builder step opened with no form chosen — a bookmark, a reload, a link
 * shared without its form. Say so and point back to the forms, rather than
 * asking the server about a form nobody named.
 */
export function NoFormChosen({ step }: { step: string }) {
  return (
    <div className="flex items-center justify-center" style={{ minHeight: "60vh", padding: 24 }}>
      <div className="text-center" style={{ maxWidth: 420 }}>
        <div className="inline-flex items-center justify-center rounded-full mb-3" style={{ width: 44, height: 44, background: "#EEF2FF", color: "var(--color-brand-500)" }}>
          <FileText size={20} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#18181B" }}>Choose a form first</div>
        <p style={{ fontSize: 13.5, color: "#71717A", lineHeight: 1.55, margin: "6px 0 16px" }}>
          The {step} step belongs to a form. Pick one in the form builder, or start a new one.
        </p>
        <Link to="/builder" className="rounded-md text-white text-sm font-medium inline-block" style={{ padding: "8px 14px", background: "var(--color-brand-500)" }}>
          Go to the form builder
        </Link>
      </div>
    </div>
  );
}
