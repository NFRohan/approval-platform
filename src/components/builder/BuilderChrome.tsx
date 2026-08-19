import { ChevronRight, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { StepProgress, type Step } from "./StepProgress";

type Props = {
  step: Step;
  formName: string;
  onFormNameChange?: (v: string) => void;
  onFormNameBlur?: () => void;
  savedAgo?: string;
  leftActions?: ReactNode;
  rightActions: ReactNode;
  children: ReactNode;
};

export function BuilderChrome({
  step,
  formName,
  onFormNameChange,
  onFormNameBlur,
  savedAgo = "just now",
  leftActions,
  rightActions,
  children,
}: Props) {
  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      {/* Top bar */}
      <div
        className="flex items-center gap-3 shrink-0"
        style={{ height: 48, padding: "0 20px", background: "#fff", borderBottom: "1px solid #E4E4E7" }}
      >
        <span
          className="rounded-full"
          style={{
            width: 10,
            height: 10,
            background: "var(--color-brand-500)",
            boxShadow: "0 0 0 4px color-mix(in oklab, var(--color-brand-500) 10%, transparent)",
          }}
        />
        <span className="font-semibold" style={{ fontSize: 13, color: "#18181B", letterSpacing: "-0.005em" }}>
          Admin Services Portal
        </span>
        <span style={{ color: "#D4D4D8", fontSize: 12 }}>—</span>
        <span style={{ fontSize: 12, color: "#71717A" }}>Form Builder</span>

        <div className="ml-4 flex items-center gap-1.5" style={{ fontSize: 12, color: "#71717A" }}>
          <span>Forms</span>
          <ChevronRight size={11} style={{ color: "#A1A1AA" }} />
          <span>HR</span>
          <ChevronRight size={11} style={{ color: "#A1A1AA" }} />
          <span className="font-medium" style={{ color: "#18181B" }}>
            Departure Due Diligence
          </span>
        </div>

        <span className="ml-auto font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>
          v0.1
        </span>
      </div>

      {/* Step progress */}
      <div className="shrink-0" style={{ background: "#FAFAFA", borderBottom: "1px solid #E4E4E7" }}>
        <StepProgress current={step} />
      </div>

      {/* Form name + actions */}
      <div
        className="flex items-center gap-4 shrink-0 flex-wrap"
        style={{ padding: "12px 24px", background: "#fff", borderBottom: "1px solid #E4E4E7" }}
      >
        <div className="flex items-center gap-2.5 flex-1" style={{ minWidth: 240 }}>
          <Workflow size={16} style={{ color: "#52525B" }} />
          <input
            value={formName}
            onChange={(e) => onFormNameChange?.(e.target.value)}
            onBlur={onFormNameBlur}
            readOnly={!onFormNameChange}
            className="font-sans font-semibold rounded-md flex-1"
            style={{
              fontSize: 15,
              color: "#18181B",
              letterSpacing: "-0.005em",
              padding: "4px 8px",
              border: "1px solid transparent",
              background: "transparent",
              outline: "none",
              minWidth: 200,
            }}
            onFocus={(e) => {
              if (!onFormNameChange) return;
              e.currentTarget.style.borderColor = "#E4E4E7";
              e.currentTarget.style.background = "#FAFAFA";
            }}
          />
          <span
            className="inline-flex items-center rounded-full font-medium"
            style={{
              padding: "2px 8px",
              fontSize: 11,
              background: "#F4F4F5",
              color: "#52525B",
              border: "1px solid #E4E4E7",
            }}
          >
            Draft
          </span>
          <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>
            saved {savedAgo}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {leftActions}
          {rightActions}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex" style={{ minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

// Shared button styles
export function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md text-white"
      style={{
        padding: "7px 14px",
        fontSize: 13,
        fontWeight: 500,
        background: "var(--color-brand-500)",
        border: "1px solid var(--color-brand-500)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md cursor-pointer bg-white"
      style={{
        padding: "7px 12px",
        fontSize: 13,
        fontWeight: 500,
        color: "#3F3F46",
        border: "1px solid #E4E4E7",
      }}
    >
      {children}
    </button>
  );
}
