import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { Msg, Modal } from '../components.jsx';

export default function StudentsTab() {
  const [students, setStudents] = useState(null);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ name: '', email: '', phone: '', accessUntil: '' });
  const [msg, setMsg] = useState(null); // { text, ok }
  const [editing, setEditing] = useState(null);
  const timer = useRef(null);

  const load = (q = query) => api('/api/students' + (q ? '?q=' + encodeURIComponent(q) : '')).then((d) => setStudents(d.students));
  useEffect(() => { load(''); }, []);

  function onSearch(v) { setQuery(v); clearTimeout(timer.current); timer.current = setTimeout(() => load(v), 250); }

  async function addStudent() {
    try {
      await api('/api/students', 'POST', form);
      setForm({ name: '', email: '', phone: '', accessUntil: '' });
      setQuery('');
      setMsg({ text: 'Student created! Use the "Copy link" button in the table to share their signup link.', ok: true });
      load('');
    } catch (e) { setMsg({ text: e.message, ok: false }); }
  }

  async function toggle(s) {
    if (!s.disabled && !window.confirm(`Disable ${s.name}? They will be logged out immediately and cannot log in until re-enabled.`)) return;
    await api('/api/students/' + s.studentId, 'PATCH', { disabled: !s.disabled });
    load();
  }
  async function copyLink(text, btn) {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent; btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }
  async function copyReset(s, btn) {
    try { const { resetPath } = await api('/api/students/' + s.studentId + '/reset-link', 'POST'); await copyLink(window.location.origin + resetPath, btn); }
    catch (e) { alert(e.message); }
  }

  return (
    <>
      <div className="card">
        <h1>Add a student</h1>
        <p className="muted">Create a student, then copy their unique signup link and send it to them.</p>
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
            <thead><tr><th>Name</th><th>Email</th><th>Mobile number</th><th>Access until</th><th>Signup link</th><th>Status</th></tr></thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.email}</td>
                  <td>{s.phone || <span className="muted">—</span>}</td>
                  <td>{s.accessUntil ? <span style={{ color: s.expired ? 'var(--red)' : undefined }}>{s.accessUntil}</span> : <span className="muted">—</span>}</td>
                  <td>
                    {!s.signedUp
                      ? <button className="btn secondary small" onClick={(e) => copyLink(window.location.origin + s.signupPath, e.target)}>Copy link</button>
                      : <span className="muted">—</span>}
                  </td>
                  <td>
                    {!s.signedUp ? <span className="pill amber">invite pending</span> : (
                      <>
                        {s.disabled ? <span className="pill gray">disabled</span> : s.expired ? <span className="pill gray">expired</span> : <span className="pill green">active</span>}
                        <button className={`btn ${s.disabled ? 'secondary' : 'danger'} small`} style={{ marginLeft: 8 }} onClick={() => toggle(s)}>{s.disabled ? 'Enable' : 'Disable'}</button>
                        <button className="btn secondary small" style={{ marginLeft: 8 }} onClick={(e) => copyReset(s, e.target)}>Reset link</button>
                      </>
                    )}
                    <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => setEditing(s)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && <EditStudentModal student={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
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
