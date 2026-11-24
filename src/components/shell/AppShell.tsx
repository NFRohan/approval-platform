import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MobileNav, TAB_BAR_HEIGHT } from "./MobileNav";
import { AppInstall } from "./AppInstall";

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
    <div className="h-dvh flex overflow-hidden">
      {/* On a phone the sidebar gives way to the tab bar and its drawer. */}
      <div className="hidden md:flex h-full">
        <Sidebar defaultCollapsed={sidebarDefaultCollapsed} />
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        {!hideTopBar && <TopBar />}
        <main
          className={(noScroll ? "flex-1 overflow-hidden min-h-0" : "scroll-thin flex-1 overflow-auto") + " app-main"}
          style={{ background: "var(--color-zinc-50)", ["--tab-bar" as string]: `${TAB_BAR_HEIGHT}px` }}
        >
          {children}
        </main>
      </div>
      <MobileNav />
      <AppInstall />
    </div>
  );
}
