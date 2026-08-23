import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { Msg, Modal } from '../components.jsx';
import { useConfirm } from '../confirm.jsx';

export default function StudentsTab({ readOnly }) {
  const [students, setStudents] = useState(null);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ name: '', email: '', phone: '', accessUntil: '' });
  const [msg, setMsg] = useState(null); // { text, ok }
  const [selectedId, setSelectedId] = useState(null); // signup-invite id (s.id)
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
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
      {!readOnly && showAdd && (
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
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>After this date the student loses access to your organization's tests (their access to any other institutes is unaffected). Leave blank for no end date.</p>
        <div style={{ marginTop: 16 }}><button className="btn" onClick={addStudent}>Create student &amp; get link</button></div>
      </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Students in your organization</h2>
          <div className="row">
            {!readOnly && <button className="btn small" onClick={() => setShowAdd((v) => !v)}>{showAdd ? 'Close' : '➕ Create student'}</button>}
            {!readOnly && <button className="btn secondary small" onClick={() => setShowImport(true)}>⬆ Import CSV</button>}
            <a className="btn secondary small" href="/api/students/export.csv" download>⬇ Download CSV</a>
          </div>
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

      {showImport && <BulkImport onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); setQuery(''); load(''); }} />}
    </>
  );
}

// --- Bulk CSV import -------------------------------------------------------
const csvEsc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const TEMPLATE = 'data:text/csv;charset=utf-8,' + encodeURIComponent('Name,Email,Phone,Access Until\nAarav Sharma,aarav@example.com,9000000001,\nDiya Patel,diya@example.com,9000000002,2026-12-31\n');

// Minimal CSV parser that respects quoted fields.
function parseCSV(text) {
  return String(text).split(/\r?\n/).filter((l) => l.trim() !== '').map((line) => {
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  });
}

function BulkImport({ onClose, onDone }) {
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  function onFile(file) {
    if (!file) return;
    setFileName(file.name); setMsg(''); setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      let grid = parseCSV(reader.result);
      if (grid.length && grid[0].join(',').toLowerCase().includes('email')) grid = grid.slice(1); // drop header
      const parsed = grid
        .map((c) => ({ name: c[0] || '', email: c[1] || '', phone: c[2] || '', accessUntil: c[3] || '' }))
        .filter((r) => r.name || r.email || r.phone);
      if (!parsed.length) setMsg('No rows found. Expected columns: Name, Email, Phone, Access until.');
      setRows(parsed);
    };
    reader.onerror = () => setMsg('Could not read the file.');
    reader.readAsText(file);
  }

  async function submit() {
    if (!rows || !rows.length) return;
    setBusy(true); setMsg('');
    try { setResult(await api('/api/students/bulk', 'POST', { students: rows })); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  function downloadLinks() {
    const origin = window.location.origin;
    const lines = ['Name,Email,Signup Link', ...result.created.map((c) => [c.name, c.email, origin + c.signupPath].map(csvEsc).join(','))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'student-signup-links.csv'; a.click();
  }

  return (
    <Modal title="Import students from CSV" onClose={onClose} wide>
      {!result ? (
        <>
          <p className="muted">Upload a CSV with columns <b>Name, Email, Phone, Access until</b> (the last is optional; a header row is fine).</p>
          <p><a href={TEMPLATE} download="students-template.csv">⬇ Download a template</a></p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files[0])} />
          {rows && <p className="muted" style={{ marginTop: 8 }}>{fileName}: <b>{rows.length}</b> row(s) ready to import.</p>}
          {msg && <Msg text={msg} />}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" disabled={!rows || !rows.length || busy} onClick={submit}>{busy ? 'Importing…' : `Import ${rows && rows.length ? rows.length : ''} student(s)`}</button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <Msg text={`✅ ${result.created.length} student(s) added${result.skipped.length ? `, ${result.skipped.length} skipped.` : '.'}`} kind="ok" />
          {result.created.length > 0 && (
            <p><button className="btn secondary small" onClick={downloadLinks}>⬇ Download signup links (CSV)</button> <span className="muted">— send each student their link.</span></p>
          )}
          {result.skipped.length > 0 && (
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>Row</th><th>Skipped because</th></tr></thead>
              <tbody>{result.skipped.map((s, i) => <tr key={i}><td>{s.label}</td><td className="muted">{s.reason}</td></tr>)}</tbody>
            </table>
          )}
          <div className="row" style={{ marginTop: 16 }}><button className="btn" onClick={onDone}>Done</button></div>
        </>
      )}
    </Modal>
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
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { text, ok }

  async function toggle() {
    if (!s.disabled && !(await confirm({ title: `Disable ${s.name}?`, body: "They'll lose access to your tests (any other institutes they belong to are unaffected). You can re-enable them anytime.", confirmLabel: 'Disable', danger: true }))) return;
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
              <button className={s.disabled ? 'btn secondary' : 'btn danger'} onClick={toggle} disabled={busy || readOnly}>{s.disabled ? 'Enable in this org' : 'Disable in this org'}</button>
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
