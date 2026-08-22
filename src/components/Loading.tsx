// =====================================================================
// What a screen shows before its data arrives.
//
// Several screens rendered their empty state during the fetch, so a
// populated list flashed "No forms yet" first and a builder step showed
// an empty approver list before filling in. Both read as broken rather
// than as loading, and on a slow connection the wrong message is the
// only one a person sees.
//
// Two shapes, because there are two situations: skeleton rows where the
// layout is already known, and a line of text where it is not.
// =====================================================================

export function LoadingRows({ rows = 3, height = 64 }: { rows?: number; height?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl"
          style={{
            height,
            background: "var(--color-zinc-100, #F4F4F5)",
            border: "1px solid var(--color-zinc-200, #E4E4E7)",
            // Fades rather than pulses: a row that moves competes with
            // the content that is about to replace it.
            opacity: 1 - i * 0.22,
          }}
        />
      ))}
    </div>
  );
}

export function LoadingLine({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      style={{ padding: "18px 2px", fontSize: 13, color: "var(--color-zinc-400, #A1A1AA)" }}
    >
      {label}
    </div>
  );
}
