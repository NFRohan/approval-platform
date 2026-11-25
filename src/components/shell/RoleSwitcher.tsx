import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, UserRound } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { initialsOf, useCurrentUser } from "@/contexts/CurrentUserContext";
import { listPersonas, type Persona } from "@/lib/auth-fn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar } from "./Avatar";

/**
 * Who is acting.
 *
 * A person's own account always acts as them, so for them this is just a
 * name and a way to their account page. An evaluation's login can act as
 * anybody in the organisation: switching is a request to the server,
 * which checks it, records it in the activity log, and reissues the
 * session — the browser never decides who it is.
 */
export function RoleSwitcher() {
  const { currentUser, setCurrentUser, users, session } = useCurrentUser();
  const navigate = useNavigate();
  const [people, setPeople] = useState<Persona[] | null>(null);
  const [filter, setFilter] = useState("");
  // Pick a department, then somebody in it: with twenty-odd people the
  // list alone is a lot to read through.
  const [dept, setDept] = useState("");

  const canSwitch = session?.canSwitch === true;

  useEffect(() => {
    if (canSwitch && people === null) void listPersonas().then(setPeople);
  }, [canSwitch, people]);

  const all = useMemo(() => people ?? users.map((u) => ({ ...u, department: null, roles: [] as string[] })), [people, users]);
  const departments = useMemo(() => {
    const n = new Map<string, number>();
    for (const p of all) n.set(p.department ?? "Other", (n.get(p.department ?? "Other") ?? 0) + 1);
    return [...n.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [all]);

  // Grouped by department, each in the demonstration's own order, then by name.
  const groups = useMemo(() => {
    const rank = new Map(users.map((u, i) => [u.employee_id, i]));
    const q = filter.trim().toLowerCase();
    const shown = [...all]
      .filter((p) => !dept || (p.department ?? "Other") === dept)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.designation ?? "").toLowerCase().includes(q)
        || p.employee_id.toLowerCase().includes(q) || (p.department ?? "").toLowerCase().includes(q))
      .sort((a, b) => (a.department ?? "Other").localeCompare(b.department ?? "Other")
        || (rank.get(a.employee_id) ?? 999) - (rank.get(b.employee_id) ?? 999) || a.name.localeCompare(b.name));
    const out: { department: string; people: typeof shown }[] = [];
    for (const p of shown) {
      const d = p.department ?? "Other";
      if (out.at(-1)?.department !== d) out.push({ department: d, people: [] });
      out.at(-1)!.people.push(p);
    }
    return out;
  }, [all, users, filter, dept]);

  const face = (
    <>
      <Avatar initials={currentUser.initials} size={32} brand />
      <div className="text-left leading-tight hidden sm:block">
        <div className="text-[12.5px] font-medium text-zinc-900" data-testid="acting-as">{currentUser.name}</div>
        <div className="text-[10.5px] text-zinc-500">{currentUser.designation}</div>
      </div>
    </>
  );

  if (!canSwitch) {
    return (
      <Link
        to="/account"
        className="flex items-center gap-2 rounded-lg transition-colors hover:bg-zinc-100"
        style={{ padding: "4px 8px 4px 4px", textDecoration: "none" }}
        title="Your account"
      >
        {face}
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-lg cursor-pointer transition-colors hover:bg-zinc-100"
          style={{ padding: "4px 8px 4px 4px" }}
          aria-label="Switch persona"
        >
          {face}
          <ChevronDown size={14} className="text-zinc-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold">
          Act as
        </DropdownMenuLabel>
        <div className="flex flex-col gap-1.5" style={{ padding: "2px 8px 6px" }} onKeyDown={(e) => e.stopPropagation()}>
          <select
            aria-label="Department"
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            style={{ width: "100%", padding: "6px 8px", fontSize: 12.5, border: "1px solid #E4E4E7", borderRadius: 6, background: "#fff", color: "#18181B" }}
          >
            <option value="">All departments ({all.length})</option>
            {departments.map(([d, n]) => <option key={d} value={d}>{d} ({n})</option>)}
          </select>
          <input
            placeholder="Find somebody"
            aria-label="Find somebody"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: "100%", padding: "6px 8px", fontSize: 12.5, border: "1px solid #E4E4E7", borderRadius: 6 }}
          />
        </div>
        <DropdownMenuSeparator />
        <div style={{ maxHeight: 380, overflowY: "auto" }}>
          {groups.length === 0 && (
            <div style={{ padding: "10px 12px", fontSize: 12.5, color: "#A1A1AA" }}>Nobody matches.</div>
          )}
          {groups.map((g) => (
            <div key={g.department} role="group" aria-label={g.department}>
              {!dept && (
                <div className="text-[10.5px] uppercase tracking-wider font-semibold text-zinc-400" style={{ padding: "8px 10px 2px" }}>
                  {g.department}
                </div>
              )}
          {g.people.map((u) => {
            const active = u.employee_id === currentUser.employee_id;
            return (
              <DropdownMenuItem
                key={u.employee_id}
                onSelect={async () => {
                  const r = await setCurrentUser(u);
                  if (!r.ok) { toast.error(r.error ?? "Could not switch."); return; }
                  // Drop any ?as= in the address, or it would switch straight back.
                  void navigate({ to: "/", search: {} });
                }}
                className="flex items-center gap-3 py-2 cursor-pointer"
              >
                <Avatar initials={initialsOf(u.name)} size={28} brand={active} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-zinc-900 truncate">{u.name}</div>
                  <div className="text-[11px] text-zinc-500 truncate">{u.designation}</div>
                  {u.roles.length > 0 && (
                    <div className="text-[10.5px] truncate" style={{ color: "#4338CA" }}>{u.roles.join(" · ")}</div>
                  )}
                </div>
                {active && <Check size={14} style={{ color: "var(--color-brand-500)" }} />}
              </DropdownMenuItem>
            );
          })}
            </div>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate({ to: "/account" })} className="flex items-center gap-2 cursor-pointer">
          <UserRound size={14} /> <span className="text-[13px]">Account and two-step sign-in</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
