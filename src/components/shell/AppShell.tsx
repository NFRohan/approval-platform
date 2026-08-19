import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppShell({
  children,
  hideTopBar = false,
  sidebarDefaultCollapsed = false,
  noScroll = false,
}: {
  children: ReactNode;
  hideTopBar?: boolean;
  sidebarDefaultCollapsed?: boolean;
  noScroll?: boolean;
}) {
  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar defaultCollapsed={sidebarDefaultCollapsed} />
      <div className="flex-1 flex flex-col min-w-0">
        {!hideTopBar && <TopBar />}
        <main
          className={noScroll ? "flex-1 overflow-hidden min-h-0" : "scroll-thin flex-1 overflow-auto"}
          style={{ background: "var(--color-zinc-50)" }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
