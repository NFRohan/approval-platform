import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { KeyRound, ShieldCheck } from "lucide-react";
import {
  changePassword, confirmMfaSetup, disableMfa, mfaStatus, startMfaSetup, type MfaStatus,
} from "@/lib/auth-fn";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { PasswordRules } from "@/components/PasswordRules";
import { passwordProblem, PASSWORD_MAX_AGE_DAYS } from "@/lib/password-policy";
import { Button, Card, Field, Notice, Page, Pill, PERMISSION_LABELS, inputStyle } from "@/components/admin/kit";

export const Route = createFileRoute("/account")({
  head: () => ({ meta: [{ title: "Your account · Admin Services Portal" }] }),
  component: AccountPage,
});

function AccountPage() {
  const { currentUser, session } = useCurrentUser();
  const router = useRouter();
  const navigate = useNavigate();
  const [mfa, setMfa] = useState<MfaStatus | null>(null);

  useEffect(() => { void mfaStatus().then(setMfa); }, []);

  const must = session?.mustChangePassword === true;

  return (
    <Page
      title="Your account"
      intro={session?.canSwitch
        ? "This evaluation's login can act as any of its people. The password and two-step sign-in below belong to the login itself."
        : "Your password, two-step sign-in, and what your roles let you do."}
    >
      {must && (
        <Notice tone="amber">
          Choose a new password before going on — either this is your first sign-in, or your password is
          more than {PASSWORD_MAX_AGE_DAYS} days old.
        </Notice>
      )}
      {session?.mfaSetupRequired && (
        <Notice tone="amber">
          Your organisation requires two-step sign-in to administer accounts, roles or the org chart.
          Until you set it up, those permissions are held back.
        </Notice>
      )}

      {!must && (
        <Card title="Who you are">
          <div className="flex flex-col gap-2" style={{ fontSize: 13.5, color: "#3F3F46" }}>
            <div><span style={{ color: "#71717A" }}>Signed in as</span> <strong>{session?.username}</strong></div>
            {currentUser.employee_id && (
              <div>
                <span style={{ color: "#71717A" }}>{session?.canSwitch ? "Acting as" : "Employee"}</span>{" "}
                <strong>{currentUser.name}</strong> · {currentUser.designation} · {currentUser.employee_id}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5" style={{ marginTop: 4 }} data-testid="my-permissions">
              {currentUser.permissions.length === 0
                ? <span style={{ color: "#71717A" }}>No administrative permissions — raise and approve requests.</span>
                : currentUser.permissions.map((p) => <Pill key={p} tone="brand">{PERMISSION_LABELS[p] ?? p}</Pill>)}
            </div>
          </div>
        </Card>
      )}

      {mfa?.directory ? (
        <Card title="Password">
          <p style={{ fontSize: 13, color: "#52525B", margin: 0 }}>
            You sign in with your directory password. Change it the way your organisation changes it.
          </p>
        </Card>
      ) : (
        <PasswordCard
          username={session?.username ?? ""}
          onChanged={async () => {
            await router.invalidate();
            if (must) navigate({ to: session?.isStaff ? "/staff" : "/" });
          }}
        />
      )}

      {!must && mfa && (
        <MfaCard status={mfa} username={session?.username ?? ""} onChange={async () => {
          setMfa(await mfaStatus());
          await router.invalidate();
        }} />
      )}
    </Page>
  );
}

function PasswordCard({ username, onChanged }: { username: string; onChanged: () => Promise<void> }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== again) return setError("Those two passwords are not the same.");
    const problem = passwordProblem(next, username);
    if (problem) return setError(problem);
    setBusy(true);
    const r = await changePassword({ data: { current, next } });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Could not change it.");
    setCurrent(""); setNext(""); setAgain("");
    toast.success("Password changed");
    await onChanged();
  }

  return (
    <Card title={<span className="inline-flex items-center gap-2"><KeyRound size={15} /> Password</span>}>
      <form onSubmit={save} className="flex flex-col gap-3.5" style={{ maxWidth: 420 }}>
        <Field label="Current password">
          <input name="current" type="password" autoComplete="current-password" style={inputStyle} value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password">
          <input name="next" type="password" autoComplete="new-password" style={inputStyle} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Again">
          <input name="again" type="password" autoComplete="new-password" style={inputStyle} value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        <PasswordRules password={next} username={username} />
        <p style={{ fontSize: 11.5, color: "#71717A", margin: 0 }}>
          Not one of your last five. Passwords last {PASSWORD_MAX_AGE_DAYS} days.
        </p>
        {error && <Notice tone="red">{error}</Notice>}
        <div><Button type="submit" tone="brand" busy={busy}>Change password</Button></div>
      </form>
    </Card>
  );
}

