import { useState } from "react";
import { Bell, ChevronRight, HelpCircle, Search } from "lucide-react";
import { RoleSwitcher } from "./RoleSwitcher";

function NotificationsDropdown({ onClose }: { onClose: () => void }) {
  const items = [
    {
      dot: "var(--color-brand-500)",
      text: (
        <>
          <strong>Ahmed Rahman's</strong> exit clearance is <strong>On Hold</strong> — Admin requested
          clarification
        </>
      ),
      when: "2 hrs ago",
    },
    {
      dot: "var(--color-success)",
      text: (
        <>
          Your <strong>Gate Pass</strong> request was approved by <strong>Karim</strong>
        </>
      ),
      when: "5 hrs ago",
    },
    {
      dot: "var(--color-zinc-400)",
      text: (
        <>
          New form template published: <strong>Stamp Seal Requisition v2</strong>
        </>
      ),
      when: "Yesterday",
    },
  ];
  return (
    <div
      className="absolute right-0 bg-white rounded-xl border z-50"
      style={{
        top: 44,
        width: 380,
        borderColor: "var(--color-zinc-200)",
        boxShadow: "0 12px 32px -8px rgba(0,0,0,0.18), 0 4px 8px -2px rgba(0,0,0,0.06)",
      }}
    >
      <div
        className="flex items-center justify-between border-b"
        style={{ padding: "12px 16px", borderColor: "var(--color-zinc-200)" }}
      >
        <div className="text-[13px] font-semibold text-zinc-900">3 new notifications</div>
        <button
          onClick={onClose}
          className="text-[11px] font-medium cursor-pointer"
          style={{ color: "var(--color-brand-600)" }}
        >
          Mark all read
        </button>
      </div>
      {items.map((n, i) => (
        <div
          key={i}
          className="flex gap-2.5 items-start"
          style={{
            padding: "12px 16px",
            borderBottom: i < 2 ? "1px solid var(--color-zinc-100)" : "none",
          }}
        >
          <span
            className="rounded-full shrink-0"
            style={{ width: 8, height: 8, background: n.dot, marginTop: 6 }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-zinc-700)" }}>
              {n.text}
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">{n.when}</div>
          </div>
        </div>
      ))}
      <div
        className="text-center border-t"
        style={{ padding: "10px 16px", borderColor: "var(--color-zinc-200)" }}
      >
        <a href="#" className="text-[12px] font-medium" style={{ color: "var(--color-brand-600)" }}>
          View all notifications →
        </a>
      </div>
    </div>
  );
}

export function TopBar() {
  const [notifOpen, setNotifOpen] = useState(false);

  return (
    <div
      className="h-16 shrink-0 flex items-center gap-6 bg-white border-b relative"
      style={{ padding: "0 28px", borderColor: "var(--color-zinc-200)" }}
    >
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[11px] text-zinc-400">Home</span>
        <ChevronRight size={11} className="text-zinc-300" />
        <span className="text-[13px] font-semibold text-zinc-900">Dashboard</span>
      </div>

      <div
        className="flex-1 flex items-center gap-2.5 rounded-[10px]"
        style={{ maxWidth: 480, padding: "8px 14px", background: "var(--color-zinc-100)" }}
      >
        <Search size={14} className="text-zinc-500" />
        <input
          placeholder="Search submissions, forms, people…"
          className="flex-1 bg-transparent outline-none text-[13px] text-zinc-900 font-sans"
        />
        <kbd
          className="font-mono text-zinc-500 bg-white border rounded"
          style={{ fontSize: 10, padding: "2px 6px", borderColor: "var(--color-zinc-200)" }}
        >
          ⌘K
        </kbd>
      </div>

      <div className="ml-auto flex items-center gap-2 relative">
        <button
          onClick={() => setNotifOpen((v) => !v)}
          className="inline-flex items-center justify-center rounded-lg cursor-pointer relative"
          style={{ width: 36, height: 36 }}
        >
          <Bell size={16} style={{ color: "var(--color-zinc-700)" }} />
          <span
            className="absolute inline-flex items-center justify-center rounded-full text-white font-semibold border-2 border-white"
            style={{
              top: 4,
              right: 4,
              width: 16,
              height: 16,
              background: "var(--color-brand-500)",
              fontSize: 9.5,
            }}
          >
            3
          </span>
        </button>
        <button
          className="inline-flex items-center justify-center rounded-lg cursor-pointer"
          style={{ width: 36, height: 36 }}
        >
          <HelpCircle size={16} style={{ color: "var(--color-zinc-700)" }} />
        </button>
        <span className="mx-1" style={{ width: 1, height: 22, background: "var(--color-zinc-200)" }} />
        <RoleSwitcher />

        {notifOpen && <NotificationsDropdown onClose={() => setNotifOpen(false)} />}
      </div>
    </div>
  );
}
