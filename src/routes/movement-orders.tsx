import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Download,
  Loader2,
  MapPin,
  Package,
  Plus,
  Truck,
  User,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { toCsv, downloadCsv } from "@/lib/csv";

export const Route = createFileRoute("/movement-orders")({
  head: () => ({
    meta: [{ title: "Movement Orders · Admin Services Portal" }],
  }),
  component: MovementOrdersPage,
});

type MO = {
  id: string;
  ref_number: string;
  requester_id: string;
  item_name: string;
  item_type: string | null;
  item_id: string | null;
  quantity: number;
  source_location: string;
  source_venue_id: string | null;
  destination_location: string;
  destination_venue_id: string | null;
  justification: string | null;
  preferred_time: string | null;
  assigned_mover_id: string | null;
  status: string;
  admin_comment: string | null;
  created_at: string | null;
  requesterName?: string;
  moverName?: string | null;
};

type Item = { id: string; name: string; type: string | null }
type Venue = { id: string; name: string; floor: string | null }
type ItemStock = { id: string; item_id: string; venue_id: string; quantity: number; reserved_quantity: number }

const ITEM_TYPES = ["Furniture", "IT Equipment", "Office Supplies", "Documents", "Stationery", "Others"];
const FLOORS = ["Ground Floor", "1st Floor", "2nd Floor", "3rd Floor", "4th Floor", "5th Floor", "6th Floor", "7th Floor", "8th Floor", "Basement"];

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  submitted:    { label: "Submitted",    color: "#1D4ED8", bg: "#EFF6FF" },
  approved:     { label: "Approved",     color: "#166534", bg: "#DCFCE7" },
  in_transit:   { label: "In Transit",   color: "#92400E", bg: "#FEF3C7" },
  completed:    { label: "Completed",    color: "#166534", bg: "#DCFCE7" },
  rejected:     { label: "Rejected",     color: "#B91C1C", bg: "#FEF2F2" },
  on_hold:      { label: "On Hold",      color: "#6B7280", bg: "#F3F4F6" },
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, color: "#52525B", bg: "#F4F4F5" };
  return (
    <span
      className="inline-flex items-center rounded-full font-medium"
      style={{ padding: "3px 10px", fontSize: 11.5, color: s.color, background: s.bg, border: `1px solid ${s.color}22` }}
    >
      {s.label}
    </span>
  );
}

