import { Check } from "lucide-react";

export type Step = 1 | 2 | 3;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Fields" },
  { n: 2, label: "Approvers" },
  { n: 3, label: "Notifications" },
];

export function StepProgress({ current }: { current: Step }) {
  return (
    <div className="flex items-center justify-center gap-3" style={{ padding: "10px 20px" }}>
      {STEPS.map((s, i) => {
        const isDone = s.n < current;
        const isCurrent = s.n === current;
        return (
          <div key={s.n} className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center justify-center rounded-full font-semibold"
                style={{
                  width: 22,
                  height: 22,
                  fontSize: 11,
                  background: isCurrent
                    ? "var(--color-brand-500)"
                    : isDone
                      ? "#EEF2FF"
                      : "#fff",
                  color: isCurrent ? "#fff" : isDone ? "#4338CA" : "#71717A",
                  border: `1.5px solid ${isCurrent || isDone ? "var(--color-brand-500)" : "#D4D4D8"}`,
                }}
              >
                {isDone ? <Check size={12} /> : s.n}
              </span>
              <span
                className="font-medium"
                style={{
                  fontSize: 12.5,
                  color: isCurrent ? "#18181B" : isDone ? "#3F3F46" : "#A1A1AA",
                }}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <span style={{ width: 32, height: 1, background: "#E4E4E7" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
