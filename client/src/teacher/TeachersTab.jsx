import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg, Modal, copyText } from '../components.jsx';
import { useConfirm, useAlert } from '../confirm.jsx';

export default function TeachersTab({ readOnly }) {
  const confirm = useConfirm();
  const alert = useAlert();
  const [data, setData] = useState(null); // { teachers, canManage }
  const [form, setForm] = useState({ name: '', email: '', phone: '', role: 'teacher' });
  const [editing, setEditing] = useState(null); // teacher row being edited
  const [showAdd, setShowAdd] = useState(false);
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
    if (!t.disabled && !(await confirm({ title: `Disable ${t.name}?`, body: 'They will be logged out immediately and cannot log in until you re-enable them.', confirmLabel: 'Disable', danger: true }))) return;
    try { await api('/api/teachers/' + t.id, 'PATCH', { disabled: !t.disabled }); load(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function copy(text, btn) {
    const ok = await copyText(text);
    const prev = btn.textContent; btn.textContent = ok ? 'Copied!' : 'Press Ctrl/⌘+C';
    setTimeout(() => { btn.textContent = prev; }, ok ? 1500 : 2500);
    return ok;
  }
  async function copyReset(t, btn) {
    let link;
    try { const { resetPath } = await api('/api/teachers/' + t.id + '/reset-link', 'POST'); link = window.location.origin + resetPath; }
    catch (e) { setMsg({ ok: false, text: e.message }); return; }
    const ok = await copy(link, btn);
    // Always surface the link so a blocked clipboard never hides it.
    setMsg({ ok: true, text: `${ok ? 'Reset link copied' : 'Copy the reset link below'} for ${t.name} (expires in 1 hour): ${link}` });
  }

  if (!data) return <div className="card"><p className="muted">Loading…</p></div>;
  const canManage = data.canManage;

  return (
    <>
      {canManage && !readOnly && showAdd && (
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
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>All teachers</h2>
          {canManage && !readOnly && <button className="btn small" onClick={() => setShowAdd((v) => !v)}>{showAdd ? 'Close' : '➕ Add teacher'}</button>}
        </div>
        <div style={{ marginTop: 12 }} />
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
                        {canManage && !readOnly && (
                          <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => setEditing(t)}>Edit</button>
                        )}
                      </>
                    ) : (
                      <>
                        {t.disabled ? <span className="pill gray">disabled</span> : <span className="pill green">active</span>}
                        {canManage && !readOnly && (
                          <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => setEditing(t)}>Edit</button>
                        )}
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

      {editing && <EditTeacherModal teacher={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
}

const tokenFromPath = (p) => { try { return new URLSearchParams((p || '').split('?')[1]).get('token'); } catch { return null; } };

function EditTeacherModal({ teacher, onClose, onSaved }) {
  const [name, setName] = useState(teacher.name);
  const [phone, setPhone] = useState(teacher.phone || '');
  const [role, setRole] = useState(teacher.isRoot ? 'root' : 'teacher');
  const [msg, setMsg] = useState('');
  async function save() {
    try {
      const body = { name, phone, isRoot: role === 'root' };
      if (teacher.signedUp) await api('/api/teachers/' + teacher.id, 'PUT', body);
      else await api('/api/teacher-invites/' + tokenFromPath(teacher.signupPath), 'PUT', body);
      onSaved();
    } catch (e) { setMsg(e.message); }
  }
  return (
    <Modal title={teacher.signedUp ? 'Edit teacher' : 'Edit invited teacher'} onClose={onClose}>
      <Msg text={msg} />
      <label>Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      <label>Email (cannot be changed)</label><input type="email" value={teacher.email} disabled />
      <label>Phone number</label><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. +91 98765 43210" />
      <label>Role</label>
      <select value={role} onChange={(e) => setRole(e.target.value)} disabled={teacher.isSelf}>
        <option value="teacher">Teacher (create/assign/edit tests)</option>
        <option value="root">Root teacher (also manages teachers)</option>
      </select>
      {teacher.isSelf && <p className="muted" style={{ fontSize: 13 }}>You can't change your own role.</p>}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn" onClick={save}>Save changes</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
