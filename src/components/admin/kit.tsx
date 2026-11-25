// Shared pieces for the account and administration screens, in the
// portal's existing idiom: inline styles on zinc, brand for the one
// action that matters on a card.

import type { CSSProperties, ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  border: "1px solid #E4E4E7",
  borderRadius: 6,
  background: "#fff",
  color: "#18181B",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

export function Page({ title, intro, children, wide, full }: { title: string; intro?: ReactNode; children: ReactNode; wide?: boolean; full?: boolean }) {
  return (
    <div className={full ? "max-w-7xl mx-auto" : wide ? "max-w-5xl mx-auto" : "max-w-3xl mx-auto"} style={{ padding: "32px 28px 56px" }}>
      <div className="mb-6">
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }}>{title}</h1>
        {intro && <p style={{ marginTop: 6, fontSize: 14, color: "#71717A", lineHeight: 1.55 }}>{intro}</p>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, aside, children, style }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <section className="rounded-xl bg-white mb-5" style={{ border: "1px solid #E4E4E7", padding: 20, ...style }}>
      {(title || aside) && (
        <div className="flex items-center justify-between gap-3" style={{ marginBottom: 14 }}>
          {title && <h2 style={{ fontSize: 15, fontWeight: 600, color: "#18181B", margin: 0 }}>{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11.5, color: "#71717A" }}>{hint}</span>}
    </label>
  );
}

type Tone = "brand" | "plain" | "danger" | "good";

export function Button({
  children, onClick, tone = "plain", busy, disabled, type = "button", small, title, name,
}: {
  children: ReactNode; onClick?: () => void; tone?: Tone; busy?: boolean; disabled?: boolean;
  type?: "button" | "submit"; small?: boolean; title?: string; name?: string;
}) {
  const palette: Record<Tone, CSSProperties> = {
    brand:  { background: "var(--color-brand-500)", color: "#fff", border: "1px solid transparent" },
    plain:  { background: "#fff", color: "#3F3F46", border: "1px solid #E4E4E7" },
    danger: { background: "#fff", color: "#B91C1C", border: "1px solid #FECACA" },
    good:   { background: "#fff", color: "#15803D", border: "1px solid #BBF7D0" },
  };
  const off = disabled || busy;
  return (
    <button
      type={type}
      name={name}
      title={title}
      onClick={onClick}
      disabled={off}
      className="inline-flex items-center gap-1.5 rounded-md"
      style={{
        ...palette[tone],
        padding: small ? "4px 9px" : "8px 14px",
        fontSize: small ? 12 : 13,
        fontWeight: 500,
        cursor: off ? "not-allowed" : "pointer",
        opacity: off ? 0.55 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

const PILL: Record<string, { bg: string; fg: string; bd: string }> = {
  green:  { bg: "#F0FDF4", fg: "#15803D", bd: "#BBF7D0" },
  amber:  { bg: "#FFFBEB", fg: "#B45309", bd: "#FDE68A" },
  red:    { bg: "#FEF2F2", fg: "#B91C1C", bd: "#FECACA" },
  zinc:   { bg: "#F4F4F5", fg: "#52525B", bd: "#E4E4E7" },
  brand:  { bg: "#EEF2FF", fg: "#4338CA", bd: "#C7D2FE" },
};

export function Pill({ children, tone = "zinc", title }: { children: ReactNode; tone?: keyof typeof PILL; title?: string }) {
  const c = PILL[tone];
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-full"
      style={{ padding: "1px 8px", fontSize: 11, fontWeight: 500, background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, whiteSpace: "nowrap" }}
    >
      {children}
    </span>
  );
}

export function Notice({ children, tone = "amber" }: { children: ReactNode; tone?: "amber" | "red" | "zinc" | "green" }) {
  const c = PILL[tone];
  return (
    <div role="status" className="rounded-lg mb-4" style={{ padding: "11px 14px", fontSize: 13, background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

/** Shown in place of a screen the acting person has no permission for. The database refuses regardless. */
export function NoPermission({ need }: { need: string }) {
  return (
    <div className="rounded-xl text-center" style={{ padding: "48px 24px", border: "1px dashed #E4E4E7", color: "#71717A", fontSize: 13.5 }}>
      <ShieldAlert size={22} style={{ margin: "0 auto 10px", color: "#A1A1AA" }} />
      This needs the <strong>{need}</strong> permission, which your roles do not grant.
    </div>
  );
}

/** Shown once: a password the server generated and does not keep. */
export function OneTimeSecret({ label, value, onDone, note }: { label: string; value: string; onDone: () => void; note?: string }) {
  return (
    <div className="rounded-lg mb-4" style={{ padding: "14px 16px", background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
      <div style={{ fontSize: 13, color: "#14532D", marginBottom: 8 }}>{label}</div>
      <div className="flex items-center gap-2 flex-wrap">
        <code data-testid="one-time-secret" style={{ fontSize: 15, wordBreak: "break-all", padding: "6px 10px", background: "#fff", border: "1px solid #BBF7D0", borderRadius: 6, letterSpacing: "0.03em" }}>
          {value}
        </code>
        <Button small onClick={() => void navigator.clipboard?.writeText(value)}>Copy</Button>
        <Button small onClick={onDone}>Done</Button>
      </div>
      <div style={{ fontSize: 11.5, color: "#166534", marginTop: 8 }}>
        {note ?? "It is not stored and cannot be shown again. It must be changed at first sign-in."}
      </div>
    </div>
  );
}

export const PERMISSION_LABELS: Record<string, string> = {
  "forms.build": "Design workflows",
  "forms.settings": "Change task settings",
  "users.manage": "Manage accounts",
  "users.approve": "Approve accounts",
  "roles.manage": "Manage roles",
  "roles.approve": "Approve roles",
  "org.manage": "Org chart and HR data",
  "audit.view": "Read audit trails",
  "reports.view": "Reports and analytics",
  "reports.manage": "Manage report templates",
  "notifications.manage": "Email templates and log",
  "integrations.manage": "API keys and webhooks",
  "records.manage": "Retention and archive",
};

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
