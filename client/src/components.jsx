import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { logout } from './api.js';

// A brand top bar. `right` is extra content (e.g. user + logout).
export function Topbar({ brandTo = '/', center = null, right = null }) {
  return (
    <div className="topbar">
      <Link className="brand" to={brandTo}>📝 Test<span>Platform</span></Link>
      {center}
      {right || <span />}
    </div>
  );
}

// Two-letter initials from a "Name · Role" label.
function initialsOf(who) {
  const name = String(who || '').split('·')[0].trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// A dashboard top bar with the user label, optional org name, and log out.
export function DashboardBar({ who, orgName, children }) {
  return (
    <div className="topbar">
      <Link className="brand" to="/">📝 Test<span>Platform</span></Link>
      {orgName ? <span className="org-chip">🏢 {orgName}</span> : <span />}
      <div className="row" style={{ gap: 10 }}>
        {who && <span className="avatar" title={who}>{initialsOf(who)}</span>}
        {who && <span className="user">{who}</span>}
        {children}
        <button className="btn ghost small" onClick={logout}>Log out</button>
      </div>
    </div>
  );
}

// Inline message banner. kind = 'error' | 'ok'. Renders nothing if no text.
export function Msg({ text, kind = 'error' }) {
  if (!text) return null;
  return <div className={`msg ${kind}`}>{text}</div>;
}

// Password input with a show/hide eye toggle.
export function PasswordInput(props) {
  const [show, setShow] = useState(false);
  return (
    <span className="pw-wrap">
      <input {...props} type={show ? 'text' : 'password'} />
      <button type="button" className="pw-toggle" aria-label={show ? 'Hide password' : 'Show password'}
        onClick={() => setShow((s) => !s)}>{show ? '🙈' : '👁'}</button>
    </span>
  );
}

// A small "ⓘ" affordance that reveals help text on hover, focus, or tap.
// Keeps long explanations out of the way until the user wants them.
export function InfoTip({ text, label = 'More information' }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <button type="button" aria-label={label} title=""
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShow(true); }}
        onFocus={() => setShow(true)} onBlur={() => setShow(false)}
        style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid #c7d2fe', background: '#eef2ff', color: '#3730a3', fontSize: 12, fontWeight: 700, fontStyle: 'italic', lineHeight: 1, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>i</button>
      {show && (
        <span role="tooltip" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, width: 260, maxWidth: '70vw', background: '#111827', color: '#fff', padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 400, fontStyle: 'normal', lineHeight: 1.5, boxShadow: '0 8px 24px rgba(0,0,0,.28)' }}>
          {text}
        </span>
      )}
    </span>
  );
}

// Modal overlay; closes on backdrop click or the ✕ button. `wide` widens it.
export function Modal({ title, onClose, children, wide = false }) {
  const backdrop = useRef(null);
  return (
    <div className="modal-overlay" ref={backdrop}
      onClick={(e) => { if (e.target === backdrop.current) onClose(); }}>
      <div className="modal" style={wide ? { maxWidth: 680 } : undefined}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Copy text to the clipboard with a legacy fallback for browsers/contexts that
// block navigator.clipboard (no page focus, insecure origin, denied permission).
// Never throws — returns true only if the copy definitely succeeded, so callers
// can fall back to showing the text for manual copying.
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// Copy text to the clipboard, flashing a label on a button. Returns whether the
// copy succeeded so callers can surface the text when the clipboard is blocked.
export function useCopyButton() {
  return async (text, btn) => {
    const ok = await copyText(text);
    const prev = btn.textContent;
    btn.textContent = ok ? 'Copied!' : 'Press Ctrl/⌘+C';
    setTimeout(() => { btn.textContent = prev; }, ok ? 1500 : 2500);
    return ok;
  };
}

// Date + time picker with an explicit 12-hour AM/PM selector (native
// datetime-local can't force 12h). Value is 'YYYY-MM-DDTHH:mm' (24h) or ''.
export function DateTime12({ value, onChange }) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value || '');
  const cur = m
    ? { date: m[1], hour: (Number(m[2]) % 12) || 12, minute: Number(m[3]), ampm: Number(m[2]) < 12 ? 'AM' : 'PM' }
    : { date: '', hour: 11, minute: 59, ampm: 'PM' };
  function emit(patch) {
    const s = { ...cur, ...patch };
    if (!s.date) { onChange(''); return; }
    let h = s.hour % 12; if (s.ampm === 'PM') h += 12;
    onChange(`${s.date}T${String(h).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`);
  }
  const box = { width: 'auto' };
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <input type="date" value={cur.date} onChange={(e) => emit({ date: e.target.value })} style={box} />
      <select value={cur.hour} onChange={(e) => emit({ hour: Number(e.target.value) })} style={box}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <span>:</span>
      <select value={cur.minute} onChange={(e) => emit({ minute: Number(e.target.value) })} style={box}>
        {Array.from({ length: 60 }, (_, i) => i).map((mm) => <option key={mm} value={mm}>{String(mm).padStart(2, '0')}</option>)}
      </select>
      <select value={cur.ampm} onChange={(e) => emit({ ampm: e.target.value })} style={box}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
      {cur.date && <button type="button" className="btn ghost small" onClick={() => onChange('')}>Clear</button>}
    </div>
  );
}

// Format a datetime string for display.
export function fmtDateTime(s) {
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
