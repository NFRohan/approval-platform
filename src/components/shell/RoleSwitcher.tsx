import { Check, ChevronDown } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar } from "./Avatar";

export function RoleSwitcher() {
  const { currentUser, setCurrentUser, users } = useCurrentUser();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-lg cursor-pointer transition-colors hover:bg-zinc-100"
          style={{ padding: "4px 8px 4px 4px" }}
        >
          <Avatar initials={currentUser.initials} size={32} pink />
          <div className="text-left leading-tight hidden sm:block">
            <div className="text-[12.5px] font-medium text-zinc-900">{currentUser.name}</div>
            <div className="text-[10.5px] text-zinc-500">{currentUser.designation}</div>
          </div>
          <ChevronDown size={14} className="text-zinc-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold">
          Switch role
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {users.map((u) => {
          const active = u.employee_id === currentUser.employee_id;
          return (
            <DropdownMenuItem
              key={u.employee_id}
              onSelect={() => { setCurrentUser(u); void navigate({ to: "/" }); }}
              className="flex items-center gap-3 py-2 cursor-pointer"
            >
              <Avatar initials={u.initials} size={28} pink={active} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-zinc-900 truncate">{u.name}</div>
                <div className="text-[11px] text-zinc-500 truncate">{u.designation}</div>
              </div>
              {active && <Check size={14} className="text-brand-500" style={{ color: "var(--color-brand-500)" }} />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
