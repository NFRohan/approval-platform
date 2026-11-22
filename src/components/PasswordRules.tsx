import { Check, Circle } from "lucide-react";
import { passwordRules } from "@/lib/password-policy";

/** The password policy as a checklist, ticking as somebody types. The server checks the same rules. */
export function PasswordRules({ password, username }: { password: string; username?: string }) {
  const rules = passwordRules(password, username);
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1" aria-label="Password rules" style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {rules.map((r) => (
        <li
          key={r.key}
          className="flex items-center gap-1.5"
          style={{ fontSize: 11.5, color: r.ok ? "#15803D" : "#71717A" }}
          data-ok={r.ok ? "true" : "false"}
        >
          {r.ok ? <Check size={12} aria-hidden /> : <Circle size={10} aria-hidden />}
          <span>{r.label}</span>
        </li>
      ))}
    </ul>
  );
}
