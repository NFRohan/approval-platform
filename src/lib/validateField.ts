// =====================================================================
// Checking an answer against the rules the builder collected.
//
// The Validation tab has always written minLength, maxLength, min, max
// and pattern into field_config, and until now nothing read any of them
// back except maxStars. A number field configured to accept 0 to 100
// took -500 without complaint, on the client and on the server alike,
// because the only check that ran asked whether the field was empty.
//
// One function, so the submit path and the input attributes cannot drift
// apart. It answers with the sentence to show somebody, or null.
// =====================================================================

export type FieldRule = {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  maxStars?: number;
};

export type ValidatableField = {
  label: string;
  kind: string;
  required: boolean;
  validation?: FieldRule;
};

const NUMERIC = new Set(["number", "money"]);
const TEXTUAL = new Set(["text", "textarea", "email", "phone"]);

/** Is this answer absent? Kept separate because "empty" is not "invalid". */
export function isEmpty(field: ValidatableField, value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const parts = Object.values(value as Record<string, unknown>);
    // A date range is two halves and needs both. Asking whether *every*
    // half was empty let a range through with only its start filled.
    return parts.length === 0 || parts.some((x) => x === undefined || x === null || x === "");
  }
  return false;
}

/**
 * The first thing wrong with this answer, or null.
 *
 * A field that is not required and has been left empty is fine; the
 * rules only apply once somebody has actually answered.
 */
export function validateField(field: ValidatableField, value: unknown): string | null {
  if (isEmpty(field, value)) {
    if (!field.required) return null;
    // A part-filled compound field is not "missing" — saying so sends
    // somebody looking for a field they have already begun.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const parts = Object.values(value as Record<string, unknown>);
      if (parts.some((x) => x !== undefined && x !== null && x !== "")) {
        return `${field.label} needs both a start and an end`;
      }
    }
    return `${field.label} is required`;
  }

  const rule = field.validation;
  if (!rule) return null;

  if (NUMERIC.has(field.kind)) {
    const n = typeof value === "number" ? value : Number.parseFloat(String(value));
    if (!Number.isFinite(n)) return `${field.label} must be a number`;
    if (rule.min !== undefined && n < rule.min) {
      return `${field.label} must be at least ${rule.min}`;
    }
    if (rule.max !== undefined && n > rule.max) {
      return `${field.label} must be at most ${rule.max}`;
    }
    return null;
  }

  if (TEXTUAL.has(field.kind)) {
    const s = String(value);
    if (rule.minLength !== undefined && s.length < rule.minLength) {
      return `${field.label} must be at least ${rule.minLength} characters`;
    }
    if (rule.maxLength !== undefined && s.length > rule.maxLength) {
      return `${field.label} must be at most ${rule.maxLength} characters`;
    }
    if (rule.pattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(rule.pattern);
      } catch {
        // A pattern the author mistyped should not block a submission —
        // it is their mistake, not the person filling the form's.
        return null;
      }
      if (!re.test(s)) return `${field.label} is not in the expected format`;
    }
  }

  return null;
}

/** What to hang on the input itself, so the browser helps before submit. */
export function inputBounds(field: ValidatableField): {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
} {
  const rule = field.validation;
  if (!rule) return {};
  if (NUMERIC.has(field.kind)) return { min: rule.min, max: rule.max };
  if (TEXTUAL.has(field.kind)) {
    return { minLength: rule.minLength, maxLength: rule.maxLength, pattern: rule.pattern };
  }
  return {};
}
