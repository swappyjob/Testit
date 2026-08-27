import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Modal, Msg, PasswordInput } from '../components.jsx';
import { useConfirm } from '../confirm.jsx';

export const fmtPrice = (p) =>
  p.price_monthly > 0 ? '₹' + p.price_monthly.toLocaleString('en-IN') + '/mo' : p.max_students == null ? 'Custom' : 'Free';
export const fmtCap = (p) => (p.max_students == null ? 'Unlimited students' : `up to ${p.max_students} students`);

export default function AdminDashboard() {
  const me = useRequireRole('admin', '/admin-login');
  const [orgs, setOrgs] = useState(null);
  const [plans, setPlans] = useState([]);
  const [query, setQuery] = useState('');
  const [newOrg, setNewOrg] = useState('');
  const [msg, setMsg] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState(null);
  const timer = useRef(null);

  const load = (q = query) => api('/api/orgs' + (q ? '?q=' + encodeURIComponent(q) : '')).then((d) => setOrgs(d.orgs));
  const loadPlans = () => api('/api/plans').then((d) => setPlans(d.plans));
  useEffect(() => { if (me) { load(''); loadPlans(); } }, [me]);

  function onSearch(v) { setQuery(v); clearTimeout(timer.current); timer.current = setTimeout(() => load(v), 250); }
  async function createOrg() {
    if (!newOrg.trim()) { setMsg({ ok: false, text: 'Enter an organization name.' }); return; }
    try { await api('/api/orgs', 'POST', { name: newOrg.trim() }); setNewOrg(''); setQuery(''); setMsg({ ok: true, text: 'Organization created.' }); load(''); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  if (!me) return null;

  return (
    <>
      <DashboardBar who={me.name + ' · Admin'}>
        <button className="btn ghost small" onClick={() => setShowProfile(true)}>⚙ Profile</button>
      </DashboardBar>
      <div className="container">
        <div className="card">
          <h1>Organizations</h1>
          <p className="muted">Create organizations, then add a root teacher to each. Root teachers manage their own teachers and students.</p>
          {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}><label>New organization name</label><input type="text" value={newOrg} onChange={(e) => setNewOrg(e.target.value)} placeholder="e.g. Springfield High" /></div>
            <button className="btn" onClick={createOrg}>Create organization</button>
          </div>
          <input type="text" value={query} onChange={(e) => onSearch(e.target.value)} placeholder="🔍 Search organizations by name..." style={{ marginTop: 14 }} />
        </div>

        <AdminsCard />

        <SupportAgentsCard />

        <PlansCard plans={plans} onChanged={() => { loadPlans(); load(query); }} />

        {orgs === null ? (
          <div className="card"><p className="muted">Loading…</p></div>
        ) : orgs.length === 0 ? (
          <div className="card"><p className="muted">{query ? `No organizations match “${query}”.` : 'No organizations yet. Create one above.'}</p></div>
        ) : (
          orgs.map((o) => <OrgCard key={o.id} org={o} plans={plans} onChanged={() => load(query)} onEditTeacher={setEditingTeacher} />)
        )}
      </div>

      {editingTeacher && <EditTeacherModal teacher={editingTeacher} onClose={() => setEditingTeacher(null)} onSaved={() => { setEditingTeacher(null); load(query); }} />}
      {showProfile && <ProfileModal me={me} onClose={() => setShowProfile(false)} />}
    </>
  );
}

// Platform admins: list and create additional admins.
function AdminsCard() {
  const [admins, setAdmins] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [msg, setMsg] = useState(null);
  const load = () => api('/api/admins').then((d) => setAdmins(d.admins)).catch(() => {});
  useEffect(() => { load(); }, []);
  async function addAdmin() {
    try {
      await api('/api/admins', 'POST', form);
      setForm({ name: '', email: '', password: '' });
      setMsg({ ok: true, text: 'Administrator created. They can log in at the admin login with this email and password.' });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  return (
    <div className="card">
      <h2>Administrators</h2>
      <p className="muted">Platform admins manage every organization. Add another admin here.</p>
      {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
      {admins && admins.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Email</th></tr></thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.id}><td>{a.name}{a.isSelf && <span className="muted"> (you)</span>}</td><td>{a.email}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="grid two" style={{ marginTop: 14 }}>
        <div><label>Name</label><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><label>Email</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label>Temporary password (min 6 characters)</label><PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
      </div>
      <div style={{ marginTop: 14 }}><button className="btn" onClick={addAdmin}>Create administrator</button></div>
    </div>
  );
}

// Platform admins create + list the support team (a separate role that only
// works the ticket queue — no org/plan powers).
function SupportAgentsCard() {
  const [agents, setAgents] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [msg, setMsg] = useState(null);
  const load = () => api('/api/support-agents').then((d) => setAgents(d.agents)).catch(() => {});
  useEffect(() => { load(); }, []);
  async function add() {
    try {
      await api('/api/support-agents', 'POST', form);
      setForm({ name: '', email: '', password: '' });
      setMsg({ ok: true, text: 'Support agent created. They log in at /support-login.' });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  return (
    <div className="card">
      <h2>Support team</h2>
      <p className="muted">Support agents work the ticket queue at <b>/support-login</b>. They can't manage organizations or plans.</p>
      {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
      {agents && agents.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Email</th></tr></thead>
          <tbody>{agents.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.email}</td></tr>)}</tbody>
        </table>
      )}
      <div className="grid two" style={{ marginTop: 14 }}>
        <div><label>Name</label><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><label>Email</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label>Temporary password (min 6 characters)</label><PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
      </div>
      <div style={{ marginTop: 14 }}><button className="btn" onClick={add}>Create support agent</button></div>
    </div>
  );
}

// Manage the pricing-plan catalog: create, edit, delete plans.
function PlansCard({ plans, onChanged }) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null); // plan object, or { isNew: true }
  const [msg, setMsg] = useState(null);

  async function del(p) {
    if (!(await confirm({ title: `Delete the ${p.name} plan?`, body: 'This removes the plan from the catalog. Organizations must be reassigned first.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api('/api/plans/' + p.id, 'DELETE'); setMsg(null); onChanged(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Pricing plans</h2>
        <button className="btn small" onClick={() => setEditing({ isNew: true })}>➕ Add plan</button>
      </div>
      <p className="muted">Priced by number of students. These are the plans an admin can assign to each organization below.</p>
      {msg && <Msg text={msg.text} kind="error" />}
      {plans.length === 0 ? (
        <p className="muted">No plans yet. Click <b>Add plan</b> to create one.</p>
      ) : (
        <table>
          <thead><tr><th>Plan</th><th>Students</th><th>Price</th><th>In use</th><th></th></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b></td>
                <td>{p.max_students == null ? 'Unlimited' : `up to ${p.max_students}`}</td>
                <td>{fmtPrice(p)}</td>
                <td>{p.org_count > 0 ? `${p.org_count} org${p.org_count === 1 ? '' : 's'}` : '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn secondary small" onClick={() => setEditing(p)}>Edit</button>{' '}
                  <button className="btn danger small" disabled={p.org_count > 0} title={p.org_count > 0 ? 'Reassign its organizations first' : undefined} onClick={() => del(p)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <PlanEditor plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
    </div>
  );
}

// Create / edit a single plan.
function PlanEditor({ plan, onClose, onSaved }) {
  const isNew = !!plan.isNew;
  const [name, setName] = useState(plan.name || '');
  const [unlimited, setUnlimited] = useState(plan.max_students == null && !isNew);
  const [maxStudents, setMaxStudents] = useState(plan.max_students != null ? String(plan.max_students) : '');
  const [priceMonthly, setPriceMonthly] = useState(plan.price_monthly != null ? String(plan.price_monthly) : '0');
  const [sortOrder, setSortOrder] = useState(plan.sort_order != null ? String(plan.sort_order) : '');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setMsg(null);
    const body = { name, unlimited, maxStudents: Number(maxStudents), priceMonthly: Number(priceMonthly), sortOrder: Number(sortOrder) || 0 };
    try {
      if (isNew) await api('/api/plans', 'POST', body);
      else await api('/api/plans/' + plan.id, 'PUT', body);
      onSaved();
    } catch (e) { setMsg({ ok: false, text: e.message }); setBusy(false); }
  }

  return (
    <Modal title={isNew ? 'Add plan' : `Edit ${plan.name}`} onClose={onClose}>
      {msg && <Msg text={msg.text} kind="error" />}
      <label>Plan name</label>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard" />
      <label>Price (₹ per month)</label>
      <input type="number" min="0" step="1" value={priceMonthly} onChange={(e) => setPriceMonthly(e.target.value)} placeholder="0 = Free" style={{ width: 200 }} />
      <label className="choice" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
        Unlimited students (custom / enterprise plan)
      </label>
      {!unlimited && (
        <>
          <label>Student cap</label>
          <input type="number" min="1" step="1" value={maxStudents} onChange={(e) => setMaxStudents(e.target.value)} placeholder="e.g. 100" style={{ width: 200 }} />
        </>
      )}
      <label>Display order (lower shows first)</label>
      <input type="number" step="1" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} placeholder="e.g. 2" style={{ width: 200 }} />
      <div className="row" style={{ marginTop: 18, gap: 10 }}>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : isNew ? 'Create plan' : 'Save changes'}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function OrgCard({ org, plans, onChanged, onEditTeacher }) {
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(org.name);
  const [subUntil, setSubUntil] = useState(org.subscriptionUntil || '');
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [msg, setMsg] = useState(null);

  async function saveRename() {
    try { await api('/api/orgs/' + org.id, 'PUT', { name }); setRenaming(false); onChanged(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function changePlan(planId) {
    try { await api('/api/orgs/' + org.id + '/plan', 'PUT', { planId: Number(planId) }); onChanged(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function saveSubscription(value) {
    try {
      await api('/api/orgs/' + org.id + '/subscription', 'PUT', { expiresAt: value });
      setMsg({ ok: true, text: value ? `Subscription set to expire on ${value}.` : 'Subscription expiry cleared (no expiry).' });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  const overLimit = org.maxStudents != null && org.studentCount > org.maxStudents;
  async function addRoot() {
    try {
      await api('/api/admin/root-teachers', 'POST', { orgId: org.id, ...form });
      setForm({ name: '', email: '', phone: '' });
      setMsg({ ok: true, text: 'Root teacher created. Copy their signup link from the table above.' });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function toggle(t) {
    if (!t.disabled && !(await confirm({ title: `Disable ${t.name}?`, body: 'They will be logged out immediately and cannot log in until you re-enable them.', confirmLabel: 'Disable', danger: true }))) return;
    try { await api('/api/admin/teachers/' + t.id, 'PATCH', { disabled: !t.disabled }); onChanged(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function copy(text, btn) {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent; btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }
  async function copyReset(t, btn) {
    try {
      const { resetPath } = await api('/api/admin/teachers/' + t.id + '/reset-link', 'POST');
      await copy(window.location.origin + resetPath, btn);
      setMsg({ ok: true, text: `Reset link for ${t.name} copied — send it to them. It expires in 1 hour.` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        {renaming ? (
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 'auto' }} />
            <button className="btn small" onClick={saveRename}>Save</button>
            <button className="btn ghost small" onClick={() => { setName(org.name); setRenaming(false); }}>Cancel</button>
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <h2 style={{ margin: 0 }}>{org.name}</h2>
            <button className="btn ghost small" onClick={() => setRenaming(true)}>Rename</button>
          </div>
        )}
        <span className="muted">{org.teacherCount} teacher(s)</span>
      </div>
      {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}

      <div className="row" style={{ alignItems: 'center', gap: 10, marginTop: 10 }}>
        <label style={{ margin: 0 }}>Plan:</label>
        <select value={org.planId || ''} onChange={(e) => changePlan(e.target.value)} style={{ width: 'auto' }}>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {fmtPrice(p)} ({fmtCap(p)})</option>)}
        </select>
        <span className="muted">
          {org.studentCount}{org.maxStudents != null ? ' / ' + org.maxStudents : ''} students used
        </span>
        {overLimit && <span className="pill amber">over limit — upgrade</span>}
      </div>

      <div className="row" style={{ alignItems: 'center', gap: 10, marginTop: 10 }}>
        <label style={{ margin: 0 }}>Subscription until:</label>
        <input type="date" value={subUntil} onChange={(e) => setSubUntil(e.target.value)} style={{ width: 'auto' }} />
        <button className="btn secondary small" onClick={() => saveSubscription(subUntil)}>Save</button>
        {org.subscriptionUntil
          ? (org.subscriptionExpired
              ? <span className="pill amber">expired — read-only</span>
              : <span className="pill green">active until {org.subscriptionUntil}</span>)
          : <span className="pill gray">no expiry</span>}
        {org.subscriptionUntil && (
          <button className="btn ghost small" onClick={() => { setSubUntil(''); saveSubscription(''); }}>Clear</button>
        )}
      </div>

      <h3 style={{ marginTop: 14 }}>Teachers</h3>
      {org.teachers.length === 0 ? <p className="muted">No teachers yet.</p> : (
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>
            {org.teachers.map((t, i) => (
              <tr key={t.id ?? 'p' + i}>
                <td>{t.name}</td>
                <td>{t.email}</td>
                <td>{t.phone || <span className="muted">—</span>}</td>
                <td>{t.isRoot ? <span className="pill brand">Root</span> : <span className="pill gray">Teacher</span>}</td>
                <td>
                  {!t.signedUp ? (
                    <>
                      <span className="pill amber">invite pending</span>{' '}
                      <button className="btn secondary small" onClick={(e) => copy(window.location.origin + t.signupPath, e.target)}>Copy link</button>
                    </>
                  ) : (
                    <>
                      {t.disabled ? <span className="pill gray">disabled</span> : <span className="pill green">active</span>}
                      <button className={`btn ${t.disabled ? 'secondary' : 'danger'} small`} style={{ marginLeft: 8 }} onClick={() => toggle(t)}>{t.disabled ? 'Enable' : 'Disable'}</button>
                      <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => onEditTeacher(t)}>Edit</button>
                      <button className="btn secondary small" style={{ marginLeft: 8 }} onClick={(e) => copyReset(t, e.target)}>Reset link</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 16 }}>Add root teacher</h3>
      <div className="grid two">
        <div><label>Name</label><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><label>Email</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label>Phone number</label><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="e.g. +91 98765 43210" /></div>
      </div>
      <div style={{ marginTop: 12 }}><button className="btn secondary" onClick={addRoot}>Create root teacher &amp; get link</button></div>
    </div>
  );
}

function EditTeacherModal({ teacher, onClose, onSaved }) {
  const [name, setName] = useState(teacher.name);
  const [phone, setPhone] = useState(teacher.phone || '');
  const [role, setRole] = useState(teacher.isRoot ? 'root' : 'teacher');
  const [msg, setMsg] = useState('');
  async function save() {
    try { await api('/api/admin/teachers/' + teacher.id, 'PUT', { name, phone, isRoot: role === 'root' }); onSaved(); }
    catch (e) { setMsg(e.message); }
  }
  return (
    <Modal title="Edit teacher" onClose={onClose}>
      <Msg text={msg} />
      <label>Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      <label>Email (cannot be changed)</label><input type="email" value={teacher.email} disabled />
      <label>Phone number</label><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <label>Role</label>
      <select value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="teacher">Teacher</option>
        <option value="root">Root teacher</option>
      </select>
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn" onClick={save}>Save changes</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function ProfileModal({ me, onClose }) {
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (nw !== confirm) { setMsg({ ok: false, text: 'The new passwords do not match.' }); return; }
    try {
      await api('/api/change-password', 'POST', { currentPassword: cur, newPassword: nw });
      setMsg({ ok: true, text: 'Password updated successfully! Other devices have been logged out.' });
      setCur(''); setNw(''); setConfirm('');
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  return (
    <Modal title="Profile" onClose={onClose}>
      <p className="muted">{me.name} · {me.email}</p>
      {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
      <h3 style={{ marginTop: 16 }}>Change password</h3>
      <form onSubmit={submit}>
        <label>Current password</label>
        <PasswordInput value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" />
        <label>New password (min 6 characters)</label>
        <PasswordInput value={nw} onChange={(e) => setNw(e.target.value)} required autoComplete="new-password" />
        <label>Confirm new password</label>
        <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn" type="submit">Update password</button>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
