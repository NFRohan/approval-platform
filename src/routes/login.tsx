import { useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { signIn, changePassword } from "@/lib/auth-fn";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in · Admin Services Portal" }] }),
  component: LoginPage,
});

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: 14,
  border: "1px solid #E4E4E7",
  borderRadius: 8,
  background: "#fff",
  color: "#18181B",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

function LoginPage() {
  const navigate = useNavigate();
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A first sign-in on a freshly issued evaluation lands here.
  const [mustChange, setMustChange] = useState(false);
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const result = await signIn({ data: { username: username.trim(), password } });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.mustChangePassword) {
      setMustChange(true);
      return;
    }
    // The router cached a "no session" answer on the way in.
    // The router cached a "no session" answer on the way in.
    await router.invalidate();

    // Staff hold no tenant, so the prospect screens have nothing to show
    // them — landing there means a dashboard of zeroes under somebody
    // else's name. Their work is the console.
    navigate({ to: result.isStaff ? "/staff" : "/" });
  }

  async function submitNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (nextPassword !== confirmPassword) {
      setError("Those two passwords are not the same.");
      return;
    }
    setBusy(true);
    setError(null);

    const result = await changePassword({ data: { current: password, next: nextPassword } });
    setBusy(false);

    if (!result.ok) {
      setError(result.error ?? "Could not change the password.");
      return;
    }
    toast.success("Password changed");
    await router.invalidate();
    navigate({ to: "/" });
  }

  return (
    <div
      className="flex items-center justify-center"
      style={{ minHeight: "100dvh", background: "#FAFAFA", padding: 24 }}
    >
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div className="flex items-center gap-2.5" style={{ marginBottom: 22 }}>
          <svg width={30} height={30} viewBox="0 0 100 100" aria-hidden="true">
            <rect width="100" height="100" rx="22" fill="#4F46E5" />
            <path
              d="M28 52 L44 68 L74 32" fill="none" stroke="#fff"
              strokeWidth="11" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
          <div>
            <div style={{ fontSize: 15, fontWeight: 650, color: "#18181B", letterSpacing: "-0.01em" }}>
              Admin Services Portal
            </div>
            <div style={{ fontSize: 12, color: "#71717A" }}>Sign in</div>
          </div>
        </div>

        <div
          className="rounded-xl bg-white"
          style={{ border: "1px solid #E4E4E7", padding: "22px 22px 24px" }}
        >
          {mustChange ? (
            <form onSubmit={submitNewPassword} className="flex flex-col gap-3.5">
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#18181B" }}>
                  Choose a password
                </div>
                <p style={{ fontSize: 12.5, color: "#71717A", margin: "5px 0 0", lineHeight: 1.5 }}>
                  The one you were issued works once. Pick something only you know — at least
                  10 characters.
                </p>
              </div>
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 12, color: "#52525B" }}>New password</span>
                <input
                  type="password" style={inputStyle} autoFocus autoComplete="new-password"
                  value={nextPassword} onChange={(e) => setNextPassword(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 12, color: "#52525B" }}>Again</span>
                <input
                  type="password" style={inputStyle} autoComplete="new-password"
                  value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </label>
              {error && <Problem>{error}</Problem>}
              <Submit busy={busy} label="Save and continue" />
            </form>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 12, color: "#52525B" }}>Username</span>
                <input
                  style={inputStyle} autoFocus autoComplete="username" spellCheck={false}
                  value={username} onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 12, color: "#52525B" }}>Password</span>
                <input
                  type="password" style={inputStyle} autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {error && <Problem>{error}</Problem>}
              <Submit busy={busy} label="Sign in" />
            </form>
          )}
        </div>

        <p style={{ fontSize: 11.5, color: "#A1A1AA", marginTop: 16, lineHeight: 1.55 }}>
          Evaluation accounts expire on their own. If yours has run out, ask for an extension
          rather than a new one — extending keeps everything you have already entered. Staff
          accounts do not expire.
        </p>
      </div>
    </div>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-md"
      style={{ padding: "9px 11px", fontSize: 12.5, color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FECACA" }}
    >
      {children}
    </div>
  );
}

function Submit({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="rounded-md text-white font-medium"
      style={{
        padding: "10px 14px", fontSize: 14, background: "#4F46E5",
        border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
        marginTop: 2,
      }}
    >
      {busy ? "Working…" : label}
    </button>
  );
}
