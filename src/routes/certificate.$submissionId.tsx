import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { Printer, ArrowLeft } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { db } from "@/lib/db";
import { organisationName } from "@/lib/org-fn";
import { fmtDate as fmtDateLib } from "@/lib/dates";

export const Route = createFileRoute("/certificate/$submissionId")({
  head: () => ({
    meta: [{ title: "Clearance Certificate · Admin Services Portal" }],
  }),
  component: CertificatePage,
});

type ApprovalRow = {
  id: string;
  approver_user_id: string | null;
  status: string | null;
  acted_at: string | null;
};

type EmployeeRow = {
  employee_id: string;
  name: string;
  designation: string | null;
  department: string | null;
};

type SubmissionValue = {
  field_name: string;
  value: string | null;
};

function fmtDate(iso?: string | null) {
  return fmtDateLib(iso);
}

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function CertificatePage() {
  const { submissionId } = Route.useParams();

  const [submitter, setSubmitter] = useState<EmployeeRow | null>(null);
  const [formName, setFormName] = useState("");
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [employees, setEmployees] = useState<Record<string, EmployeeRow>>({});
  const [department, setDepartment] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [org, setOrg] = useState("");
  // Only a clearance — departments ticking checklists — has a certificate.
  const [isClearance, setIsClearance] = useState(true);
  const [missing, setMissing] = useState(false);

  const [refNumber, setRefNumber] = useState<string | null>(null);
  const refCode = refNumber ?? `AMS-${submissionId.slice(0, 8).toUpperCase()}`;
  const verifyUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/status/${submissionId}`;

  const load = useCallback(async () => {
    const { data: sub } = await db
      .from("form_submissions")
      .select("submitted_by, submitted_at, form_template_id, ref_number")
      .eq("id", submissionId)
      .maybeSingle();
    // Not there, or not one this person may see — the same answer either way.
    if (!sub) { setMissing(true); setLoading(false); return; }
    setRefNumber((sub as { ref_number?: string | null } | null)?.ref_number ?? null);

    if (sub?.form_template_id) {
      const { data: tpl } = await db
        .from("form_templates")
        .select("name")
        .eq("id", sub.form_template_id)
        .maybeSingle();
      if (tpl?.name) setFormName(tpl.name);
      const { count } = await db.from("checklist_items").select("id", { count: "exact", head: true }).eq("form_template_id", sub.form_template_id);
      setIsClearance((count ?? 0) > 0);
    }
    void organisationName().then(setOrg).catch(() => setOrg("Admin Services Portal"));
    setSubmittedAt(sub?.submitted_at ?? null);

    if (sub?.submitted_by) {
      const { data: emp } = await db
        .from("employees")
        .select("employee_id, name, designation, department")
        .eq("employee_id", sub.submitted_by)
        .maybeSingle();
      setSubmitter(emp as EmployeeRow | null);
    }

    // Grab department from submission values
    const { data: vals } = await db
      .from("submission_values")
      .select("field_name, value")
      .eq("submission_id", submissionId);
    const deptVal = (vals as SubmissionValue[] | null)?.find(
      (v) => v.field_name.toLowerCase().includes("department"),
    );
    if (deptVal?.value) setDepartment(deptVal.value);

    const { data: appr } = await db
      .from("approval_requests")
      .select("id, approver_user_id, status, acted_at")
      .eq("submission_id", submissionId)
      .eq("status", "approved")
      .order("acted_at", { ascending: true });
    const list = (appr as ApprovalRow[] | null) ?? [];
    setApprovals(list);

    const ids = Array.from(new Set(list.map((r) => r.approver_user_id).filter(Boolean) as string[]));
    if (ids.length) {
      const { data: emps } = await db
        .from("employees")
        .select("employee_id, name, designation, department")
        .in("employee_id", ids);
      const map: Record<string, EmployeeRow> = {};
      (emps as EmployeeRow[] | null)?.forEach((e) => { map[e.employee_id] = e; });
      setEmployees(map);
    }

    setLoading(false);
  }, [submissionId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen text-sm" style={{ color: "#71717A" }}>
        Loading certificate…
      </div>
    );
  }

  if (missing) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ padding: 24 }}>
        <div className="text-center" style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#18181B" }}>Certificate not found</div>
          <p style={{ fontSize: 13.5, color: "#71717A", lineHeight: 1.55 }}>
            There is no request with that reference that you can open.
          </p>
          <Link to="/submissions" className="rounded-md text-sm font-medium inline-block mt-3" style={{ padding: "8px 14px", border: "1px solid #E4E4E7", color: "#3F3F46" }}>My submissions</Link>
        </div>
      </div>
    );
  }

  if (!isClearance) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ padding: 24 }}>
        <div className="text-center" style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#18181B" }}>No clearance certificate for this request</div>
          <p style={{ fontSize: 13.5, color: "#71717A", lineHeight: 1.55 }}>
            A certificate is issued when every department has cleared a leaver. {formName || "This request"} ends in its approval record instead.
          </p>
          <div className="flex gap-3 justify-center mt-4">
            <a href={`/records/${submissionId}`} className="rounded-md text-white text-sm font-medium" style={{ padding: "8px 14px", background: "var(--color-brand-500)" }}>Approval record (PDF)</a>
            <Link to="/status/$submissionId" params={{ submissionId }} className="rounded-md text-sm font-medium" style={{ padding: "8px 14px", border: "1px solid #E4E4E7", color: "#3F3F46" }}>Back to the request</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Controls — hidden when printing */}
      <div className="no-print flex items-center gap-3" style={{ padding: "16px 24px", borderBottom: "1px solid #E4E4E7", background: "#fff" }}>
        <Link to="/status/$submissionId" params={{ submissionId }} className="inline-flex items-center gap-1.5 text-sm" style={{ color: "#71717A" }}>
          <ArrowLeft size={14} /> Back to status
        </Link>
        <button
          onClick={() => window.print()}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md text-white text-sm font-medium"
          style={{ padding: "7px 14px", background: "var(--color-brand-500)" }}
        >
          <Printer size={14} /> Print / Save PDF
        </button>
      </div>

      {/* Certificate */}
      <div className="certificate-page" style={{ padding: "40px 24px 60px", minHeight: "100vh", background: "#F9FAFB" }}>
        <div
          style={{
            maxWidth: 720,
            margin: "0 auto",
            background: "#fff",
            border: "1px solid #E4E4E7",
            borderRadius: 16,
            overflow: "hidden",
            boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
          }}
        >
          {/* Header stripe */}
          <div style={{ background: "#4F46E5", padding: "28px 40px 24px" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-white font-bold" style={{ fontSize: 22, letterSpacing: "-0.01em" }}>{org || "\u00a0"}</div>
                <div style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, marginTop: 2 }}>Internal Approval Management System</div>
              </div>
              {/* brand mark */}
              {/* The portal's own mark: a check, for sign-off. */}
              <svg width={44} height={44} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style={{ borderRadius: 10, background: "rgba(255,255,255,0.15)" }}>
                <path d="M28 52 L44 68 L74 32" fill="none" stroke="#fff" strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>

          {/* Certificate title */}
          <div style={{ padding: "32px 40px 0", textAlign: "center" }}>
            <div
              style={{
                display: "inline-block",
                border: "2px solid #4F46E5",
                borderRadius: 6,
                padding: "6px 18px",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "#4F46E5",
                marginBottom: 16,
              }}
            >
              Clearance Certificate
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#18181B", margin: "0 0 8px", letterSpacing: "-0.01em" }}>
              Company Clearance Certificate
            </h1>
            <p style={{ fontSize: 13, color: "#71717A", margin: 0 }}>
              This certifies that the following employee has completed all required clearance formalities.
            </p>
          </div>

          {/* Employee card */}
          <div style={{ margin: "28px 40px 0", padding: "20px 24px", background: "#F5F7FF", border: "1px solid #C7D2FE", borderRadius: 12 }}>
            <div className="flex items-center gap-4">
              <div
                className="flex items-center justify-center rounded-full font-bold text-white"
                style={{ width: 52, height: 52, background: "#4F46E5", fontSize: 18, flexShrink: 0 }}
              >
                {submitter ? initials(submitter.name) : "?"}
              </div>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#18181B" }}>{submitter?.name ?? "—"}</div>
                <div style={{ fontSize: 13, color: "#71717A", marginTop: 2 }}>
                  {submitter?.designation ?? "—"}
                  {department ? ` · ${department}` : submitter?.department ? ` · ${submitter.department}` : ""}
                </div>
                <div style={{ fontSize: 12, color: "#A1A1AA", marginTop: 1, fontFamily: "monospace" }}>
                  {submitter?.employee_id ?? "—"}
                </div>
              </div>
            </div>
          </div>

          {/* Form + date details */}
          <div style={{ margin: "20px 40px 0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[
              { label: "Form Completed", value: formName },
              { label: "Submission Reference", value: refCode },
              { label: "Date Submitted", value: fmtDate(submittedAt) },
              { label: "Certificate Issued", value: fmtDate(new Date().toISOString()) },
            ].map(({ label, value }) => (
              <div key={label} style={{ padding: "12px 16px", background: "#FAFAFA", border: "1px solid #F4F4F5", borderRadius: 8 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#A1A1AA", marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Approval signatures */}
          {approvals.length > 0 && (
            <div style={{ margin: "24px 40px 0" }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#52525B", marginBottom: 12 }}>
                Approved By
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
                {approvals.map((appr) => {
                  const emp = appr.approver_user_id ? employees[appr.approver_user_id] : undefined;
                  return (
                    <div key={appr.id} style={{ padding: "14px 16px", border: "1px solid #E4E4E7", borderRadius: 10, background: "#FAFAFA" }}>
                      <div
                        className="flex items-center justify-center rounded-full font-semibold text-white mb-2"
                        style={{ width: 32, height: 32, background: "#22C55E", fontSize: 12 }}
                      >
                        ✓
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B", lineHeight: 1.3 }}>{emp?.name ?? appr.approver_user_id}</div>
                      <div style={{ fontSize: 11, color: "#71717A", marginTop: 2 }}>{emp?.designation ?? "Approver"}</div>
                      <div style={{ fontSize: 11, color: "#A1A1AA", marginTop: 6 }}>{fmtDate(appr.acted_at)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* QR + footer */}
          <div
            style={{
              margin: "28px 40px 0",
              paddingTop: 20,
              borderTop: "1px dashed #E4E4E7",
              display: "flex",
              alignItems: "flex-start",
              gap: 20,
              paddingBottom: 32,
            }}
          >
            <div style={{ flexShrink: 0 }}>
              <QRCodeSVG value={verifyUrl} size={88} fgColor="#18181B" bgColor="#fff" />
              <div style={{ fontSize: 9.5, color: "#A1A1AA", marginTop: 4, textAlign: "center" }}>Scan to verify</div>
            </div>
            <div style={{ fontSize: 12, color: "#71717A", lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, color: "#52525B", marginBottom: 4 }}>Document Authenticity</div>
              This certificate is issued by the Approval Management System and is valid as an official record of clearance.
              Verify authenticity by scanning the QR code or visiting:
              <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A1A1AA", marginTop: 4, wordBreak: "break-all" }}>{verifyUrl}</div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .certificate-page { padding: 0 !important; background: white !important; }
        }
      `}</style>
    </>
  );
}
