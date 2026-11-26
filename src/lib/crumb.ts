// =====================================================================
// What the last breadcrumb is called on a detail page.
//
// The trail is derived from the path, and a path holds an id, so a form
// read "Available Forms / Form" and a report "Reports / Report". A
// detail page that knows its thing's name says it here; the top bar
// shows it while that page is the one open.
// =====================================================================
import { useSyncExternalStore } from "react";

let current: { path: string; label: string } | null = null;
const listeners = new Set<() => void>();

export function setCrumbLabel(path: string, label: string | null) {
  current = label ? { path, label } : null;
  listeners.forEach((l) => l());
}

export function useCrumbLabel(path: string): string | null {
  const v = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => current,
    () => null,
  );
  return v && v.path === path ? v.label : null;
}
