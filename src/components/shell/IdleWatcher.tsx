// =====================================================================
// "Log out after 5 minutes of inactivity."
//
// The server refuses a session nobody has used for five minutes; this is
// the browser's half. It watches for somebody actually using the page —
// keys, the pointer, scrolling — not for background polling, which would
// otherwise keep an abandoned tab signed in forever. While somebody is
// active it tells the server so now and then, so typing a long form
// without saving does not count as being away. The server's own clock
// moves only on navigation and these reports, never on polling.
//
// Thirty seconds before the end it warns, with a way to stay.
// =====================================================================

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { currentSession, signOut } from "@/lib/auth-fn";

const EVENTS = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "wheel"] as const;
const WARN_BEFORE_MS = 30_000;

export function IdleWatcher({ idleSeconds }: { idleSeconds: number }) {
  const last = useRef(Date.now());
  const lastPing = useRef(Date.now());
  const warned = useRef<string | number | null>(null);

  useEffect(() => {
    const limit = idleSeconds * 1000;
    // Often enough that the server's clock never runs out while somebody
    // is using the page; only background polling does not count there.
    const pingEvery = Math.min(60_000, limit / 4);
    const warnAt = limit - Math.min(WARN_BEFORE_MS, limit / 4);

    const active = () => {
      last.current = Date.now();
      if (warned.current !== null) {
        toast.dismiss(warned.current);
        warned.current = null;
      }
      if (Date.now() - lastPing.current > pingEvery) {
        lastPing.current = Date.now();
        void currentSession();
      }
    };

    const leave = async () => {
      try { await signOut(); } finally { window.location.assign("/login?idle=1"); }
    };

    const tick = window.setInterval(() => {
      const quiet = Date.now() - last.current;
      if (quiet >= limit) {
        window.clearInterval(tick);
        void leave();
      } else if (quiet >= warnAt && warned.current === null) {
        const left = Math.round((limit - quiet) / 1000);
        warned.current = toast.warning(`You will be signed out in ${left} seconds`, {
          description: "Nothing has happened here for a while.",
          duration: limit - quiet,
          action: { label: "Stay signed in", onClick: () => { lastPing.current = 0; active(); } },
        });
      }
    }, 5_000);

    for (const e of EVENTS) window.addEventListener(e, active, { passive: true });
    return () => {
      window.clearInterval(tick);
      for (const e of EVENTS) window.removeEventListener(e, active);
    };
  }, [idleSeconds]);

  return null;
}
