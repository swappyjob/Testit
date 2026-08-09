import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg } from '../components.jsx';

export default function TeachersTab({ readOnly }) {
  const [data, setData] = useState(null); // { teachers, canManage }
  const [form, setForm] = useState({ name: '', email: '', phone: '', role: 'teacher' });
  const [msg, setMsg] = useState(null);

  const load = () => api('/api/teachers').then(setData);
  useEffect(() => { load(); }, []);

  async function addTeacher() {
    try {
      await api('/api/teachers', 'POST', { name: form.name, email: form.email, phone: form.phone, isRoot: form.role === 'root' });
      setForm({ name: '', email: '', phone: '', role: 'teacher' });
      setMsg({ ok: true, text: 'Teacher created! Use the "Copy link" button below to share their signup link.' });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function toggle(t) {
    if (!t.disabled && !window.confirm(`Disable ${t.name}? They will be logged out immediately and cannot log in until you re-enable them.`)) return;
    try { await api('/api/teachers/' + t.id, 'PATCH', { disabled: !t.disabled }); load(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function copy(text, btn) {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent; btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }
  async function copyReset(t, btn) {
    try { const { resetPath } = await api('/api/teachers/' + t.id + '/reset-link', 'POST'); await copy(window.location.origin + resetPath, btn); }
    catch (e) { alert(e.message); }
  }

  if (!data) return <div className="card"><p className="muted">Loading…</p></div>;
  const canManage = data.canManage;

  return (
    <>
      {canManage && !readOnly && (
        <div className="card">
          <h1>Add a teacher</h1>
          <p className="muted">Invite another teacher and choose their role. Root teachers can add more teachers; normal teachers cannot.</p>
          {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
          <div className="grid two">
            <div><label>Teacher name</label><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label>Teacher email</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div><label>Phone number</label><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="e.g. +91 98765 43210" /></div>
            <div>
              <label>Role</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="teacher">Teacher (create/assign/edit tests)</option>
                <option value="root">Root teacher (also manages teachers)</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 16 }}><button className="btn" onClick={addTeacher}>Create teacher &amp; get link</button></div>
        </div>
      )}

      <div className="card">
        <h2>All teachers</h2>
        {data.teachers.length === 0 ? <p className="muted">No teachers yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Mobile number</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {data.teachers.map((t, i) => (
                <tr key={t.id ?? 'p' + i}>
                  <td>{t.name}{t.isSelf && <span className="muted"> (you)</span>}</td>
                  <td>{t.email}</td>
                  <td>{t.phone || <span className="muted">—</span>}</td>
                  <td>{t.isRoot ? <span className="pill brand">Root teacher</span> : <span className="pill gray">Teacher</span>}</td>
                  <td>
                    {!t.signedUp ? (
                      <>
                        <span className="pill amber">invite pending</span>{' '}
                        <button className="btn secondary small" style={{ marginLeft: 6 }} onClick={(e) => copy(window.location.origin + t.signupPath, e.target)}>Copy link</button>
                      </>
                    ) : (
                      <>
                        {t.disabled ? <span className="pill gray">disabled</span> : <span className="pill green">active</span>}
                        {canManage && !readOnly && !t.isSelf && (
                          <>
                            <button className={`btn ${t.disabled ? 'secondary' : 'danger'} small`} style={{ marginLeft: 8 }} onClick={() => toggle(t)}>{t.disabled ? 'Enable' : 'Disable'}</button>
                            <button className="btn secondary small" style={{ marginLeft: 8 }} onClick={(e) => copyReset(t, e.target)}>Reset link</button>
                          </>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
