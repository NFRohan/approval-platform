// =====================================================================
// Evaluating a calculated field.
//
// This existed three times over — in FieldRenderer, in LivePreview and
// in the fill route — identical but for how each one formatted the
// answer. Three copies of an evaluator is three places for a rule to
// drift, so it lives here once and they format the number themselves.
//
// The bug that prompted the move: a calculation referring to another
// calculation always came out as 0. A calculated field's result is
// never written back into the answers map, so looking its token up
// there found nothing. Tokens that name a calculation are now evaluated
// on the spot, depth-first, with the chain of fields being resolved
// carried along so a formula that refers back to itself stops instead
// of recursing forever.
// =====================================================================

export type FormulaField = {
  id: string;
  label: string;
  kind: string;
  formula?: string;
};

export const SYSTEM_VARS: Record<string, number> = {
  DEPT_BUDGET: 1_000_000,
  ALLOWANCE: 20_000,
  PETTY_CASH: 50_000,
};

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toNumber(raw: unknown): number {
  return parseFloat(String(raw ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

/**
 * The number a formula comes to, or null if it cannot be worked out.
 *
 * Pass `selfId` when the formula belongs to a field — a formula naming
 * its own field is a cycle, and seeding it here is what makes that
 * resolve to 0 instead of quietly evaluating one extra round.
 */
export function evaluateFormula(
  formula: string,
  fields: FormulaField[],
  values: Record<string, unknown>,
  selfId?: string,
): number | null {
  return evaluate(formula, fields, values, selfId ? new Set([selfId]) : new Set());
}

function evaluate(
  formula: string,
  fields: FormulaField[],
  values: Record<string, unknown>,
  resolving: ReadonlySet<string>,
): number | null {
  let expr = formula;

  for (const [name, val] of Object.entries(SYSTEM_VARS)) {
    expr = expr.replace(new RegExp(`\\{${name}\\}`, "g"), String(val));
  }

  for (const f of fields) {
    const token = `{${f.label}}`;
    if (!expr.includes(token)) continue;

    let num: number;
    if (f.kind === "calculation" && f.formula && !resolving.has(f.id)) {
      const inner = evaluate(f.formula, fields, values, new Set([...resolving, f.id]));
      num = inner ?? 0;
    } else {
      num = toNumber(values[f.id]);
    }
    expr = expr.replace(new RegExp(escapeForRegex(token), "g"), String(num));
  }

  expr = expr
    .replace(/\bFLOOR\s*\(/gi, "Math.floor(")
    .replace(/\bCEILING\s*\(/gi, "Math.ceil(")
    .replace(/\bCEIL\s*\(/gi, "Math.ceil(")
    .replace(/\bROUND\s*\(/gi, "Math.round(")
    .replace(/\bMAX\s*\(/gi, "Math.max(")
    .replace(/\bMIN\s*\(/gi, "Math.min(")
    .replace(/\bABS\s*\(/gi, "Math.abs(")
    .replace(/\bAVERAGE\s*\(([^)]+)\)/gi, (_m, args: string) => {
      const parts = args.split(",").map((s) => s.trim()).filter(Boolean);
      return `((${parts.join("+")})/${parts.length})`;
    });

  if (!/^[\d\s+\-*/().,Matha-z]+$/.test(expr)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expr})`)() as number;
    return typeof result === "number" && isFinite(result) ? result : null;
  } catch {
    return null;
  }
}