function MfaCard({ status, username, onChange }: { status: MfaStatus; username: string; onChange: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin() {
    setError(null);
    setBusy(true);
    const r = await startMfaSetup();
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSetup({ secret: r.secret, url: r.url });
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const r = await confirmMfaSetup({ data: { code } });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "That code is not right.");
    setSetup(null); setCode("");
    toast.success("Two-step sign-in is on");
    await onChange();
  }

  async function turnOff(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const r = await disableMfa({ data: { code } });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "That code is not right.");
    setCode("");
    toast.success("Two-step sign-in is off");
    await onChange();
  }

  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><ShieldCheck size={15} /> Two-step sign-in</span>}
      aside={status.enabled ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>}
    >
      {status.enabled ? (
        <form onSubmit={turnOff} className="flex flex-col gap-3" style={{ maxWidth: 420 }}>
          <p style={{ fontSize: 13, color: "#52525B", margin: 0 }}>
            Signing in as {username} asks for a code from your authenticator app. To turn it off, or to move it to
            another phone, enter a current code.
          </p>
          <Field label="Code">
            <input name="code" inputMode="numeric" autoComplete="one-time-code" style={inputStyle} value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          {error && <Notice tone="red">{error}</Notice>}
          <div><Button type="submit" tone="danger" busy={busy}>Turn off</Button></div>
        </form>
      ) : setup ? (
        <form onSubmit={confirm} className="flex flex-col gap-3">
          <p style={{ fontSize: 13, color: "#52525B", margin: 0 }}>
            Scan this with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…),
            then enter the six-digit code it shows.
          </p>
          <div className="flex items-start gap-5 flex-wrap">
            <div style={{ padding: 10, background: "#fff", border: "1px solid #E4E4E7", borderRadius: 8 }}>
              <QRCodeSVG value={setup.url} size={164} />
            </div>
            <div style={{ fontSize: 12, color: "#71717A", maxWidth: 260 }}>
              Can't scan? Enter this key by hand:
              <code data-testid="mfa-secret" style={{ display: "block", marginTop: 6, fontSize: 13, color: "#18181B", wordBreak: "break-all", letterSpacing: "0.05em" }}>
                {setup.secret}
              </code>
            </div>
          </div>
          <div style={{ maxWidth: 260 }}>
            <Field label="Code from the app">
              <input name="code" inputMode="numeric" autoComplete="one-time-code" style={inputStyle} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
          </div>
          {error && <Notice tone="red">{error}</Notice>}
          <div className="flex gap-2">
            <Button type="submit" tone="brand" busy={busy}>Turn on</Button>
            <Button onClick={() => { setSetup(null); setCode(""); }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p style={{ fontSize: 13, color: "#52525B", margin: 0 }}>
            Ask for a code from your phone as well as your password when signing in.
            {status.required && " Your organisation requires it for your administrative roles."}
          </p>
          {error && <Notice tone="red">{error}</Notice>}
          <div><Button tone="brand" busy={busy} onClick={begin}>Set up two-step sign-in</Button></div>
        </div>
      )}
    </Card>
  );
}
