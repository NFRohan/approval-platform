// =====================================================================
// The password policy.
//
// "Minimum 12 characters; upper and lower case, a number and a special
// character; changed every 90 days; not one of the last 5; locked after
// 10 failed attempts."
//
// Pure, so the sign-in page can show what is missing as somebody types
// and the server can refuse the same thing. The server is what counts.
// =====================================================================

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_AGE_DAYS = 90;
export const PASSWORD_HISTORY = 5;
export const LOCKOUT_ATTEMPTS = 10;
/** A lock lifts on its own after this long, or sooner when an administrator unlocks it. */
export const LOCKOUT_MINUTES = 30;

export type PolicyRule = { key: string; label: string; ok: boolean };

export function passwordRules(password: string, username = ''): PolicyRule[] {
  const p = String(password ?? '');
  const name = String(username ?? '').trim().toLowerCase();
  return [
    { key: 'length',  label: `At least ${PASSWORD_MIN_LENGTH} characters`, ok: p.length >= PASSWORD_MIN_LENGTH },
    { key: 'upper',   label: 'An upper-case letter',                       ok: /[A-Z]/.test(p) },
    { key: 'lower',   label: 'A lower-case letter',                        ok: /[a-z]/.test(p) },
    { key: 'digit',   label: 'A number',                                   ok: /[0-9]/.test(p) },
    { key: 'special', label: 'A special character',                        ok: /[^A-Za-z0-9]/.test(p) },
    { key: 'name',    label: 'Not containing your username',
      ok: name.length < 3 || !p.toLowerCase().includes(name) },
  ];
}

/** The first rule a password breaks, written for the person typing it, or null. */
export function passwordProblem(password: string, username = ''): string | null {
  const broken = passwordRules(password, username).filter((r) => !r.ok);
  if (!broken.length) return null;
  return 'The password needs: ' + broken.map((r) => r.label.toLowerCase()).join(', ') + '.';
}
