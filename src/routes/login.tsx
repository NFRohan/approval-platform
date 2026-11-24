import { useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { signIn, changePassword, verifySignInCode } from "@/lib/auth-fn";
import { PasswordRules } from "@/components/PasswordRules";
import { passwordProblem } from "@/lib/password-policy";

export const Route = createFileRoute("/login")({
  // ?idle=1: signed out for inactivity. From the route, not from window,
  // so the server renders the same notice the browser does.
  // Kept as 1, which is how the idle watcher writes it: anything else is
  // rewritten by the router into a redirect.
  validateSearch: (search: Record<string, unknown>): { idle?: 1 } => ({
    idle: search.idle ? 1 : undefined,
  }),
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
  // Signed in, and on the way in. Loading the session and the first
  // screen takes a round trip or two to the database; the form used to
  // come back, empty, for that long — which read as being sent back to
  // sign in again. Until the next screen is up, it says what is happening.
  const [arriving, setArriving] = useState<null | "/" | "/staff">(null);

  // A first sign-in on a freshly issued evaluation lands here, and so
  // does a password past its 90 days.
  const [mustChange, setMustChange] = useState(false);
  // The password was right and the account uses two-step sign-in.
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const idle = Route.useSearch().idle === 1;
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const result = await signIn({ data: { username: username.trim(), password } });

    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    setBusy(false);
    if (result.mfaRequired) {
      setNeedCode(true);
      return;
    }
    await arrive(result);
  }

  async function arrive(result: { mustChangePassword: boolean; isStaff: boolean }) {
    if (result.mustChangePassword) {
      setMustChange(true);
      return;
    }
    // Staff hold no tenant, so the prospect screens have nothing to show
    // them — landing there means a dashboard of zeroes under somebody
    // else's name. Their work is the console.
    await goIn(result.isStaff ? "/staff" : "/");
  }

  async function goIn(to: "/" | "/staff") {
    setArriving(to);
    try {
      // The router cached a "no session" answer on the way in.
      await router.invalidate();
      await navigate({ to, replace: true });
    } catch {
      setArriving(null);
      setError("Signed in, but the next page did not load. Try again.");
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await verifySignInCode({ data: { code: code.trim() } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      if (/sign in again|too long/i.test(result.error)) { setNeedCode(false); setCode(""); }
      return;
    }
    if (result.mfaRequired) return;
    await arrive(result);
  }

  async function submitNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (nextPassword !== confirmPassword) {
      setError("Those two passwords are not the same.");
      return;
    }
    const problem = passwordProblem(nextPassword, username);
    if (problem) {
      setError(problem);
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
    await goIn("/");
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
          {arriving ? (
            <div role="status" aria-live="polite" className="flex items-center gap-3" style={{ padding: "18px 2px" }} data-testid="signing-in">
              <span className="animate-spin rounded-full" style={{ width: 18, height: 18, border: "2px solid #E4E4E7", borderTopColor: "#4F46E5", flex: "none" }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>Signing you in…</div>
                <div style={{ fontSize: 12.5, color: "#71717A", marginTop: 2 }}>
                  {arriving === "/staff" ? "Opening the staff console." : "Opening your dashboard."}
                </div>
              </div>
            </div>
          ) : mustChange ? (
            <form onSubmit={submitNewPassword} className="flex flex-col gap-3.5">
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#18181B" }}>
                  Choose a password
                </div>
                <p style={{ fontSize: 12.5, color: "#71717A", margin: "5px 0 0", lineHeight: 1.5 }}>
                  The one you were issued works once, and a password lasts 90 days. Pick
                  something only you know, and not one of your last five.
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
              <PasswordRules password={nextPassword} username={username} />
              {error && <Problem>{error}</Problem>}
              <Submit busy={busy} label="Save and continue" />
            </form>
          ) : needCode ? (
            <form onSubmit={submitCode} className="flex flex-col gap-3.5">
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#18181B" }}>
                  Two-step verification
                </div>
                <p style={{ fontSize: 12.5, color: "#71717A", margin: "5px 0 0", lineHeight: 1.5 }}>
                  Enter the six-digit code from your authenticator app.
                </p>
              </div>
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 12, color: "#52525B" }}>Code</span>
                <input
                  style={{ ...inputStyle, letterSpacing: "0.3em", fontVariantNumeric: "tabular-nums" }}
                  autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={7}
                  name="code" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ""))}
                />
              </label>
              {error && <Problem>{error}</Problem>}
              <Submit busy={busy} label="Verify" />
            </form>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3.5">
              {idle && !error && (
                <div
                  role="status" className="rounded-md"
                  style={{ padding: "9px 11px", fontSize: 12.5, color: "#3F3F46", background: "#F4F4F5", border: "1px solid #E4E4E7" }}
                >
                  You were signed out after 5 minutes without activity.
                </div>
              )}
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
