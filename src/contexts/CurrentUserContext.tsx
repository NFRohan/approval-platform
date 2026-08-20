import { createContext, useContext, useState, type ReactNode } from "react";

export type CurrentUser = {
  employee_id: string;
  name: string;
  designation: string;
  initials: string;
};

// The people a viewer can act as.
//
// These must match rows in `employees`, because every screen filters by
// employee_id — the approvals queue asks for steps assigned to
// currentUser.employee_id and nothing else. They had drifted: the
// database was renumbered to EMP-#### when the schema was ported and
// this list still said EMP-####, so no persona matched any employee and
// every queue came back empty. scripts/render-test.mjs now checks the
// two agree.
//
// Safe to hardcode: an evaluation is a clone of the template, and
// cloning preserves employee_id.
export const USERS: CurrentUser[] = [
  { employee_id: "EMP-2847", name: "Tom Bexley",     designation: "Operations Analyst",       initials: "TB" },
  { employee_id: "EMP-1134", name: "Sam Lindqvist",  designation: "Line Manager",             initials: "SL" },
  { employee_id: "EMP-0312", name: "Raj Patel",      designation: "Finance Controller",       initials: "RP" },
  { employee_id: "EMP-0600", name: "Dana Whitfield", designation: "Head of Finance",          initials: "DW" },
  { employee_id: "EMP-0700", name: "Alex Mercer",    designation: "Chief Financial Officer",  initials: "AM" },
  { employee_id: "EMP-0201", name: "Nadia Okonjo",   designation: "HR Business Partner",      initials: "NO" },
  { employee_id: "EMP-0445", name: "Farah Haddad",   designation: "Admin Officer",            initials: "FH" },
  { employee_id: "EMP-9001", name: "Ivan Petrov",    designation: "Facilities Coordinator",   initials: "IP" },
];

type Ctx = {
  currentUser: CurrentUser;
  setCurrentUser: (u: CurrentUser) => void;
  users: CurrentUser[];
};

const CurrentUserContext = createContext<Ctx | null>(null);

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<CurrentUser>(USERS[0]);
  return (
    <CurrentUserContext.Provider value={{ currentUser, setCurrentUser, users: USERS }}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser() {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) throw new Error("useCurrentUser must be used within CurrentUserProvider");
  return ctx;
}
