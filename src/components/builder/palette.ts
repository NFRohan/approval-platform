import {
  AlignLeft,
  AlignJustify,
  AlertTriangle,
  Building,
  Calendar,
  CalendarRange,
  CheckSquare,
  ChevronDown,
  DollarSign,
  Edit,
  Eye,
  Hash,
  Layers,
  LayoutTemplate,
  Link2,
  ListChecks,
  Mail,
  Minus,
  Paperclip,
  Pen,
  Phone,
  Shield,
  Sparkles,
  Star,
  Type,
  User,
  Zap,
  FunctionSquare,
} from "lucide-react";
import type { PaletteSection, FieldKind } from "./types";

export const PALETTE: PaletteSection[] = [
  {
    id: "basic",
    title: "Basic Fields",
    Icon: Type,
    items: [
      { kind: "text", label: "Text Input", Icon: AlignLeft },
      { kind: "textarea", label: "Long Text", Icon: AlignJustify },
      { kind: "number", label: "Number", Icon: Hash },
      { kind: "date", label: "Date Picker", Icon: Calendar },
      { kind: "select", label: "Dropdown", Icon: ChevronDown },
      { kind: "file", label: "File Upload", Icon: Paperclip },
      { kind: "checkbox", label: "Checkbox", Icon: CheckSquare },
    ],
  },
  {
    id: "advanced",
    title: "Advanced Fields",
    Icon: Sparkles,
    items: [
      { kind: "email", label: "Email Address", Icon: Mail, hint: "Auto-validates email format" },
      { kind: "phone", label: "Phone Number", Icon: Phone, hint: "BD mobile format" },
      { kind: "rating", label: "Star Rating", Icon: Star, hint: "1–5 satisfaction scale" },
      { kind: "multi_select", label: "Multi-Select", Icon: ListChecks, hint: "Multiple choice checkboxes" },
    ],
  },
  {
    id: "smart",
    title: "Smart Fields",
    Icon: Zap,
    accent: true,
    items: [
      { kind: "employee", label: "Employee Lookup", Icon: User, hint: "Auto-fills from LDAP" },
      {
        kind: "money",
        label: "Money Amount",
        Icon: DollarSign,
        slab: true,
        hint: "Triggers slab-based finance routing",
      },
      { kind: "dept", label: "Department", Icon: Building },
      { kind: "daterange", label: "Date Range", Icon: CalendarRange },
      { kind: "signature", label: "Signature Pad", Icon: Pen },
      {
        kind: "calculation",
        label: "Calculation",
        Icon: FunctionSquare,
        hint: "Auto-computes from other numeric fields",
      },
    ],
  },
  {
    id: "embedded",
    title: "Embedded Forms",
    Icon: Link2,
    items: [
      { kind: "linked_gate_pass_revocation", label: "Gate Pass Revocation", Icon: Link2, linked: true },
      { kind: "linked_office_access", label: "Office Access Request", Icon: Link2, linked: true },
      { kind: "linked_asset_return", label: "Asset Return Form", Icon: Link2, linked: true },
    ],
  },
  {
    id: "layout",
    title: "Layout",
    Icon: LayoutTemplate,
    items: [
      { kind: "section_header", label: "Section Divider", Icon: Minus, hint: "Group fields with a label" },
    ],
  },
  {
    id: "permissions",
    title: "Permissions",
    Icon: Shield,
    items: [
      { kind: "perm_visibility", label: "Visibility Rules", Icon: Eye, hint: "Show field if…" },
      { kind: "perm_edit", label: "Edit Rules", Icon: Edit, hint: "Editable only by role…" },
      { kind: "perm_required", label: "Required Conditions", Icon: AlertTriangle },
    ],
  },
];

export const DEFAULT_LABELS: Record<FieldKind, string> = {
  text: "Text Field",
  textarea: "Long Text",
  number: "Number Field",
  money: "Amount",
  date: "Date",
  select: "Choose an option",
  file: "Upload Document",
  checkbox: "Confirm",
  email: "Email Address",
  phone: "Phone Number",
  rating: "Satisfaction Rating",
  multi_select: "Select All That Apply",
  section_header: "Section Title",
  employee: "Employee",
  dept: "Department",
  daterange: "Date Range",
  signature: "Signature",
  calculation: "Calculated Value",
  gen_employee_name: "Employee Name",
  gen_designation: "Designation",
  gen_gate_pass: "Gate Pass Card Number",
  linked_gate_pass_revocation: "Gate Pass Revocation",
  linked_office_access: "Office Access Request",
  linked_asset_return: "Asset Return Form",
  perm_visibility: "Visibility Rule",
  perm_edit: "Edit Rule",
  perm_required: "Required Condition",
};

export const DEFAULT_OPTIONS: Partial<Record<FieldKind, string[]>> = {
  select: ["Option A", "Option B", "Option C"],
  dept: ["Product & Technology", "Finance", "Supply Chain", "Admin", "HR"],
  multi_select: ["Option A", "Option B", "Option C"],
};

export function isEmbedded(kind: FieldKind) {
  return kind.startsWith("linked_");
}
export function isSmart(kind: FieldKind) {
  return ["employee", "money", "dept", "daterange", "signature", "calculation"].includes(kind);
}
export function isPermission(kind: FieldKind) {
  return kind.startsWith("perm_");
}
export function isLayout(kind: FieldKind) {
  return kind === "section_header";
}

// keep imports referenced
export const _Layers = Layers;
