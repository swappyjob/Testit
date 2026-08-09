import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { Msg, Modal } from '../components.jsx';

export default function StudentsTab({ readOnly }) {
  const [students, setStudents] = useState(null);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ name: '', email: '', phone: '', accessUntil: '' });
  const [msg, setMsg] = useState(null); // { text, ok }
  const [selectedId, setSelectedId] = useState(null); // signup-invite id (s.id)
  const timer = useRef(null);

  const load = (q = query) => api('/api/students' + (q ? '?q=' + encodeURIComponent(q) : '')).then((d) => setStudents(d.students));
  useEffect(() => { load(''); }, []);

  function onSearch(v) { setQuery(v); clearTimeout(timer.current); timer.current = setTimeout(() => load(v), 250); }

  async function addStudent() {
    try {
      await api('/api/students', 'POST', form);
      setForm({ name: '', email: '', phone: '', accessUntil: '' });
      setQuery('');
      setMsg({ text: 'Student created! Click the student to open their page and copy the signup link.', ok: true });
      load('');
    } catch (e) { setMsg({ text: e.message, ok: false }); }
  }

  const selected = selectedId != null && students ? students.find((s) => s.id === selectedId) : null;
  // If the selected student vanished (e.g. after a search), drop back to the list.
  useEffect(() => { if (selectedId != null && students && !selected) setSelectedId(null); }, [students]);

  if (selected) {
    return <StudentDetail student={selected} readOnly={readOnly} onBack={() => setSelectedId(null)} onChanged={() => load()} />;
  }

  return (
    <>
      {!readOnly && (
      <div className="card">
        <h1>Add a student</h1>
        <p className="muted">Create a student, then open their page to copy their unique signup link and send it to them.</p>
        {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
        <div className="grid two">
          <div><label>Student name</label><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Student email</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label>Phone number</label><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="e.g. +91 98765 43210" /></div>
          <div><label>Access until (optional)</label><input type="date" value={form.accessUntil} onChange={(e) => setForm({ ...form, accessUntil: e.target.value })} /></div>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>After this date the student is automatically disabled and can no longer log in. Leave blank for no end date.</p>
        <div style={{ marginTop: 16 }}><button className="btn" onClick={addStudent}>Create student &amp; get link</button></div>
      </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Students in your organization</h2>
          <a className="btn secondary small" href="/api/students/export.csv" download>⬇ Download CSV</a>
        </div>
        <input type="text" value={query} onChange={(e) => onSearch(e.target.value)} placeholder="🔍 Search by name or email..." style={{ margin: '14px 0' }} />
        {students === null ? <p className="muted">Loading…</p> : students.length === 0 ? (
          <p className="muted">{query ? `No students match “${query}”.` : 'No students yet.'}</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Mobile number</th><th>Access until</th><th>Status</th></tr></thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(s.id)}>
                  <td><a href="#" onClick={(e) => e.preventDefault()} style={{ fontWeight: 600 }}>{s.name}</a></td>
                  <td>{s.email}</td>
                  <td>{s.phone || <span className="muted">—</span>}</td>
                  <td>{s.accessUntil ? <span style={{ color: s.expired ? 'var(--red)' : undefined }}>{s.accessUntil}</span> : <span className="muted">—</span>}</td>
                  <td><StatusPill s={s} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function StatusPill({ s }) {
  if (!s.signedUp) return <span className="pill amber">invite pending</span>;
  if (s.disabled) return <span className="pill gray">disabled</span>;
  if (s.expired) return <span className="pill gray">expired</span>;
  return <span className="pill green">active</span>;
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 15 }}>{children}</div>
    </div>
  );
}

function StudentDetail({ student: s, onBack, onChanged, readOnly }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { text, ok }

  async function toggle() {
    if (!s.disabled && !window.confirm(`Disable ${s.name}? They will be logged out immediately and cannot log in until re-enabled.`)) return;
    setBusy(true);
    try { await api('/api/students/' + s.studentId, 'PATCH', { disabled: !s.disabled }); await onChanged(); }
    catch (e) { setMsg({ text: e.message, ok: false }); } finally { setBusy(false); }
  }
  async function copyResetLink(btn) {
    try { const { resetPath } = await api('/api/students/' + s.studentId + '/reset-link', 'POST'); await copyToClipboard(window.location.origin + resetPath, btn); }
    catch (e) { setMsg({ text: e.message, ok: false }); }
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0 }}>{s.name}</h1>
          <button className="btn ghost small" onClick={onBack}>← Back to students</button>
        </div>
        {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}

        <div className="grid two" style={{ marginTop: 16 }}>
          <Field label="Email">{s.email}</Field>
          <Field label="Mobile number">{s.phone || '—'}</Field>
          <Field label="Access until">{s.accessUntil ? <span style={{ color: s.expired ? 'var(--red)' : undefined }}>{s.accessUntil}{s.expired ? ' (expired)' : ''}</span> : 'No end date'}</Field>
          <Field label="Status"><StatusPill s={s} /></Field>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          {!s.signedUp ? (
            <button className="btn secondary" onClick={(e) => copyToClipboard(window.location.origin + s.signupPath, e.target)}>Copy signup link</button>
          ) : (
            <>
              <button className="btn secondary" onClick={() => setEditing(true)} disabled={busy || readOnly}>Edit</button>
              <button className={s.disabled ? 'btn secondary' : 'btn danger'} onClick={toggle} disabled={busy || readOnly}>{s.disabled ? 'Enable account' : 'Disable account'}</button>
              <button className="btn secondary" onClick={(e) => copyResetLink(e.target)} disabled={busy || readOnly}>Copy password-reset link</button>
            </>
          )}
        </div>
        {!s.signedUp && (
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>This student hasn't signed up yet. Share the signup link so they can set their password.</p>
        )}
      </div>

      {editing && <EditStudentModal student={s} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await onChanged(); }} />}
    </>
  );
}

async function copyToClipboard(text, btn) {
  await navigator.clipboard.writeText(text);
  const prev = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = prev; }, 1500);
}

function EditStudentModal({ student, onClose, onSaved }) {
  const [name, setName] = useState(student.name);
  const [phone, setPhone] = useState(student.phone || '');
  const [accessUntil, setAccessUntil] = useState(student.accessUntil || '');
  const [msg, setMsg] = useState('');
  async function save() {
    try { await api('/api/students/' + student.id, 'PUT', { name, phone, accessUntil }); onSaved(); }
    catch (e) { setMsg(e.message); }
  }
  return (
    <Modal title="Edit student" onClose={onClose}>
      <Msg text={msg} />
      <label>Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      <label>Email (cannot be changed)</label><input type="email" value={student.email} disabled />
      <label>Phone number</label><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <label>Access until (optional)</label><input type="date" value={accessUntil} onChange={(e) => setAccessUntil(e.target.value)} />
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn" onClick={save}>Save changes</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
