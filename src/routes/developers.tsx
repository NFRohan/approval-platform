import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, KeyRound } from "lucide-react";
import { API_ERRORS, API_SCOPES, ENDPOINTS, WEBHOOK_EVENTS, type Endpoint } from "@/lib/api-catalogue";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

export const Route = createFileRoute("/developers")({
  head: () => ({ meta: [{ title: "API documentation · Admin Services Portal" }] }),
  component: DevelopersPage,
});

const INK = "#18181B";
const MUTED = "#71717A";
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const METHOD: Record<string, { bg: string; fg: string }> = {
  GET: { bg: "#EFF6FF", fg: "#1D4ED8" },
  POST: { bg: "#F0FDF4", fg: "#15803D" },
  PATCH: { bg: "#FFFBEB", fg: "#B45309" },
};
const GROUPS = ["Meta", "Requests", "Approvals", "Forms", "Reports", "Campaigns", "Audit"] as const;

// The address is this site's, which the server rendering the page does
// not know: filled in once the page is in the browser, so the two agree.
function useBase() {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  return origin + "/api/v1";
}

function Code({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg" style={{ background: "#18181B", position: "relative", margin: "8px 0 14px" }}>
      {label && <div style={{ ...mono, fontSize: 11, color: "#A1A1AA", padding: "8px 14px 0" }}>{label}</div>}
      <button type="button" aria-label="Copy" onClick={() => { void navigator.clipboard?.writeText(children); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        style={{ position: "absolute", top: 8, right: 8, background: "#27272A", border: "1px solid #3F3F46", borderRadius: 6, color: "#D4D4D8", padding: 4, cursor: "pointer", display: "inline-flex" }}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre style={{ ...mono, fontSize: 12, color: "#E4E4E7", padding: "12px 14px", margin: 0, overflowX: "auto", lineHeight: 1.55 }}>{children}</pre>
    </div>
  );
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id} style={{ fontSize: 20, fontWeight: 700, color: INK, letterSpacing: "-0.01em", margin: "40px 0 10px", scrollMarginTop: 80 }}>{children}</h2>;
}
function P({ children }: { children: ReactNode }) {
  return <p style={{ fontSize: 14, color: "#3F3F46", lineHeight: 1.65, margin: "0 0 12px", maxWidth: 760 }}>{children}</p>;
}
function C({ children }: { children: ReactNode }) {
  return <code style={{ ...mono, fontSize: 12.5, background: "#F4F4F5", padding: "1px 5px", borderRadius: 4 }}>{children}</code>;
}

function curlFor(e: Endpoint, b: string): string {
  const path = e.path.replace("{id}", e.params?.find((p) => p.in === "path")?.example ?? (e.group === "Approvals" ? "<step id>" : e.group === "Reports" ? "<report id>" : "AMS-2026-00418"));
  const q = (e.params ?? []).filter((p) => p.in === "query" && p.example).slice(0, 2).map((p) => `${p.name}=${encodeURIComponent(p.example!)}`).join("&");
  const lines = [`curl${e.method !== "GET" ? ` -X ${e.method}` : ""} "${b}${path}${q ? "?" + q : ""}" \\`, `  -H "Authorization: Bearer $AMS_KEY"`];
  if (e.body) {
    lines[lines.length - 1] += " \\";
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '${JSON.stringify(e.body.example)}'`);
  }
  return lines.join("\n");
}

function EndpointCard({ e, b }: { e: Endpoint; b: string }) {
  const [open, setOpen] = useState(false);
  const m = METHOD[e.method];
  return (
    <section id={e.id} className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "16px 18px", marginBottom: 12, scrollMarginTop: 80 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="rounded" style={{ ...mono, fontSize: 11.5, fontWeight: 700, padding: "2px 7px", background: m.bg, color: m.fg }}>{e.method}</span>
        <code style={{ ...mono, fontSize: 14, fontWeight: 600, color: INK }}>{e.path}</code>
        <span style={{ fontSize: 13, color: MUTED }}>— {e.summary}</span>
        {e.scope && <span className="rounded-full" style={{ marginLeft: "auto", fontSize: 11, padding: "1px 8px", background: "#EEF2FF", color: "#4338CA", border: "1px solid #C7D2FE", ...mono }}>{e.scope}</span>}
      </div>
      <p style={{ fontSize: 13.5, color: "#3F3F46", lineHeight: 1.6, margin: "10px 0 8px" }}>{e.description}</p>
      {e.params && e.params.length > 0 && (
        <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse", margin: "6px 0 8px" }}>
          <tbody>
            {e.params.map((p) => (
              <tr key={p.name} style={{ borderTop: "1px solid #F4F4F5" }}>
                <td style={{ padding: "6px 8px 6px 0", whiteSpace: "nowrap", verticalAlign: "top" }}><C>{p.name}</C>{p.in === "path" && <span style={{ fontSize: 11, color: MUTED, marginLeft: 6 }}>in the path</span>}</td>
                <td style={{ padding: "6px 0", color: "#3F3F46" }}>{p.description}{p.example && <span style={{ color: MUTED }}> — e.g. <C>{p.example}</C></span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Code>{curlFor(e, b)}</Code>
      <button type="button" onClick={() => setOpen(!open)} style={{ fontSize: 12.5, color: "#4338CA", background: "none", border: 0, padding: 0, cursor: "pointer" }}>
        {open ? "Hide" : "Show"} the response ({e.response.status})
      </button>
      {open && <Code>{JSON.stringify(e.response.example, null, 2)}</Code>}
    </section>
  );
}

const NODE_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

// Express: app.post("/hooks/ams", express.text({ type: "*/*" }), handler)
export function handler(req, res) {
  const body = req.body;                                  // the raw text, exactly as sent
  const timestamp = req.get("X-AMS-Timestamp");
  const signature = req.get("X-AMS-Signature") ?? "";
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return res.sendStatus(401);   // replayed

  const expected = "sha256=" + createHmac("sha256", process.env.AMS_WEBHOOK_SECRET)
    .update(\`\${timestamp}.\${body}\`).digest("hex");
  const ok = expected.length === signature.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  if (!ok) return res.sendStatus(401);

  const event = JSON.parse(body);
  // event.id is the delivery id — the same on a retry, so use it to ignore duplicates.
  console.log(event.event, event.data.request.reference, event.data.request.status);
  res.sendStatus(204);
}`;

const PY_VERIFY = `import hashlib, hmac, json, os, time
from flask import Flask, request, abort

app = Flask(__name__)

@app.post("/hooks/ams")
def ams():
    body = request.get_data(as_text=True)
    ts = request.headers.get("X-AMS-Timestamp", "0")
    if abs(time.time() - int(ts)) > 300:
        abort(401)
    expected = "sha256=" + hmac.new(os.environ["AMS_WEBHOOK_SECRET"].encode(),
                                    f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("X-AMS-Signature", "")):
        abort(401)
    event = json.loads(body)
    print(event["event"], event["data"]["request"]["reference"])
    return "", 204`;

function DevelopersPage() {
  const { can } = useCurrentUser();
  const b = useBase();
  const grouped = useMemo(() => GROUPS.map((g) => ({ g, items: ENDPOINTS.filter((e) => e.group === g) })), []);
  const payload = {
    id: "8a0f5c1e-…", event: "request.completed", occurred_at: "2026-11-23T08:41:12.004Z", organisation: "acme-bank",
    data: {
      request: { id: "6f1c2a0e-…", reference: "AMS-2026-00418", form: { name: "Capital Expenditure Request" }, status: "completed", requester: { employee_id: "EMP-2847", name: "Tom Bexley" }, answers: { "Amount": "1850000", "Vendor": "Rahimafrooz" } },
      actor: null, comment: null,
    },
  };

  return (
    <div className="mx-auto" style={{ maxWidth: 1200, padding: "28px 28px 64px" }}>
      <div className="grid gap-8" style={{ gridTemplateColumns: "200px minmax(0, 1fr)" }}>
        <nav style={{ position: "sticky", top: 76, alignSelf: "start", fontSize: 13 }} aria-label="On this page">
          {[["start", "Getting started"], ["auth", "Keys and scopes"], ...GROUPS.map((g) => [g.toLowerCase(), g === "Meta" ? "This key" : g]), ["webhooks", "Webhooks"], ["errors", "Errors"], ["tools", "Tableau, Power BI, Excel"]].map(([id, label]) => (
            <a key={id} href={`#${id}`} style={{ display: "block", padding: "4px 0", color: "#3F3F46" }}>{label}</a>
          ))}
          <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1" style={{ marginTop: 12, color: "#4338CA", fontWeight: 500 }}>
            openapi.json <ExternalLink size={12} />
          </a>
        </nav>

        <main style={{ minWidth: 0 }}>
          <div className="rounded-2xl" style={{ padding: "26px 28px", background: "linear-gradient(135deg, #18181B, #312E81)", color: "#fff" }}>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#C7D2FE", fontWeight: 600 }}>Open API · v1</div>
            <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", margin: "6px 0 8px" }}>Connect your ERP, Tableau and everything else</h1>
            <p style={{ fontSize: 14.5, color: "#E0E7FF", lineHeight: 1.6, maxWidth: 700, margin: 0 }}>
              Raise requests from the ERP and follow them through approval; approve from another system as the approver; pull reports as JSON or CSV
              into Tableau or Power BI; and be told the moment something happens, by signed webhook. REST and JSON, described in OpenAPI 3.1.
            </p>
            <div className="flex gap-2 flex-wrap mt-4">
              <code style={{ ...mono, fontSize: 13, background: "rgba(255,255,255,0.1)", padding: "6px 10px", borderRadius: 6 }}>{b}</code>
              {can("integrations.manage") && (
                <Link to="/admin/integrations" className="inline-flex items-center gap-1.5 rounded-md" style={{ padding: "6px 12px", fontSize: 13, fontWeight: 600, background: "#fff", color: "#312E81" }}>
                  <KeyRound size={14} /> Get a key
                </Link>
              )}
            </div>
          </div>

          <H2 id="start">Getting started</H2>
          <P>An administrator makes a key under <strong>Administration → Integrations</strong>, names it after the system that will use it and chooses what it may do. The key is shown once. Then:</P>
          <Code label="1 · Check the key">{`export AMS_KEY="ams_…"\ncurl ${b}/me -H "Authorization: Bearer $AMS_KEY"`}</Code>
          <Code label="2 · See what can be raised, and the fields each form takes">{`curl ${b}/forms -H "Authorization: Bearer $AMS_KEY"`}</Code>
          <Code label="3 · Raise one, for an employee">{`curl -X POST ${b}/requests \\
  -H "Authorization: Bearer $AMS_KEY" -H "Content-Type: application/json" \\
  -d '{"form": "Travel & Expense Reimbursement", "on_behalf_of": "EMP-2847",
       "answers": {"Purpose of travel": "Client visit", "Travel date": "2026-11-28", "Amount claimed": 42000}}'`}</Code>
          <Code label="4 · Approve it from the ERP, as the approver">{`curl -X POST ${b}/approvals/<step id>/decision \\
  -H "Authorization: Bearer $AMS_KEY" -H "Content-Type: application/json" \\
  -d '{"decision": "approve", "comment": "Budget confirmed in SAP"}'`}</Code>

          <H2 id="auth">Keys and scopes</H2>
          <P>Send the key as a bearer token: <C>Authorization: Bearer ams_…</C> (or <C>X-API-Key</C>). Only a hash is kept, so a lost key is revoked and replaced. A revoked key stops working at its very next call. Every call is logged — key, path, answer, time taken and address — in the audit centre.</P>
          <P>A key reads as the organisation. It acts as an employee: writes name one in <C>on_behalf_of</C>, and are checked exactly as that person's would be on screen — a decision is refused unless they are the step's approver or a delegate of theirs.</P>
          <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", marginBottom: 8 }}>
            <tbody>
              {API_SCOPES.map((s) => (
                <tr key={s.key} style={{ borderTop: "1px solid #F4F4F5" }}>
                  <td style={{ padding: "8px 10px 8px 0", whiteSpace: "nowrap" }}><C>{s.key}</C></td>
                  <td style={{ padding: "8px 0", color: "#3F3F46" }}><strong>{s.label}.</strong> {s.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {grouped.map(({ g, items }) => (
            <div key={g}>
              <H2 id={g.toLowerCase()}>{g === "Meta" ? "This key" : g}</H2>
              {items.map((e) => <EndpointCard key={e.id} e={e} b={b} />)}
            </div>
          ))}

          <H2 id="webhooks">Webhooks</H2>
          <P>Rather than ask every few minutes, be told. A webhook POSTs JSON to your address for the events it listens for — within seconds of the decision on screen. Anything but a 2xx answer is tried again after one minute, then five; after that it is marked failed and can be redelivered from the delivery log.</P>
          <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", marginBottom: 12 }}>
            <tbody>
              {WEBHOOK_EVENTS.map((e) => (
                <tr key={e.key} style={{ borderTop: "1px solid #F4F4F5" }}>
                  <td style={{ padding: "7px 10px 7px 0", whiteSpace: "nowrap" }}><C>{e.key}</C></td>
                  <td style={{ padding: "7px 0", color: "#3F3F46" }}>{e.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Code label="Headers">{`POST /hooks/ams HTTP/1.1
Content-Type: application/json
User-Agent: AMS-Webhooks/1.0
X-AMS-Event: request.completed
X-AMS-Delivery: 8a0f5c1e-…            the same on a retry
X-AMS-Timestamp: 1795423272           seconds, when it was signed
X-AMS-Signature: sha256=5f2c…         HMAC-SHA256(secret, timestamp + "." + body)`}</Code>
          <Code label="Body">{JSON.stringify(payload, null, 2)}</Code>
          <P>Verify every delivery before trusting it: recompute the HMAC over the timestamp, a full stop and the raw body with the webhook's signing secret, compare in constant time, and refuse a timestamp more than five minutes old so a captured delivery cannot be replayed.</P>
          <Code label="Node.js">{NODE_VERIFY}</Code>
          <Code label="Python">{PY_VERIFY}</Code>
          <P>To try it without standing anything up, point a webhook at <C>/webhooks/echo</C>: the built-in receiver checks the signature exactly like this and answers with what it found, which the delivery log shows.</P>

          <H2 id="errors">Errors</H2>
          <P>Every error is JSON — <C>{`{"error": {"status": 422, "message": "Amount claimed is required", "details": {"missing": ["Amount claimed"]}}}`}</C> — with a message written to be shown to a person.</P>
          <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse" }}>
            <tbody>
              {API_ERRORS.map((e) => (
                <tr key={e.status} style={{ borderTop: "1px solid #F4F4F5" }}>
                  <td style={{ padding: "7px 10px 7px 0", ...mono, fontWeight: 600 }}>{e.status}</td>
                  <td style={{ padding: "7px 0", color: "#3F3F46" }}>{e.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <H2 id="tools">Tableau, Power BI, Excel</H2>
          <P>Every saved report is an endpoint: <C>{`GET ${b}/reports/<id>?format=csv`}</C> returns the report with its saved filters as CSV, and without <C>format</C> as rows with typed columns. Give the reporting tool a key with only <C>reports:read</C> (and <C>campaigns:read</C> for the campaign dashboard).</P>
          <ul style={{ fontSize: 14, color: "#3F3F46", lineHeight: 1.7, paddingLeft: 20, maxWidth: 760 }}>
            <li><strong>Power BI</strong> — Get data → Web → Advanced; the report's CSV address, and an HTTP header <C>Authorization</C> of <C>Bearer ams_…</C>. Schedule the refresh as usual.</li>
            <li><strong>Excel</strong> — Data → From Web → Advanced, the same address and header.</li>
            <li><strong>Tableau</strong> — a Web Data Connector, or a scheduled Tableau Prep flow, reading the JSON form of the report or <C>/campaigns</C>.</li>
          </ul>
        </main>
      </div>
    </div>
  );
}
