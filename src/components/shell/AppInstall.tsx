// =====================================================================
// The app on a phone: the service worker started, and one quiet offer
// above the tab bar — install the app (Android's prompt, or how on an
// iPhone), then, once it is installed, turn notifications on. Each can
// be dismissed; it stays dismissed on that device. A device that has
// notifications on gets those of whoever the person is acting as.
// =====================================================================

import { useEffect, useState } from "react";
import { Bell, Download, Share, X } from "lucide-react";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  canInstall, enablePush, install, isIos, isStandalone, onInstallChange, pushState, pushSupported, rebindPush, registerServiceWorker,
} from "@/lib/push-client";

const KEY = "ams.app-offer.dismissed";
const dismissed = (what: string) => { try { return localStorage.getItem(`${KEY}.${what}`) === "1"; } catch { return false; } };
const dismiss = (what: string) => { try { localStorage.setItem(`${KEY}.${what}`, "1"); } catch { /* private mode */ } };

export function AppInstall() {
  const { currentUser } = useCurrentUser();
  const [offer, setOffer] = useState<null | "install" | "ios" | "push">(null);

  useEffect(() => {
    void registerServiceWorker();
    const decide = async () => {
      if (window.matchMedia("(min-width: 768px)").matches) return setOffer(null);
      if (!isStandalone()) {
        if (canInstall() && !dismissed("install")) return setOffer("install");
        if (isIos() && !dismissed("ios")) return setOffer("ios");
        return setOffer(null);
      }
      if (pushSupported() && Notification.permission === "default" && !dismissed("push")) return setOffer("push");
      setOffer(null);
    };
    void decide();
    return onInstallChange(() => void decide());
  }, []);

  // Acting as somebody else moves this device's notifications to them.
  useEffect(() => { void rebindPush(); }, [currentUser.employee_id]);

  if (!offer) return null;

  const close = () => { dismiss(offer); setOffer(null); };
  const body =
    offer === "install" ? { Icon: Download, title: "Install the app", text: "Approvals on your home screen, full screen, with notifications.", action: "Install" }
    : offer === "ios" ? { Icon: Share, title: "Add to your home screen", text: "Tap Share, then Add to Home Screen, for the app and its notifications.", action: null }
    : { Icon: Bell, title: "Turn on notifications", text: "Hear about approvals and updates even with the app closed.", action: "Turn on" };

  return (
    <div
      className="md:hidden fixed inset-x-2 z-40 rounded-xl bg-white flex items-center gap-3"
      style={{ bottom: "calc(var(--tab-bar, 60px) + env(safe-area-inset-bottom) + 8px)", padding: "10px 10px 10px 12px",
               border: "1px solid var(--color-zinc-200)", boxShadow: "0 8px 24px rgba(24, 24, 27, 0.12)" }}
      role="region"
      aria-label={body.title}
      data-testid="app-offer"
    >
      <span className="inline-flex items-center justify-center rounded-lg shrink-0" style={{ width: 36, height: 36, background: "#EEF2FF", color: "#4338CA" }}>
        <body.Icon size={18} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13.5px] font-semibold text-zinc-900">{body.title}</span>
        <span className="block text-[12px] text-zinc-500 leading-snug">{body.text}</span>
      </span>
      {body.action && (
        <button
          type="button"
          onClick={async () => {
            if (offer === "install") { if (await install()) setOffer(null); return; }
            const r = await enablePush();
            if (r.ok) { toast.success("Notifications are on for this phone"); setOffer(null); }
            else { toast.error(r.error ?? "Notifications could not be turned on"); close(); }
            void pushState();
          }}
          className="shrink-0 rounded-lg text-white font-semibold"
          style={{ padding: "8px 12px", fontSize: 13, background: "var(--color-brand-600)", border: "none" }}
        >
          {body.action}
        </button>
      )}
      <button type="button" onClick={close} aria-label="Not now" className="shrink-0" style={{ padding: 6, background: "none", border: "none", color: "var(--color-zinc-400)" }}>
        <X size={16} />
      </button>
    </div>
  );
}
