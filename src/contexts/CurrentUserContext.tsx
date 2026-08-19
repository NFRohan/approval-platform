import { createContext, useContext, useState, type ReactNode } from "react";

export type CurrentUser = {
  employee_id: string;
  name: string;
  designation: string;
  initials: string;
};

export const USERS: CurrentUser[] = [
  { employee_id: "EMP-0201", name: "Nadia Hossain", designation: "HR Business Partner", initials: "NH" },
  { employee_id: "EMP-2847", name: "Ahmed Rahman", designation: "Departing Employee", initials: "AR" },
  { employee_id: "EMP-1134", name: "Sara Khan", designation: "Line Manager", initials: "SK" },
  { employee_id: "EMP-0312", name: "Rafiqul Islam", designation: "Finance Controller", initials: "RI" },
  { employee_id: "EMP-0600", name: "Dilruba Akter", designation: "Head of Finance", initials: "DA" },
  { employee_id: "EMP-0700", name: "Shamsul Huda", designation: "CFO", initials: "SH" },
  { employee_id: "EMP-0445", name: "Farzana Islam", designation: "Admin Officer", initials: "FI" },
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
