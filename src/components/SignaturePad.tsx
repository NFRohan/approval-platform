// =====================================================================
// A drawn signature.
//
// For an approval step marked "signature required". Pointer events, so a
// mouse, a finger on a phone and a pen all draw. The result is a PNG data
// URL — what act_on_approval accepts and keeps with the step.
// =====================================================================

import { useEffect, useRef, useState } from "react";

export function SignaturePad({ onChange, height = 140 }: { onChange: (dataUrl: string | null) => void; height?: number }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    // Sharp on high-density screens, and white rather than transparent so
    // the saved image reads on any background.
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = height * ratio;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.clientWidth, height);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#18181B";
  }, [height]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (empty) setEmpty(false);
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (!empty && canvas.current) onChange(canvas.current.toDataURL("image/png"));
  }

  function clear() {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.clientWidth, height);
    setEmpty(true);
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvas}
        aria-label="Signature pad — draw your signature"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        style={{ width: "100%", height, border: "1px dashed #A1A1AA", borderRadius: 8, touchAction: "none", cursor: "crosshair", background: "#fff" }}
      />
      <div className="flex justify-between items-center mt-1" style={{ fontSize: 11.5, color: "#71717A" }}>
        <span>{empty ? "Draw your signature above" : "Signed"}</span>
        <button type="button" onClick={clear} style={{ color: "#4338CA" }}>Clear</button>
      </div>
    </div>
  );
}
