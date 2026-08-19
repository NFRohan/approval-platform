import type { LucideIcon } from "lucide-react";

export type FieldKind =
  // Basic
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "file"
  | "checkbox"
  // Advanced
  | "email"
  | "phone"
  | "rating"
  | "multi_select"
  // Layout
  | "section_header"
  // Smart
  | "employee"
  | "money"
  | "dept"
  | "daterange"
  | "signature"
  // Generated (legacy / kept)
  | "gen_employee_name"
  | "gen_designation"
  | "gen_gate_pass"
  // Embedded
  | "linked_gate_pass_revocation"
  | "linked_office_access"
  | "linked_asset_return"
  // Permissions
  | "perm_visibility"
  | "perm_edit"
  | "perm_required"
  // Calculation
  | "calculation";

export type PaletteItem = {
  kind: FieldKind;
  label: string;
  Icon: LucideIcon;
  hint?: string;
  linked?: boolean;
  slab?: boolean;
};

export type PaletteSection = {
  id: string;
  title: string;
  Icon: LucideIcon;
  accent?: boolean;
  items: PaletteItem[];
};

export type FieldConfig = {
  helper?: string;
  options?: string[]; // for select, checkbox group
  accept?: string; // for file
  placeholder?: string;
  embedded?: string; // form template id for embedded
};

export type PlacedField = {
  id: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  helper: string;
  options?: string[];
  placeholder?: string;
  order_index: number;
  formula?: string;
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
    maxStars?: number;
  };
};
