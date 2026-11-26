// =====================================================================
// A date, entered the way every date here is written: dd/MM/yyyy.
//
// The SOW asks for "all date fields in dd MM yyyy". The browser's own date
// input follows the browser's locale — mm/dd/yyyy on an American one — so
// entry did not match display. This is a text box that reads dd/MM/yyyy
// (slashes added as you type), with a calendar beside it. A pasted ISO
// date (2026-11-02) is understood too. The value handed back is always ISO
// (YYYY-MM-DD) or "" — what the database and the rest of the app use.
// =====================================================================

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CalendarDays } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO (YYYY-MM-DD) → dd/MM/yyyy, or "" */
export function isoToDmy(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** dd/MM/yyyy or YYYY-MM-DD → ISO, or null if it is not a real date. */
export function parseDate(text: string): string | null {
  const t = text.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{4})$/.exec(t);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Typing 02112026 reads as 02/11/2026. */
export function withSlashes(raw: string): string {
  // An ISO date being pasted or typed, or anything not digits and slashes:
  // leave it as it is.
  if (!/^[\d/]*$/.test(raw)) return raw;
  // Somebody typing the slashes themselves ("2/11/2026") keeps theirs.
  if (/^\d{1,2}\/\d{1,2}\//.test(raw) || /^\d\//.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

export function DateInput({
  value, onChange, min, max, style, className, disabled, name, id, required,
  "aria-label": ariaLabel, placeholder = "dd/mm/yyyy",
}: {
  value: string | null | undefined;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  style?: CSSProperties;
  className?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  required?: boolean;
  "aria-label"?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(isoToDmy(value));
  const [open, setOpen] = useState(false);
  const [bad, setBad] = useState(false);
  const focused = useRef(false);

  // Follow the value when it changes from outside (a draft loaded, a reset),
  // but not while the person is typing.
  useEffect(() => { if (!focused.current) setText(isoToDmy(value)); }, [value]);

  const inRange = (iso: string) => (!min || iso >= min) && (!max || iso <= max);

  function take(raw: string) {
    const shown = withSlashes(raw);
    setText(shown);
    if (!shown.trim()) { setBad(false); onChange(""); return; }
    const iso = parseDate(shown);
    if (iso && inRange(iso)) { setBad(false); onChange(iso); }
  }

  const selected = value ? new Date(`${value}T00:00:00`) : undefined;

  return (
    <span className={className} style={{ position: "relative", display: "inline-flex", alignItems: "center", width: style?.width ?? "100%" }}>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        data-date=""
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={bad || undefined}
        placeholder={placeholder}
        value={text}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => take(e.target.value)}
        onBlur={() => {
          focused.current = false;
          if (!text.trim()) return;
          const iso = parseDate(text);
          if (iso && inRange(iso)) { setText(isoToDmy(iso)); setBad(false); }
          else setBad(true);
        }}
        style={{ ...style, width: "100%", paddingRight: 34, ...(bad ? { borderColor: "#F87171" } : {}) }}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Pick from a calendar"
            style={{ position: "absolute", right: 6, background: "none", border: "none", padding: 4, color: "#71717A", display: "inline-flex" }}
          >
            <CalendarDays size={15} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            disabled={(d) => {
              const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
              return !inRange(iso);
            }}
            onSelect={(d) => {
              if (!d) return;
              const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
              setText(isoToDmy(iso)); setBad(false); onChange(iso); setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </span>
  );
}
