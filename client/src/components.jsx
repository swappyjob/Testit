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
      <Link className="brand" to="#" onClick={(e) => e.preventDefault()}>📝 Test<span>Platform</span></Link>
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

// Modal overlay; closes on backdrop click or the ✕ button.
export function Modal({ title, onClose, children }) {
  const backdrop = useRef(null);
  return (
    <div className="modal-overlay" ref={backdrop}
      onClick={(e) => { if (e.target === backdrop.current) onClose(); }}>
      <div className="modal">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Copy text to the clipboard, flashing a label on a button.
export function useCopyButton() {
  return async (text, btn) => {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  };
}

// Format a datetime string for display.
export function fmtDateTime(s) {
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
