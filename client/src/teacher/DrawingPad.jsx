import { useRef, useEffect, useState } from 'react';
import { Modal } from '../components.jsx';
import { useAlert } from '../confirm.jsx';

const W = 780, H = 460;
const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#7c3aed'];

// A lightweight whiteboard for drawing question diagrams (benzene rings,
// circuits, free sketches, hand-written math). Exports a PNG data URL.
export default function DrawingPad({ initial, onClose, onSave }) {
  const alert = useAlert();
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const drawingRef = useRef(false);
  const undoRef = useRef([]);
  const [color, setColor] = useState('#111827');
  const [size, setSize] = useState(3);
  const [erasing, setErasing] = useState(false);

  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctxRef.current = ctx;
    const done = () => pushUndo();
    if (initial) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, W, H); done(); };
      img.onerror = done;
      img.src = initial;
    } else {
      done();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushUndo() {
    try {
      undoRef.current.push(ctxRef.current.getImageData(0, 0, W, H));
      if (undoRef.current.length > 25) undoRef.current.shift();
    } catch { /* ignore (e.g. tainted canvas) */ }
  }
  function coords(e) {
    const r = canvasRef.current.getBoundingClientRect();
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (W / r.width), y: (t.clientY - r.top) * (H / r.height) };
  }
  function start(e) {
    e.preventDefault();
    drawingRef.current = true;
    const { x, y } = coords(e);
    const ctx = ctxRef.current;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function move(e) {
    if (!drawingRef.current) return;
    e.preventDefault();
    const { x, y } = coords(e);
    const ctx = ctxRef.current;
    ctx.strokeStyle = erasing ? '#ffffff' : color;
    ctx.lineWidth = erasing ? size * 6 : size;
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  function end() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    pushUndo();
  }
  function undo() {
    const u = undoRef.current;
    if (u.length > 1) { u.pop(); ctxRef.current.putImageData(u[u.length - 1], 0, 0); }
  }
  function clear() {
    const ctx = ctxRef.current;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    pushUndo();
  }
  // Stamp a regular hexagon (optionally with an inner circle = benzene ring).
  function hexagon(withCircle) {
    const ctx = ctxRef.current;
    const cx = W / 2, cy = H / 2, r = 90;
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + k * (Math.PI / 3);
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    if (withCircle) { ctx.beginPath(); ctx.arc(cx, cy, r * 0.56, 0, 2 * Math.PI); ctx.stroke(); }
    pushUndo();
  }
  function circle() {
    const ctx = ctxRef.current;
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 80, 0, 2 * Math.PI);
    ctx.stroke();
    pushUndo();
  }
  function save() {
    try { onSave(canvasRef.current.toDataURL('image/png')); }
    catch { alert('Could not export the drawing.'); }
  }

  const toolBtn = (active) => 'btn small ' + (active ? '' : 'ghost');

  return (
    <Modal title="✏️ Draw a diagram" onClose={onClose} wide>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <button type="button" className={toolBtn(!erasing)} onClick={() => setErasing(false)}>✏️ Pen</button>
        <button type="button" className={toolBtn(erasing)} onClick={() => setErasing(true)}>🧹 Eraser</button>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          {COLORS.map((c) => (
            <button key={c} type="button" onClick={() => { setColor(c); setErasing(false); }} title={c}
              style={{ width: 22, height: 22, borderRadius: '50%', background: c, cursor: 'pointer', border: color === c && !erasing ? '3px solid var(--brand)' : '2px solid #fff', boxShadow: '0 0 0 1px var(--line)' }} />
          ))}
        </span>
        <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          Size
          <input type="range" min="1" max="14" value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ width: 90 }} />
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost small" onClick={undo}>↶ Undo</button>
        <button type="button" className="btn ghost small" onClick={clear}>Clear</button>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>Insert:</span>
        <button type="button" className="btn ghost small" onClick={() => hexagon(true)}>⬡ Benzene ring</button>
        <button type="button" className="btn ghost small" onClick={() => hexagon(false)}>⬡ Hexagon</button>
        <button type="button" className="btn ghost small" onClick={circle}>◯ Circle</button>
      </div>

      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ width: '100%', maxWidth: W, aspectRatio: `${W} / ${H}`, border: '1px solid var(--line)', borderRadius: 8, touchAction: 'none', cursor: 'crosshair', background: '#fff' }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />

      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="btn" onClick={save}>Use this drawing</button>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
