import { useRef, useEffect, useState, lazy, Suspense } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// Lazy-load the MathLive-based editor so its large bundle only downloads when a
// teacher actually opens it — students taking tests never pay for it.
const EquationEditor = lazy(() => import('./EquationEditor.jsx'));

// A math "chip": an atomic, non-editable span showing rendered math, tagged with
// its LaTeX so we can round-trip it back to a $…$ string.
function chipEl(latex) {
  const span = document.createElement('span');
  span.className = 'mathchip';
  span.setAttribute('contenteditable', 'false');
  span.dataset.latex = latex;
  span.title = 'Click to edit this equation';
  try { span.innerHTML = katex.renderToString(latex, { throwOnError: false }); }
  catch { span.textContent = latex; }
  return span;
}

// Stored string ($…$-delimited) → DOM nodes inside `root`.
function renderInto(root, value) {
  root.innerHTML = '';
  const s = String(value || '');
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$') {
      const end = s.indexOf('$', i + 1);
      if (end > i) { root.appendChild(chipEl(s.slice(i + 1, end))); i = end + 1; continue; }
    }
    let next = s.indexOf('$', i);
    if (next === i) next = i + 1;
    if (next === -1) next = s.length;
    if (next > i) root.appendChild(document.createTextNode(s.slice(i, next)));
    i = next;
  }
}

// DOM nodes → stored string.
function serialize(root) {
  let out = '';
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.data;
    else if (n.nodeType === Node.ELEMENT_NODE) {
      if (n.classList && n.classList.contains('mathchip')) out += '$' + (n.dataset.latex || '') + '$';
      else if (n.tagName === 'BR') out += '\n';
      else out += n.textContent;
    }
  });
  return out;
}

// A text box where equations appear rendered inline (never as LaTeX code).
// value/onChange use a $…$-delimited string, identical to what students render.
export default function RichMathInput({ value, onChange, placeholder, oneLine = false }) {
  const ref = useRef(null);
  const lastEmitted = useRef(null);
  const savedRange = useRef(null);
  const [editing, setEditing] = useState(null); // { latex, chip|null }

  // Re-render only when the value changes from OUTSIDE (load/reset), never from
  // our own typing — otherwise the caret would jump on every keystroke.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    if (ref.current) { renderInto(ref.current, value); lastEmitted.current = value; }
  }, [value]);

  function emit() {
    const s = serialize(ref.current);
    lastEmitted.current = s;
    onChange(s);
  }
  function saveSel() {
    const sel = window.getSelection();
    savedRange.current = (sel && sel.rangeCount && ref.current.contains(sel.anchorNode))
      ? sel.getRangeAt(0).cloneRange() : null;
  }
  function onClickBox(e) {
    const chip = e.target.closest && e.target.closest('.mathchip');
    if (chip && ref.current.contains(chip)) setEditing({ latex: chip.dataset.latex || '', chip });
  }
  function applyEquation(latex) {
    const clean = String(latex || '').trim();
    const target = editing;
    setEditing(null);
    if (!clean) return;
    if (target.chip) {
      target.chip.replaceWith(chipEl(clean));
    } else {
      const chip = chipEl(clean);
      const root = ref.current;
      const range = savedRange.current;
      if (range && root.contains(range.startContainer)) {
        range.deleteContents();
        range.insertNode(chip);
        const after = document.createRange();
        after.setStartAfter(chip); after.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(after);
      } else {
        root.appendChild(chip);
      }
    }
    emit();
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={saveSel}
        onClick={onClickBox}
        style={{
          minHeight: oneLine ? 22 : 60, border: '1px solid var(--line)', borderRadius: 8,
          padding: '8px 10px', background: '#fff', outline: 'none',
          whiteSpace: 'pre-wrap', lineHeight: 2, overflowWrap: 'anywhere',
        }}
      />
      {!value && (
        <div style={{ position: 'absolute', top: 9, left: 11, color: '#9ca3af', pointerEvents: 'none', fontSize: 14 }}>{placeholder}</div>
      )}
      <button type="button" className="btn secondary small" style={{ marginTop: 6 }}
        onMouseDown={(e) => { e.preventDefault(); saveSel(); }}
        onClick={() => setEditing({ latex: '', chip: null })}>
        ➕ Insert equation
      </button>
      {editing && (
        <Suspense fallback={null}>
          <EquationEditor initial={editing.latex} onClose={() => setEditing(null)} onInsert={applyEquation} />
        </Suspense>
      )}
    </div>
  );
}
