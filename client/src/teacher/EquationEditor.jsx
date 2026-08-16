import { useRef, useEffect, useState } from 'react';
import { MathfieldElement } from 'mathlive';
import { Modal } from '../components.jsx';

// Serve MathLive's fonts from our own /public (no CDN); we don't use its sounds.
MathfieldElement.fontsDirectory = '/mathlive/fonts';
MathfieldElement.soundsDirectory = null;

// Friendly symbol/template palette. Each button inserts a LaTeX snippet into the
// math field; #? becomes an editable placeholder box the teacher fills in.
const PALETTE = [
  { label: 'x²', ins: 'x^2' },
  { label: 'xⁿ', ins: 'x^{#?}' },
  { label: 'x₁', ins: 'x_{#?}' },
  { label: '▢/▢', ins: '\\frac{#?}{#?}' },
  { label: '√', ins: '\\sqrt{#?}' },
  { label: 'ⁿ√', ins: '\\sqrt[#?]{#?}' },
  { label: '∫', ins: '\\int_{#?}^{#?}#?\\,d#?' },
  { label: 'd/dx', ins: '\\frac{d}{dx}' },
  { label: '∂', ins: '\\partial' },
  { label: 'lim', ins: '\\lim_{#?\\to #?}' },
  { label: 'Σ', ins: '\\sum_{#?}^{#?}' },
  { label: '∞', ins: '\\infty' },
  { label: 'π', ins: '\\pi' },
  { label: 'θ', ins: '\\theta' },
  { label: 'α', ins: '\\alpha' },
  { label: 'β', ins: '\\beta' },
  { label: 'Δ', ins: '\\Delta' },
  { label: '±', ins: '\\pm' },
  { label: '×', ins: '\\times' },
  { label: '÷', ins: '\\div' },
  { label: '≤', ins: '\\le' },
  { label: '≥', ins: '\\ge' },
  { label: '≠', ins: '\\ne' },
  { label: '→', ins: '\\to' },
];

// A pop-up visual equation builder. `initial` is a LaTeX string; onInsert(latex)
// returns the built equation. Teachers never type LaTeX by hand.
export default function EquationEditor({ initial = '', onClose, onInsert }) {
  const ref = useRef(null);
  const [empty, setEmpty] = useState(!initial.trim());

  useEffect(() => {
    const mf = ref.current;
    if (!mf) return;
    mf.mathVirtualKeyboardPolicy = 'manual';
    mf.value = initial || '';
    const onInput = () => setEmpty(!mf.value.trim());
    mf.addEventListener('input', onInput);
    const t = setTimeout(() => mf.focus(), 60);
    return () => { clearTimeout(t); mf.removeEventListener('input', onInput); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stamp = (ins) => { const mf = ref.current; if (mf) { mf.insert(ins); mf.focus(); setEmpty(!mf.value.trim()); } };
  const done = () => { const mf = ref.current; if (mf) onInsert(mf.value); };

  return (
    <Modal title="Insert an equation" onClose={onClose} wide>
      <p className="muted" style={{ marginTop: 0 }}>
        Type it like you'd say it — <code>x^2</code>, <code>1/2</code>, <code>sqrt</code>, <code>pi</code> — and it formats as you go, or tap a symbol below.
      </p>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        {PALETTE.map((p) => (
          <button key={p.label} type="button" className="btn ghost small" style={{ padding: '2px 9px', minWidth: 0, fontSize: 15 }}
            onMouseDown={(e) => { e.preventDefault(); stamp(p.ins); }}>{p.label}</button>
        ))}
      </div>
      <math-field
        ref={ref}
        style={{ display: 'block', fontSize: '24px', padding: '12px 14px', border: '2px solid var(--brand)', borderRadius: 10, minHeight: 34, background: '#fff' }}
      ></math-field>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" type="button" disabled={empty} onClick={done}>Insert equation</button>
        <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