function AdminBar({ onNavigate }: { onNavigate: (v: View) => void }) {
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [venueCount, setVenueCount] = useState<number | null>(null);

  useEffect(() => {
    supabase.from("items").select("id", { count: "exact", head: true }).then(({ count }) => setItemCount(count ?? 0));
    supabase.from("venues").select("id", { count: "exact", head: true }).then(({ count }) => setVenueCount(count ?? 0));
  }, []);

  const navItems: { label: string; view: View }[] = [
    { label: `Items${itemCount !== null ? ` (${itemCount})` : ""}`, view: "items" },
    { label: `Venues${venueCount !== null ? ` (${venueCount})` : ""}`, view: "venues" },
    { label: "Stock grid", view: "stock" },
  ];

  return (
    <div className="flex items-center gap-2 flex-wrap mb-5 rounded-lg"
      style={{ padding: "8px 12px", background: "#FFF0F6", border: "1px solid #FBCFE8" }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "#9D174D", marginRight: 4 }}>Inventory</span>
      {navItems.map(({ label, view }) => (
        <button key={view} onClick={() => onNavigate(view)}
          style={{ padding: "3px 10px", fontSize: 12, borderRadius: 4, border: "1px solid #FBCFE8", background: "#fff", color: "#BE185D", cursor: "pointer" }}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ItemsView({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("items").select("*").order("name");
    setItems((data ?? []) as Item[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function startAdd() { setFormName(""); setFormType(""); setAdding(true); setEditingId(null); }
  function startEdit(item: Item) { setFormName(item.name); setFormType(item.type ?? ""); setEditingId(item.id); setAdding(false); }
  function cancelForm() { setAdding(false); setEditingId(null); }

  async function saveItem() {
    if (!formName.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    const payload = { name: formName.trim(), type: formType.trim() || null };
    const { error } = editingId
      ? await supabase.from("items").update(payload).eq("id", editingId)
      : await supabase.from("items").insert(payload);
    setSaving(false);
    if (error) { toast.error("Failed to save: " + error.message); return; }
    toast.success(editingId ? "Item updated" : "Item added");
    cancelForm();
    void load();
  }

  async function deleteItem(id: string) {
    const { error } = await supabase.from("items").delete().eq("id", id);
    if (error) { toast.error("Cannot delete: " + error.message); return; }
    toast.success("Item deleted");
    void load();
  }

  return (
    <div className="max-w-3xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <button onClick={onBack} style={{ fontSize: 12.5, color: "#71717A", background: "none", border: "none", cursor: "pointer", marginBottom: 12 }}>
        ← Back to Movement Orders
      </button>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#18181B", margin: 0 }}>Manage Items</h1>
          <p style={{ marginTop: 4, fontSize: 13, color: "#71717A" }}>Item catalog used in movement orders.</p>
        </div>
        {!adding && !editingId && (
          <button onClick={startAdd} className="inline-flex items-center gap-1.5 rounded-lg"
            style={{ padding: "8px 14px", fontSize: 13, fontWeight: 500, background: "var(--color-brand-500)", color: "#fff", border: "none", cursor: "pointer" }}>
            <Plus size={13} /> Add Item
          </button>
        )}
      </div>

      {(adding || editingId) && (
        <div className="rounded-xl bg-white mb-4" style={{ padding: 16, border: "1px solid #4F46E555" }}>
          <div className="flex gap-3 flex-wrap">
            <label className="flex flex-col gap-1 flex-1" style={{ minWidth: 140 }}>
              <span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Name *</span>
              <input style={inputStyle} value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Office Chair" />
            </label>
            <label className="flex flex-col gap-1 flex-1" style={{ minWidth: 120 }}>
              <span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Type</span>
              <div style={{ position: "relative" }}>
                <select style={{ ...inputStyle, appearance: "none" }} value={formType} onChange={(e) => setFormType(e.target.value)}>
                  <option value="">Select…</option>
                  {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <ChevronDown size={13} style={{ position: "absolute", right: 10, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
              </div>
            </label>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveItem} disabled={saving}
              style={{ padding: "6px 14px", fontSize: 12, borderRadius: 6, background: "#4F46E5", color: "#fff", border: "none", cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving…" : editingId ? "Save Changes" : "Add Item"}
            </button>
            <button onClick={cancelForm} style={{ padding: "6px 12px", fontSize: 12, borderRadius: 6, background: "#fff", border: "1px solid #E4E4E7", color: "#52525B", cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2" style={{ fontSize: 13, color: "#A1A1AA", padding: "32px 0" }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl text-center" style={{ padding: "48px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>
          No items yet. Add one to get started.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between rounded-xl bg-white"
              style={{ padding: "12px 16px", border: "1px solid #E4E4E7" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "#18181B" }}>{item.name}</div>
                {item.type && <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>{item.type}</div>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => startEdit(item)}
                  style={{ padding: "4px 10px", fontSize: 12, borderRadius: 5, background: "#fff", border: "1px solid #E4E4E7", color: "#52525B", cursor: "pointer" }}>Edit</button>
                <button onClick={() => deleteItem(item.id)}
                  style={{ padding: "4px 10px", fontSize: 12, borderRadius: 5, background: "#fff", border: "1px solid #FECACA", color: "#B91C1C", cursor: "pointer" }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function VenuesView({ onBack }: { onBack: () => void }) {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formFloor, setFormFloor] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("venues").select("*").order("name");
    setVenues((data ?? []) as Venue[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function startAdd() { setFormName(""); setFormFloor(""); setAdding(true); setEditingId(null); }
  function startEdit(v: Venue) { setFormName(v.name); setFormFloor(v.floor ?? ""); setEditingId(v.id); setAdding(false); }
  function cancelForm() { setAdding(false); setEditingId(null); }

  async function saveVenue() {
    if (!formName.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    const payload = { name: formName.trim(), floor: formFloor.trim() || null };
    const { error } = editingId
      ? await supabase.from("venues").update(payload).eq("id", editingId)
      : await supabase.from("venues").insert(payload);
    setSaving(false);
    if (error) { toast.error("Failed to save: " + error.message); return; }
    toast.success(editingId ? "Venue updated" : "Venue added");
    cancelForm();
    void load();
  }

  async function deleteVenue(id: string) {
    const { error } = await supabase.from("venues").delete().eq("id", id);
    if (error) { toast.error("Cannot delete: " + error.message); return; }
    toast.success("Venue deleted");
    void load();
  }

  return (
    <div className="max-w-3xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <button onClick={onBack} style={{ fontSize: 12.5, color: "#71717A", background: "none", border: "none", cursor: "pointer", marginBottom: 12 }}>
        ← Back to Movement Orders
      </button>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#18181B", margin: 0 }}>Manage Venues</h1>
          <p style={{ marginTop: 4, fontSize: 13, color: "#71717A" }}>Venue catalog used in movement orders.</p>
        </div>
        {!adding && !editingId && (
          <button onClick={startAdd} className="inline-flex items-center gap-1.5 rounded-lg"
            style={{ padding: "8px 14px", fontSize: 13, fontWeight: 500, background: "var(--color-brand-500)", color: "#fff", border: "none", cursor: "pointer" }}>
            <Plus size={13} /> Add Venue
          </button>
        )}
      </div>

      {(adding || editingId) && (
        <div className="rounded-xl bg-white mb-4" style={{ padding: 16, border: "1px solid #4F46E555" }}>
          <div className="flex gap-3 flex-wrap">
            <label className="flex flex-col gap-1 flex-1" style={{ minWidth: 140 }}>
              <span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Name *</span>
              <input style={inputStyle} value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Ground Floor Storage" />
            </label>
            <label className="flex flex-col gap-1 flex-1" style={{ minWidth: 120 }}>
              <span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Floor</span>
              <div style={{ position: "relative" }}>
                <select style={{ ...inputStyle, appearance: "none" }} value={formFloor} onChange={(e) => setFormFloor(e.target.value)}>
                  <option value="">Select…</option>
                  {FLOORS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <ChevronDown size={13} style={{ position: "absolute", right: 10, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
              </div>
            </label>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveVenue} disabled={saving}
              style={{ padding: "6px 14px", fontSize: 12, borderRadius: 6, background: "#4F46E5", color: "#fff", border: "none", cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving…" : editingId ? "Save Changes" : "Add Venue"}
            </button>
            <button onClick={cancelForm} style={{ padding: "6px 12px", fontSize: 12, borderRadius: 6, background: "#fff", border: "1px solid #E4E4E7", color: "#52525B", cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2" style={{ fontSize: 13, color: "#A1A1AA", padding: "32px 0" }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : venues.length === 0 ? (
        <div className="rounded-xl text-center" style={{ padding: "48px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>
          No venues yet. Add one to get started.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {venues.map((venue) => (
            <div key={venue.id} className="flex items-center justify-between rounded-xl bg-white"
              style={{ padding: "12px 16px", border: "1px solid #E4E4E7" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "#18181B" }}>{venue.name}</div>
                {venue.floor && <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>{venue.floor}</div>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => startEdit(venue)}
                  style={{ padding: "4px 10px", fontSize: 12, borderRadius: 5, background: "#fff", border: "1px solid #E4E4E7", color: "#52525B", cursor: "pointer" }}>Edit</button>
                <button onClick={() => deleteVenue(venue.id)}
                  style={{ padding: "4px 10px", fontSize: 12, borderRadius: 5, background: "#fff", border: "1px solid #FECACA", color: "#B91C1C", cursor: "pointer" }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function StockGridView({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [stockMap, setStockMap] = useState<Record<string, ItemStock>>({});
  const [loading, setLoading] = useState(true);
  const [editingCell, setEditingCell] = useState<{ itemId: string; venueId: string } | null>(null);
  const [cellInput, setCellInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: itemsData }, { data: venuesData }, { data: stockData }] = await Promise.all([
      supabase.from("items").select("*").order("name"),
      supabase.from("venues").select("*").order("name"),
      supabase.from("item_stock").select("*"),
    ]);
    setItems((itemsData ?? []) as Item[]);
    setVenues((venuesData ?? []) as Venue[]);
    const map: Record<string, ItemStock> = {};
    ((stockData ?? []) as ItemStock[]).forEach((s) => { map[`${s.item_id}:${s.venue_id}`] = s; });
    setStockMap(map);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function startEdit(itemId: string, venueId: string) {
    const existing = stockMap[`${itemId}:${venueId}`];
    setCellInput(String(existing?.quantity ?? 0));
    setEditingCell({ itemId, venueId });
  }

  async function saveCell() {
    if (!editingCell) return;
    const qty = parseInt(cellInput, 10);
    if (isNaN(qty) || qty < 0) { toast.error("Enter a valid quantity"); return; }
    setSaving(true);
    const existing = stockMap[`${editingCell.itemId}:${editingCell.venueId}`];
    const { error } = existing
      ? await supabase.from("item_stock").update({ quantity: qty }).eq("id", existing.id)
      : await supabase.from("item_stock").insert({ item_id: editingCell.itemId, venue_id: editingCell.venueId, quantity: qty, reserved_quantity: 0 });
    setSaving(false);
    if (error) { toast.error("Failed to save: " + error.message); return; }
    setEditingCell(null);
    void load();
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto" style={{ padding: "32px 28px" }}>
        <div className="flex items-center gap-2" style={{ fontSize: 13, color: "#A1A1AA" }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <button onClick={onBack} style={{ fontSize: 12.5, color: "#71717A", background: "none", border: "none", cursor: "pointer", marginBottom: 12 }}>
        ← Back to Movement Orders
      </button>
      <div className="mb-6">
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#18181B", margin: 0 }}>Stock Grid</h1>
        <p style={{ marginTop: 4, fontSize: 13, color: "#71717A" }}>Click a cell to set stock. Shows total / reserved.</p>
      </div>

      {items.length === 0 || venues.length === 0 ? (
        <div className="rounded-xl text-center" style={{ padding: "48px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>
          Add items and venues first before managing stock.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead>
              <tr>
                <th style={{ padding: "8px 12px", background: "#F4F4F5", border: "1px solid #E4E4E7", textAlign: "left", fontWeight: 600, color: "#3F3F46", minWidth: 140 }}>
                  Item
                </th>
                {venues.map((v) => (
                  <th key={v.id} style={{ padding: "8px 12px", background: "#F4F4F5", border: "1px solid #E4E4E7", fontWeight: 600, color: "#3F3F46", minWidth: 100, textAlign: "center" }}>
                    {v.name}
                    {v.floor && <div style={{ fontSize: 10, fontWeight: 400, color: "#A1A1AA" }}>{v.floor}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td style={{ padding: "8px 12px", border: "1px solid #E4E4E7", background: "#FAFAFA", fontWeight: 500, color: "#18181B" }}>
                    {item.name}
                    {item.type && <div style={{ fontSize: 10, color: "#A1A1AA" }}>{item.type}</div>}
                  </td>
                  {venues.map((venue) => {
                    const stock = stockMap[`${item.id}:${venue.id}`];
                    const available = stock ? stock.quantity - stock.reserved_quantity : 0;
                    const isEditing = editingCell?.itemId === item.id && editingCell?.venueId === venue.id;
                    const isLow = !!stock && available <= 0;
                    return (
                      <td key={venue.id}
                        style={{ padding: "6px 10px", border: "1px solid #E4E4E7", textAlign: "center", background: isLow ? "#FEF3C7" : "#fff", cursor: "pointer", verticalAlign: "middle" }}
                        onClick={() => !isEditing && startEdit(item.id, venue.id)}>
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <input type="number" min={0}
                              style={{ ...inputStyle, width: 56, padding: "3px 6px", fontSize: 12 }}
                              value={cellInput}
                              onChange={(e) => setCellInput(e.target.value)}
                              autoFocus
                              onKeyDown={(e) => { if (e.key === "Enter") void saveCell(); if (e.key === "Escape") setEditingCell(null); }}
                            />
                            <button onClick={(e) => { e.stopPropagation(); void saveCell(); }} disabled={saving}
                              style={{ padding: "3px 7px", fontSize: 11, borderRadius: 4, background: "#4F46E5", color: "#fff", border: "none", cursor: "pointer" }}>
                              {saving ? "…" : "✓"}
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: isLow ? "#92400E" : "#3F3F46" }}>
                            {stock ? `${stock.quantity} / ${stock.reserved_quantity}` : "—"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  border: "1px solid #E4E4E7",
  borderRadius: 6,
  background: "#fff",
  color: "#18181B",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

// ─── DEMO PERSONAS ─────────────────────────────────────────────────────────────
// Requester: Ahmed Rahman (EMP-2847) — submits orders
// Admin: Farzana Islam (EMP-0445) — approves/rejects/assigns
// Mover: Karim (EMP-9001) — updates status

const ADMIN_ID = "EMP-0445";

type View = "list" | "new" | "items" | "venues" | "stock";

function MovementOrdersPage() {
  const { currentUser } = useCurrentUser();
  const isAdmin = currentUser.employee_id === ADMIN_ID;
  const [view, setView] = useState<View>("list");
  const [orders, setOrders] = useState<MO[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    let query = supabase
      .from("movement_orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (!isAdmin) {
      query = query.eq("requester_id", currentUser.employee_id);
    }

    const { data, error } = await query;
    if (error) { toast.error("Failed to load orders"); setLoading(false); return; }

    const rows = (data ?? []) as MO[];

    const requesterIds = [...new Set(rows.map((r) => r.requester_id))];
    const moverIds = [...new Set(rows.map((r) => r.assigned_mover_id).filter(Boolean) as string[])];
    const empIds = [...new Set([...requesterIds, ...moverIds])];

    if (empIds.length > 0) {
      const { data: emps } = await supabase.from("employees").select("employee_id, name").in("employee_id", empIds);
      const empMap: Record<string, string> = {};
      (emps ?? []).forEach((e) => { empMap[e.employee_id] = e.name; });
      rows.forEach((r) => {
        r.requesterName = empMap[r.requester_id];
        r.moverName = r.assigned_mover_id ? empMap[r.assigned_mover_id] ?? null : null;
      });
    }
    setOrders(rows);
    setLoading(false);
  }, [currentUser.employee_id, isAdmin]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { setView("list"); setExpanded(null); }, [currentUser.employee_id]);

  const visible = filterStatus === "all" ? orders : orders.filter((o) => o.status === filterStatus);

  if (view === "new") {
    return <NewOrderForm onCancel={() => setView("list")} onSaved={() => { setView("list"); void load(); }} />;
  }
  if (view === "items")  return <ItemsView onBack={() => setView("list")} />;
  if (view === "venues") return <VenuesView onBack={() => setView("list")} />;
  if (view === "stock")  return <StockGridView onBack={() => setView("list")} />;

  return (
    <div className="max-w-5xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }}>
            Movement Orders
          </h1>
          <p style={{ marginTop: 5, fontSize: 13.5, color: "#71717A" }}>
            {isAdmin ? "Manage and process inter-floor item transfer requests." : "Request and track item movements across floors."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {orders.length > 0 && (
            <button
              onClick={() => {
                const csv = toCsv(orders, [
                  { key: "ref_number", label: "Ref Number" },
                  { key: "item_name", label: "Item" },
                  { key: "quantity", label: "Quantity" },
                  { key: "source_location", label: "Source" },
                  { key: "destination_location", label: "Destination" },
                  { key: "status", label: "Status" },
                  { key: "requesterName", label: "Requester" },
                  { key: "created_at", label: "Created At" },
                ]);
                downloadCsv(`movement-orders-${new Date().toISOString().slice(0, 10)}.csv`, csv);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg"
              style={{ padding: "9px 14px", fontSize: 13, background: "#fff", border: "1px solid #E4E4E7", color: "#3F3F46", cursor: "pointer" }}
            >
              <Download size={14} /> Export CSV
            </button>
          )}
          {!isAdmin && (
            <button
              onClick={() => setView("new")}
              className="inline-flex items-center gap-1.5 rounded-lg"
              style={{ padding: "9px 16px", fontSize: 13, fontWeight: 500, background: "var(--color-brand-500)", color: "#fff", border: "none", cursor: "pointer" }}
            >
              <Plus size={14} /> New Request
            </button>
          )}
        </div>
      </div>

      {isAdmin && <AdminBar onNavigate={setView} />}

      {/* Status filter tabs */}
      <div className="flex gap-1 flex-wrap mb-5">
        {["all", "submitted", "approved", "in_transit", "completed", "rejected"].map((s) => {
          const active = s === filterStatus;
          const cfg = STATUS_LABELS[s];
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                borderRadius: 9999,
                border: `1px solid ${active ? (cfg?.color ?? "#18181B") : "#E4E4E7"}`,
                background: active ? (cfg?.bg ?? "#F4F4F5") : "#fff",
                color: active ? (cfg?.color ?? "#18181B") : "#52525B",
                cursor: "pointer",
                fontWeight: active ? 600 : 400,
              }}
            >
              {s === "all" ? "All" : STATUS_LABELS[s]?.label ?? s}
              {s === "all" && <span style={{ marginLeft: 5, color: "#A1A1AA" }}>({orders.length})</span>}
              {s !== "all" && <span style={{ marginLeft: 5, color: "inherit", opacity: 0.6 }}>({orders.filter((o) => o.status === s).length})</span>}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex items-center gap-2" style={{ fontSize: 13, color: "#A1A1AA", padding: "48px 0" }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl text-center" style={{ padding: "64px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>
          {filterStatus === "all"
            ? "No movement orders yet."
            : `No orders with status "${STATUS_LABELS[filterStatus]?.label ?? filterStatus}".`}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              isAdmin={isAdmin}
              expanded={expanded === order.id}
              onToggle={() => setExpanded(expanded === order.id ? null : order.id)}
              onRefresh={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard({
  order,
  isAdmin,
  expanded,
  onToggle,
  onRefresh,
}: {
  order: MO;
  isAdmin: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  const { currentUser } = useCurrentUser();
  const [actioning, setActioning] = useState(false);
  const [comment, setComment] = useState("");
  const [moverIdInput, setMoverIdInput] = useState(order.assigned_mover_id ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [editItemId, setEditItemId] = useState(order.item_id ?? "");
  const [editSourceVenueId, setEditSourceVenueId] = useState(order.source_venue_id ?? "");
  const [editDestVenueId, setEditDestVenueId] = useState(order.destination_venue_id ?? "");
  const [editQuantity, setEditQuantity] = useState(String(order.quantity));

  useEffect(() => {
    if (!expanded || !isAdmin) return;
    Promise.all([
      supabase.from("items").select("*").order("name"),
      supabase.from("venues").select("*").order("name"),
    ]).then(([{ data: itemsData }, { data: venuesData }]) => {
      setItems((itemsData ?? []) as Item[]);
      setVenues((venuesData ?? []) as Venue[]);
    });
  }, [expanded, isAdmin]);

  const [stockInfo, setStockInfo] = useState<ItemStock | null>(null);

  useEffect(() => {
    const itemId  = editItemId  || order.item_id;
    const venueId = editSourceVenueId || order.source_venue_id;
    if (!expanded || !isAdmin || !itemId || !venueId) { setStockInfo(null); return; }
    supabase.from("item_stock").select("*")
      .eq("item_id", itemId)
      .eq("venue_id", venueId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) { toast.error("Could not load stock info"); return; }
        setStockInfo(data as ItemStock | null);
      });
  }, [expanded, isAdmin, editItemId, editSourceVenueId, order.item_id, order.source_venue_id]);

  async function handleApprove() {
    if (!moverIdInput.trim()) { toast.error("Enter a mover employee ID"); return; }
    setActioning(true);

    if (order.item_id && order.source_venue_id) {
      await supabase.rpc("release_reservation", {
        p_item_id: order.item_id,
        p_venue_id: order.source_venue_id,
        p_qty: order.quantity,
      });
    }

    if (editItemId && editSourceVenueId && editDestVenueId) {
      const { error: stockErr } = await supabase.rpc("transfer_stock", {
        p_item_id: editItemId,
        p_source_venue_id: editSourceVenueId,
        p_dest_venue_id: editDestVenueId,
        p_qty: parseInt(editQuantity, 10),
      });
      if (stockErr) console.warn("Stock transfer failed:", stockErr.message);
    }

    const { error } = await supabase.from("movement_orders").update({
      status: "approved",
      item_id: editItemId || null,
      source_venue_id: editSourceVenueId || null,
      destination_venue_id: editDestVenueId || null,
      quantity: parseInt(editQuantity, 10),
      assigned_mover_id: moverIdInput.trim(),
      admin_comment: comment.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq("id", order.id);

    setActioning(false);
    if (error) { toast.error("Update failed: " + error.message); return; }
    await supabase.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: "approved",
      entity_type: "movement_order",
      entity_id: order.id,
      detail: `Approved movement order ${order.ref_number}`,
    });
    toast.success("Order approved and mover assigned");
    onRefresh();
  }

  async function handleReject() {
    setActioning(true);
    if (order.item_id && order.source_venue_id) {
      await supabase.rpc("release_reservation", {
        p_item_id: order.item_id,
        p_venue_id: order.source_venue_id,
        p_qty: order.quantity,
      });
    }
    const { error } = await supabase.from("movement_orders").update({
      status: "rejected",
      admin_comment: comment.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq("id", order.id);
    setActioning(false);
    if (error) { toast.error("Update failed: " + error.message); return; }
    await supabase.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: "rejected",
      entity_type: "movement_order",
      entity_id: order.id,
      detail: `Rejected movement order ${order.ref_number}`,
    });
    toast.success("Order rejected");
    onRefresh();
  }

  async function handleOnHold() {
    setActioning(true);
    const { error } = await supabase.from("movement_orders").update({
      status: "on_hold",
      admin_comment: comment.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq("id", order.id);
    setActioning(false);
    if (error) { toast.error("Update failed: " + error.message); return; }
    await supabase.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: "on_hold",
      entity_type: "movement_order",
      entity_id: order.id,
      detail: `Placed movement order ${order.ref_number} on hold`,
    });
    toast.success("Order placed on hold");
    onRefresh();
  }

  async function markInTransit() {
    setActioning(true);
    await supabase.from("movement_orders").update({ status: "in_transit", updated_at: new Date().toISOString() }).eq("id", order.id);
    await supabase.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: "status_changed",
      entity_type: "movement_order",
      entity_id: order.id,
      detail: `Marked movement order ${order.ref_number} in transit`,
    });
    setActioning(false);
    toast.success("Status updated: In Transit");
    onRefresh();
  }

  async function markCompleted() {
    setActioning(true);
    await supabase.from("movement_orders").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", order.id);
    await supabase.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: "status_changed",
      entity_type: "movement_order",
      entity_id: order.id,
      detail: `Completed movement order ${order.ref_number}`,
    });
    setActioning(false);
    toast.success("Movement order completed");
    onRefresh();
  }

  const isMoverView = order.assigned_mover_id === order.requester_id; // simplified — in real app check current user

  const effectiveVenueId = editSourceVenueId !== "" ? editSourceVenueId : order.source_venue_id;
  const isSameVenue = effectiveVenueId !== null && effectiveVenueId === order.source_venue_id;
  const othersReserved = stockInfo
    ? isSameVenue ? Math.max(0, stockInfo.reserved_quantity - order.quantity) : stockInfo.reserved_quantity
    : 0;
  const isOverStock = stockInfo !== null && parseInt(editQuantity, 10) > stockInfo.quantity;

  return (
    <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7" }}>
      <button className="w-full text-left" onClick={onToggle} style={{ padding: "16px 18px", display: "block" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="flex items-center gap-2.5 flex-wrap mb-1.5">
              <span style={{ fontWeight: 600, fontSize: 15, color: "#18181B" }}>{order.item_name}</span>
              {order.item_type && <span style={{ fontSize: 12, color: "#71717A" }}>{order.item_type}</span>}
              <StatusBadge status={order.status} />
            </div>
            <div className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: "#52525B" }}>
              <MapPin size={12} style={{ color: "#A1A1AA" }} />
              {order.source_location}
              <ArrowRight size={11} style={{ color: "#A1A1AA" }} />
              {order.destination_location}
              <span style={{ color: "#D4D4D8", marginLeft: 4 }}>·</span>
              <Package size={12} style={{ color: "#A1A1AA" }} />
              Qty {order.quantity}
            </div>
            <div style={{ fontSize: 12, color: "#A1A1AA", marginTop: 4 }}>
              Ref: <span className="font-mono">{order.ref_number}</span>
              {" · "}
              {isAdmin ? (
                <span>Requested by <strong style={{ color: "#52525B" }}>{order.requesterName ?? order.requester_id}</strong></span>
              ) : null}
              {" · "}{fmtDate(order.created_at)}
            </div>
          </div>
          <span style={{ color: "#A1A1AA" }}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
        </div>
      </button>

      {expanded && (
        <div style={{ borderTop: "1px solid #F4F4F5", background: "#FAFAFA", padding: "16px 18px" }}>
          {/* Details grid */}
          <div className="grid gap-x-6 gap-y-3 mb-4" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <DetailItem icon={<Box size={13} />} label="Item Type" value={order.item_type ?? "—"} />
            <DetailItem icon={<Package size={13} />} label="Quantity" value={String(order.quantity)} />
            <DetailItem icon={<MapPin size={13} />} label="From" value={order.source_location} />
            <DetailItem icon={<MapPin size={13} />} label="To" value={order.destination_location} />
            {order.preferred_time && (
              <DetailItem icon={<ClipboardList size={13} />} label="Preferred Time" value={order.preferred_time} />
            )}
            {order.assigned_mover_id && (
              <DetailItem icon={<Truck size={13} />} label="Assigned Mover" value={order.moverName ?? order.assigned_mover_id} />
            )}
          </div>
          {order.justification && (
            <div className="rounded-md mb-4" style={{ padding: "10px 12px", background: "#fff", border: "1px solid #E4E4E7", fontSize: 13, color: "#3F3F46" }}>
              <span style={{ fontSize: 11, color: "#A1A1AA", display: "block", marginBottom: 3 }}>Justification</span>
              {order.justification}
            </div>
          )}
          {order.admin_comment && (
            <div className="rounded-md mb-4" style={{ padding: "10px 12px", background: "#FFF8F0", border: "1px solid #FED7AA", fontSize: 13, color: "#7C2D12" }}>
              <span style={{ fontSize: 11, color: "#9A3412", display: "block", marginBottom: 3 }}>Admin Comment</span>
              {order.admin_comment}
            </div>
          )}

          {isAdmin && order.status === "submitted" && stockInfo && (
            <div className="flex items-center gap-2 mb-3 rounded-md"
              style={{ padding: "8px 12px", background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
              <Package size={13} style={{ color: "#16A34A", flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, color: "#15803D" }}>
                {order.item_name} @ {order.source_location}:{" "}
                <strong>{stockInfo!.quantity} in stock</strong>
                {othersReserved > 0 && <> · {othersReserved} other pending requests</>}
              </span>
              {isOverStock && (
                <span style={{ marginLeft: 6, fontSize: 11.5, fontWeight: 600, color: "#92400E", background: "#FEF3C7", padding: "2px 7px", borderRadius: 4 }}>
                  ⚠ Low stock
                </span>
              )}
            </div>
          )}

          {/* Admin actions */}
          {isAdmin && order.status === "submitted" && (
            <div className="flex flex-col gap-3 pt-2" style={{ borderTop: "1px solid #F0F0F0" }}>
              <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <label className="flex flex-col gap-1">
                  <span style={{ fontSize: 11, color: "#A1A1AA" }}>Item</span>
                  <div style={{ position: "relative" }}>
                    <select style={{ ...inputStyle, fontSize: 12, appearance: "none" }} value={editItemId} onChange={(e) => setEditItemId(e.target.value)}>
                      <option value="">Select item…</option>
                      {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </select>
                    <ChevronDown size={12} style={{ position: "absolute", right: 8, top: 10, color: "#A1A1AA", pointerEvents: "none" }} />
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ fontSize: 11, color: "#A1A1AA" }}>Quantity</span>
                  <input type="number" min={1} style={{ ...inputStyle, fontSize: 12 }} value={editQuantity} onChange={(e) => setEditQuantity(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ fontSize: 11, color: "#A1A1AA" }}>Source venue</span>
                  <div style={{ position: "relative" }}>
                    <select style={{ ...inputStyle, fontSize: 12, appearance: "none" }} value={editSourceVenueId} onChange={(e) => setEditSourceVenueId(e.target.value)}>
                      <option value="">Select venue…</option>
                      {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    <ChevronDown size={12} style={{ position: "absolute", right: 8, top: 10, color: "#A1A1AA", pointerEvents: "none" }} />
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ fontSize: 11, color: "#A1A1AA" }}>Destination venue</span>
                  <div style={{ position: "relative" }}>
                    <select style={{ ...inputStyle, fontSize: 12, appearance: "none" }} value={editDestVenueId} onChange={(e) => setEditDestVenueId(e.target.value)}>
                      <option value="">Select venue…</option>
                      {venues.filter((v) => v.id !== editSourceVenueId).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    <ChevronDown size={12} style={{ position: "absolute", right: 8, top: 10, color: "#A1A1AA", pointerEvents: "none" }} />
                  </div>
                </label>
              </div>
              <div className="flex gap-2 items-end flex-wrap">
                <div className="flex flex-col gap-1 flex-1" style={{ minWidth: 160 }}>
                  <label style={{ fontSize: 11.5, color: "#71717A" }}>Assign mover (Emp ID)</label>
                  <input style={{ ...inputStyle, fontSize: 12 }} placeholder="e.g. EMP-9001" value={moverIdInput} onChange={(e) => setMoverIdInput(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <label style={{ fontSize: 11.5, color: "#71717A" }}>Comment (optional)</label>
                  <input style={{ ...inputStyle, fontSize: 12 }} placeholder="Notes for requester…" value={comment} onChange={(e) => setComment(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={handleApprove} disabled={actioning || isOverStock}
                  className="inline-flex items-center gap-1.5 rounded-md font-medium text-white"
                  style={{ padding: "7px 14px", fontSize: 13, background: "#4F46E5", border: "none", cursor: (actioning || isOverStock) ? "not-allowed" : "pointer", opacity: (actioning || isOverStock) ? 0.6 : 1 }}>
                  <User size={13} /> Approve & Assign Mover
                </button>
                <button onClick={handleReject} disabled={actioning}
                  className="inline-flex items-center gap-1.5 rounded-md font-medium"
                  style={{ padding: "7px 12px", fontSize: 13, color: "#B91C1C", border: "1px solid #FECACA", background: "#fff", cursor: actioning ? "not-allowed" : "pointer" }}>
                  <XCircle size={13} /> Reject
                </button>
                <button onClick={handleOnHold} disabled={actioning}
                  className="inline-flex items-center gap-1.5 rounded-md font-medium"
                  style={{ padding: "7px 12px", fontSize: 13, color: "#52525B", border: "1px solid #E4E4E7", background: "#fff", cursor: actioning ? "not-allowed" : "pointer" }}>
                  Clarify
                </button>
              </div>
            </div>
          )}

          {/* Mover / admin in-transit → complete flow */}
          {order.status === "approved" && (isAdmin || order.assigned_mover_id === order.requester_id) && (
            <div className="flex gap-2 pt-2" style={{ borderTop: "1px solid #F0F0F0" }}>
              <button
                onClick={markInTransit}
                disabled={actioning}
                className="inline-flex items-center gap-1.5 rounded-md font-medium"
                style={{ padding: "7px 14px", fontSize: 13, background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A", cursor: actioning ? "not-allowed" : "pointer" }}
              >
                <Truck size={13} /> Mark In Transit
              </button>
            </div>
          )}
          {order.status === "in_transit" && (isAdmin || order.assigned_mover_id === order.requester_id) && (
            <div className="flex gap-2 pt-2" style={{ borderTop: "1px solid #F0F0F0" }}>
              <button
                onClick={markCompleted}
                disabled={actioning}
                className="inline-flex items-center gap-1.5 rounded-md font-medium text-white"
                style={{ padding: "7px 14px", fontSize: 13, background: "#16A34A", border: "none", cursor: actioning ? "not-allowed" : "pointer", opacity: actioning ? 0.6 : 1 }}
              >
                <CheckCircle2 size={13} /> Mark Delivered
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-0.5" style={{ fontSize: 11, color: "#A1A1AA" }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: 13, color: "#18181B", fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function NewOrderForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const { currentUser } = useCurrentUser();
  const [items, setItems] = useState<Item[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [sourceVenueId, setSourceVenueId] = useState("");
  const [destVenueId, setDestVenueId] = useState("");
  const [justification, setJustification] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [sourceStock, setSourceStock] = useState<ItemStock | null>(null);
  const [stockLoading, setStockLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from("items").select("*").order("name"),
      supabase.from("venues").select("*").order("name"),
    ]).then(([{ data: itemsData }, { data: venuesData }]) => {
      setItems((itemsData ?? []) as Item[]);
      setVenues((venuesData ?? []) as Venue[]);
    });
  }, []);

  useEffect(() => {
    if (!selectedItemId || !sourceVenueId) { setSourceStock(null); return; }
    setStockLoading(true);
    supabase.from("item_stock").select("*")
      .eq("item_id", selectedItemId)
      .eq("venue_id", sourceVenueId)
      .maybeSingle()
      .then(({ data }) => { setSourceStock(data as ItemStock | null); setStockLoading(false); });
  }, [selectedItemId, sourceVenueId]);

  async function handleSubmit() {
    if (!selectedItemId) { toast.error("Select an item"); return; }
    if (!sourceVenueId)  { toast.error("Select a source venue"); return; }
    if (!destVenueId)    { toast.error("Select a destination venue"); return; }
    if (sourceVenueId === destVenueId) { toast.error("Source and destination must be different"); return; }
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) { toast.error("Quantity must be at least 1"); return; }
    if (sourceStock !== null && sourceStock.quantity === 0) { toast.error("No stock available at this venue"); return; }

    const item        = items.find((i) => i.id === selectedItemId);
    const sourceVenue = venues.find((v) => v.id === sourceVenueId);
    const destVenue   = venues.find((v) => v.id === destVenueId);

    setSaving(true);
    const ref = "MO-" + Date.now().toString(36).toUpperCase();
    const { error } = await supabase.from("movement_orders").insert({
      ref_number: ref,
      requester_id: currentUser.employee_id,
      item_name: item?.name ?? "",
      item_type: item?.type ?? null,
      item_id: selectedItemId,
      quantity: qty,
      source_location: sourceVenue?.name ?? "",
      source_venue_id: sourceVenueId,
      destination_location: destVenue?.name ?? "",
      destination_venue_id: destVenueId,
      justification: justification.trim() || null,
      preferred_time: preferredTime || null,
      status: "submitted",
    });
    if (error) { toast.error("Failed to submit: " + error.message); setSaving(false); return; }

    const { error: stockErr } = await supabase.rpc("reserve_stock", {
      p_item_id: selectedItemId,
      p_venue_id: sourceVenueId,
      p_qty: qty,
    });
    if (stockErr) console.warn("Stock reservation failed:", stockErr.message);

    setSaving(false);
    toast.success(`Movement order ${ref} submitted`);
    onSaved();
  }

  return (
    <div className="max-w-2xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="mb-6">
        <button
          onClick={onCancel}
          style={{ fontSize: 12.5, color: "#71717A", background: "none", border: "none", cursor: "pointer", marginBottom: 12 }}
        >
          ← Back to Movement Orders
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#18181B", margin: 0 }}>New Movement Order</h1>
        <p style={{ marginTop: 5, fontSize: 13, color: "#71717A" }}>
          Request an inter-floor transfer of items within the office building.
        </p>
      </div>

      <div className="flex flex-col gap-5 rounded-xl bg-white" style={{ padding: 24, border: "1px solid #E4E4E7" }}>
        {/* Item details */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Box size={14} style={{ color: "#4F46E5" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#3F3F46", letterSpacing: "0.04em", textTransform: "uppercase" }}>Item Details</span>
          </div>
          <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="flex flex-col gap-1.5" style={{ gridColumn: "1 / -1" }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Item <span style={{ color: "#DC2626" }}>*</span></span>
              <div style={{ position: "relative" }}>
                <select style={{ ...inputStyle, appearance: "none" }} value={selectedItemId} onChange={(e) => setSelectedItemId(e.target.value)}>
                  <option value="">Select item…</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name}{i.type ? ` (${i.type})` : ""}</option>)}
                </select>
                <ChevronDown size={13} style={{ position: "absolute", right: 10, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
              </div>
            </label>
            <label className="flex flex-col gap-1.5">
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Quantity <span style={{ color: "#DC2626" }}>*</span></span>
              <input type="number" min={1} style={inputStyle} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </label>
          </div>
        </div>

        {/* Location */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <MapPin size={14} style={{ color: "#4F46E5" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#3F3F46", letterSpacing: "0.04em", textTransform: "uppercase" }}>Locations</span>
          </div>
          <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "1fr auto 1fr" }}>
            <label className="flex flex-col gap-1.5">
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Source (From) <span style={{ color: "#DC2626" }}>*</span></span>
              <div style={{ position: "relative" }}>
                <select style={{ ...inputStyle, appearance: "none" }} value={sourceVenueId} onChange={(e) => setSourceVenueId(e.target.value)}>
                  <option value="">Select venue…</option>
                  {venues.map((v) => <option key={v.id} value={v.id}>{v.name}{v.floor ? ` – ${v.floor}` : ""}</option>)}
                </select>
                <ChevronDown size={13} style={{ position: "absolute", right: 10, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
              </div>
              {sourceVenueId && selectedItemId && (
                <span style={{ fontSize: 11, color: "#71717A" }}>
                  {stockLoading ? "Checking stock…" : sourceStock
                    ? `${sourceStock.quantity} in stock${sourceStock.reserved_quantity > 0 ? ` · ${sourceStock.reserved_quantity} pending requests` : ""}`
                    : "No stock record — admin will check."}
                </span>
              )}
            </label>
            <ArrowRight size={16} style={{ color: "#A1A1AA", marginTop: 30 }} />
            <label className="flex flex-col gap-1.5">
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Destination (To) <span style={{ color: "#DC2626" }}>*</span></span>
              <div style={{ position: "relative" }}>
                <select style={{ ...inputStyle, appearance: "none" }} value={destVenueId} onChange={(e) => setDestVenueId(e.target.value)}>
                  <option value="">Select venue…</option>
                  {venues.filter((v) => v.id !== sourceVenueId).map((v) => <option key={v.id} value={v.id}>{v.name}{v.floor ? ` – ${v.floor}` : ""}</option>)}
                </select>
                <ChevronDown size={13} style={{ position: "absolute", right: 10, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
              </div>
            </label>
          </div>
          {sourceStock !== null && sourceStock.quantity === 0 && (
            <div className="rounded-md flex items-start gap-2 mt-3" style={{ padding: "9px 12px", background: "#FEF2F2", border: "1px solid #FECACA" }}>
              <span style={{ fontSize: 13 }}>🚫</span>
              <p style={{ fontSize: 12.5, color: "#B91C1C", margin: 0 }}>
                No stock available at this venue. Please select a different source.
              </p>
            </div>
          )}
          {sourceStock !== null && sourceStock.quantity > 0 && parseInt(quantity) > sourceStock.quantity && (
            <div className="rounded-md flex items-start gap-2 mt-3" style={{ padding: "9px 12px", background: "#FFFBEB", border: "1px solid #FDE68A" }}>
              <span style={{ fontSize: 13 }}>⚠️</span>
              <p style={{ fontSize: 12.5, color: "#92400E", margin: 0 }}>
                Only {sourceStock.quantity} in stock at this venue. Admin will review before approving.
              </p>
            </div>
          )}
        </div>

        {/* Additional details */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <ClipboardList size={14} style={{ color: "#4F46E5" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#3F3F46", letterSpacing: "0.04em", textTransform: "uppercase" }}>Additional Details</span>
          </div>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Justification / Reason</span>
              <textarea rows={3} style={{ ...inputStyle, resize: "vertical" }} placeholder="Why is this item being moved? Any context…" value={justification} onChange={(e) => setJustification(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Preferred Date & Time</span>
              <input type="datetime-local" style={inputStyle} value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)} />
              <span style={{ fontSize: 11, color: "#A1A1AA" }}>The admin will assign the mover accordingly.</span>
            </label>
          </div>
        </div>

        {/* Approval note */}
        <div className="rounded-md flex items-start gap-2.5" style={{ padding: "10px 12px", background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
          <CheckCircle2 size={14} style={{ color: "#16A34A", marginTop: 1, flexShrink: 0 }} />
          <p style={{ fontSize: 12.5, color: "#15803D", margin: 0 }}>
            This request will be reviewed by your supervisor. You'll be notified once approved and a mover is assigned.
          </p>
        </div>

        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} style={{ padding: "8px 16px", borderRadius: 6, fontSize: 13, background: "#fff", border: "1px solid #E4E4E7", color: "#52525B", cursor: "pointer" }}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md font-medium text-white"
            style={{ padding: "8px 18px", fontSize: 13, background: "var(--color-brand-500)", border: "none", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}
          >
            {saving ? <><Loader2 size={13} className="animate-spin" /> Submitting…</> : "Submit Request"}
          </button>
        </div>
      </div>
    </div>
  );
}
