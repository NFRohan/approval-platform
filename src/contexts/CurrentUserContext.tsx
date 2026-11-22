import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { switchPersona, type PublicSession } from "@/lib/auth-fn";

export type CurrentUser = {
  employee_id: string;
  name: string;
  designation: string;
  initials: string;
  /** What this person's roles let them do. The database enforces it; this decides what to show. */
  permissions: string[];
};

// The demonstration's cast, in the order the persona switcher shows them.
// Who somebody is now comes from the session — the server decides, and
// switching is a request to it — so this list is only an ordering and a
// fallback label; anybody in the tenant can be switched to.
//
// These must match rows in `employees`. scripts/render-test.mjs checks
// the two agree. Safe to hardcode: an evaluation is a clone of the
// template, and cloning preserves employee_id.
export const USERS: Omit<CurrentUser, "permissions">[] = [
  { employee_id: "EMP-2847", name: "Tom Bexley",     designation: "Operations Analyst",       initials: "TB" },
  { employee_id: "EMP-1134", name: "Sam Lindqvist",  designation: "Line Manager",             initials: "SL" },
  { employee_id: "EMP-0312", name: "Raj Patel",      designation: "Finance Controller",       initials: "RP" },
  { employee_id: "EMP-0600", name: "Dana Whitfield", designation: "Head of Finance",          initials: "DW" },
  { employee_id: "EMP-0700", name: "Alex Mercer",    designation: "Chief Financial Officer",  initials: "AM" },
  { employee_id: "EMP-0201", name: "Nadia Okonjo",   designation: "HR Business Partner",      initials: "NO" },
  { employee_id: "EMP-0650", name: "Priya Raman",    designation: "Head of People",           initials: "PR" },
  { employee_id: "EMP-0445", name: "Farah Haddad",   designation: "Admin Officer",            initials: "FH" },
  { employee_id: "EMP-9001", name: "Ivan Petrov",    designation: "Facilities Coordinator",   initials: "IP" },
  { employee_id: "EMP-3120", name: "Mei Sun",        designation: "Procurement Specialist",   initials: "MS" },
  { employee_id: "EMP-0800", name: "Hana Kim",       designation: "Chief Operating Officer",  initials: "HK" },
  { employee_id: "EMP-0520", name: "Omar Reyes",     designation: "Head of Technology",       initials: "OR" },
  { employee_id: "EMP-0830", name: "Lena Ortiz",     designation: "Compliance Officer",       initials: "LO" },
  { employee_id: "EMP-0831", name: "Kofi Mensah",    designation: "Compliance Officer",       initials: "KM" },
  { employee_id: "EMP-0832", name: "Ravi Shah",      designation: "Compliance Officer",       initials: "RS" },
];

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function userFromSession(session: PublicSession | null | undefined): CurrentUser {
  const name = session?.personaName ?? session?.username ?? "";
  return {
    employee_id: session?.employeeId ?? "",
    name,
    designation: session?.personaTitle ?? (session?.isStaff ? "Staff" : ""),
    initials: initialsOf(name),
    permissions: session?.permissions ?? [],
  };
}

type Ctx = {
  currentUser: CurrentUser;
  /** Ask the server to act as somebody else. Evaluation logins only. */
  setCurrentUser: (u: { employee_id: string }) => Promise<{ ok: boolean; error?: string }>;
  users: Omit<CurrentUser, "permissions">[];
  session: PublicSession | null;
  can: (permission: string) => boolean;
};

const CurrentUserContext = createContext<Ctx | null>(null);

export function CurrentUserProvider({ session, children }: { session: PublicSession | null; children: ReactNode }) {
  const router = useRouter();
  const currentUser = useMemo(() => userFromSession(session), [session]);

  const setCurrentUser = useCallback(async (u: { employee_id: string }) => {
    const result = await switchPersona({ data: { employeeId: u.employee_id } });
    if (!result.ok) return { ok: false, error: result.error };
    // The root's beforeLoad holds the session; asking again refreshes
    // every screen with the new persona.
    await router.invalidate();
    return { ok: true };
  }, [router]);

  const can = useCallback((p: string) => currentUser.permissions.includes(p), [currentUser.permissions]);

  return (
    <CurrentUserContext.Provider value={{ currentUser, setCurrentUser, users: USERS, session, can }}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser() {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) throw new Error("useCurrentUser must be used within CurrentUserProvider");
  return ctx;
}
