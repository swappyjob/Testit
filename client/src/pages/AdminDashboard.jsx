import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Modal, Msg, PasswordInput, copyText } from '../components.jsx';
import { useConfirm } from '../confirm.jsx';

export const fmtPrice = (p) =>
  p.price_monthly > 0 ? '₹' + p.price_monthly.toLocaleString('en-IN') + '/mo' : p.max_students == null ? 'Custom' : 'Free';
export const fmtCap = (p) => (p.max_students == null ? 'Unlimited students' : `up to ${p.max_students} students`);

export default function AdminDashboard() {
  const me = useRequireRole('admin', '/admin-login');
  const [plans, setPlans] = useState([]);
  const [showProfile, setShowProfile] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState(null);
  const [tab, setTab] = useState('orgs');
  const orgTabRef = useRef(null);

  const loadPlans = () => api('/api/plans').then((d) => setPlans(d.plans));
  useEffect(() => { if (me) loadPlans(); }, [me]);
  if (!me) return null;

  const Tab = ({ id, label, icon }) => (
    <button className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
      <span aria-hidden="true">{icon}</span> {label}
    </button>
  );

  return (
    <>
      <DashboardBar who={me.name + ' · Admin'}>
        <button className="btn ghost small" onClick={() => setShowProfile(true)}>⚙ Profile</button>
      </DashboardBar>
      <div className="container">
        <div className="tabs">
          <Tab id="orgs" label="Organizations" icon="🏢" />
          <Tab id="plans" label="Plans" icon="💳" />
          <Tab id="admins" label="Admins" icon="🛡️" />
          <Tab id="support" label="Support" icon="🎫" />
        </div>

        {tab === 'orgs' && <OrganizationsTab ref={orgTabRef} plans={plans} onEditTeacher={setEditingTeacher} />}
        {tab === 'plans' && <PlansCard plans={plans} onChanged={loadPlans} />}
        {tab === 'admins' && <AdminsCard />}
        {tab === 'support' && <SupportAgentsCard />}
      </div>

      {editingTeacher && <EditTeacherModal teacher={editingTeacher} onClose={() => setEditingTeacher(null)} onSaved={() => { setEditingTeacher(null); orgTabRef.current && orgTabRef.current.refresh(); }} />}
      {showProfile && <ProfileModal me={me} onClose={() => setShowProfile(false)} />}
    </>
  );
}

// Organizations: a searchable, filterable, paginated grid. Clicking a row opens
// that organization's detail/management view.
const OrganizationsTab = forwardRef(function OrganizationsTab({ plans, onEditTeacher }, ref) {
  const [q, setQ] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState(null); // { orgs, total, page, pageSize }
  const [selectedId, setSelectedId] = useState(null);
  const [newOrg, setNewOrg] = useState('');
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);

  const load = () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (planFilter) params.set('plan', planFilter);
    if (statusFilter) params.set('status', statusFilter);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    return api('/api/orgs?' + params.toString()).then(setData).catch(() => setData({ orgs: [], total: 0, page: 1, pageSize }));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [planFilter, statusFilter, page, pageSize]);
  useEffect(() => { clearTimeout(timer.current); timer.current = setTimeout(() => { setPage(1); load(); }, 250); return () => clearTimeout(timer.current); /* eslint-disable-next-line */ }, [q]);
  useImperativeHandle(ref, () => ({ refresh: load }), [q, planFilter, statusFilter, page, pageSize]);

  async function createOrg() {
    if (!newOrg.trim()) { setMsg({ ok: false, text: 'Enter an organization name.' }); return; }
    try { await api('/api/orgs', 'POST', { name: newOrg.trim() }); setNewOrg(''); setQ(''); setPage(1); setMsg({ ok: true, text: 'Organization created.' }); load(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }

  if (selectedId) {
    return <OrgDetail id={selectedId} plans={plans} onEditTeacher={onEditTeacher} onBack={() => { setSelectedId(null); load(); }} />;
  }

  const orgs = data ? data.orgs : [];
  const total = data ? data.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const filtering = !!(q.trim() || planFilter || statusFilter);

  return (
    <>
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Organizations</h1>
        <p className="muted">Create organizations, then add a root teacher to each. Click a row to manage an organization.</p>
        {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}><label>New organization name</label><input type="text" value={newOrg} onChange={(e) => setNewOrg(e.target.value)} placeholder="e.g. Springfield High"
            onKeyDown={(e) => { if (e.key === 'Enter') createOrg(); }} /></div>
          <button className="btn" onClick={createOrg}>Create organization</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '2 1 240px' }}>
            <label>Search</label>
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Search by organization name..." />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label>Plan</label>
            <select value={planFilter} onChange={(e) => { setPage(1); setPlanFilter(e.target.value); }}>
              <option value="">All plans</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label>Subscription</label>
            <select value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }}>
              <option value="">Any status</option>
              <option value="active">Active (has expiry)</option>
              <option value="expired">Expired</option>
              <option value="no_expiry">No expiry</option>
              <option value="over_limit">Over student limit</option>
            </select>
          </div>
          {filtering && <button className="btn ghost small" onClick={() => { setQ(''); setPlanFilter(''); setStatusFilter(''); setPage(1); }}>Clear filters</button>}
        </div>

        {data === null ? (
          <p className="muted" style={{ marginTop: 16 }}>Loading…</p>
        ) : orgs.length === 0 ? (
          <p className="muted" style={{ marginTop: 16 }}>{filtering ? 'No organizations match your search / filters.' : 'No organizations yet. Create one above.'}</p>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table>
              <thead><tr><th>Organization</th><th>Plan</th><th>Teachers</th><th>Students</th><th>Subscription</th></tr></thead>
              <tbody>
                {orgs.map((o) => {
                  const over = o.maxStudents != null && o.studentCount > o.maxStudents;
                  return (
                    <tr key={o.id} onClick={() => setSelectedId(o.id)} style={{ cursor: 'pointer' }} title="Open organization">
                      <td><b>{o.name}</b></td>
                      <td>{o.planName ? <span className="pill brand">{o.planName}</span> : <span className="muted">—</span>}</td>
                      <td>{o.teacherCount}</td>
                      <td style={{ color: over ? 'var(--red)' : undefined }}>{o.studentCount}{o.maxStudents != null ? ' / ' + o.maxStudents : ''}{over ? ' ⚠' : ''}</td>
                      <td>{o.subscriptionUntil
                        ? (o.subscriptionExpired ? <span className="pill amber">expired</span> : <span className="pill green">until {o.subscriptionUntil}</span>)
                        : <span className="pill gray">no expiry</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 14, flexWrap: 'wrap', gap: 8 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 13 }}>Showing {from}–{to} of {total} organization{total === 1 ? '' : 's'}</span>
              <label className="muted" style={{ fontSize: 13, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                · Rows
                <select value={pageSize} onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }} style={{ width: 'auto', padding: '4px 8px' }}>
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </label>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <button className="btn ghost small" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
              <span className="muted" style={{ fontSize: 13 }}>Page {page} of {totalPages}</span>
              <button className="btn ghost small" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next →</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
});

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
  const [priceQuarterly, setPriceQuarterly] = useState(plan.price_quarterly ? String(plan.price_quarterly) : '');
  const [priceHalfYearly, setPriceHalfYearly] = useState(plan.price_half_yearly ? String(plan.price_half_yearly) : '');
  const [priceYearly, setPriceYearly] = useState(plan.price_yearly ? String(plan.price_yearly) : '');
  const [sortOrder, setSortOrder] = useState(plan.sort_order != null ? String(plan.sort_order) : '');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setMsg(null);
    const body = {
      name, unlimited, maxStudents: Number(maxStudents), priceMonthly: Number(priceMonthly), sortOrder: Number(sortOrder) || 0,
      priceQuarterly: Number(priceQuarterly) || 0, priceHalfYearly: Number(priceHalfYearly) || 0, priceYearly: Number(priceYearly) || 0,
    };
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

      <label style={{ marginTop: 12 }}>Billing-period prices (₹) — optional</label>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>Set a discounted price for a longer commitment. Leave blank to auto-calculate (monthly × months).</p>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div><label style={{ fontSize: 13 }}>Quarterly</label><input type="number" min="0" step="1" value={priceQuarterly} onChange={(e) => setPriceQuarterly(e.target.value)} placeholder="auto" style={{ width: 130 }} /></div>
        <div><label style={{ fontSize: 13 }}>Half-yearly</label><input type="number" min="0" step="1" value={priceHalfYearly} onChange={(e) => setPriceHalfYearly(e.target.value)} placeholder="auto" style={{ width: 130 }} /></div>
        <div><label style={{ fontSize: 13 }}>Annual</label><input type="number" min="0" step="1" value={priceYearly} onChange={(e) => setPriceYearly(e.target.value)} placeholder="auto" style={{ width: 130 }} /></div>
      </div>

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

function OrgDetail({ id, plans, onEditTeacher, onBack }) {
  const confirm = useConfirm();
  const [org, setOrg] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [subUntil, setSubUntil] = useState('');
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [msg, setMsg] = useState(null);

  const reload = () => api('/api/orgs/' + id).then((d) => { setOrg(d.org); setName(d.org.name); setSubUntil(d.org.subscriptionUntil || ''); });
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [id]);

  async function saveRename() {
    try { await api('/api/orgs/' + id, 'PUT', { name }); setRenaming(false); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function changePlan(planId) {
    try { await api('/api/orgs/' + id + '/plan', 'PUT', { planId: Number(planId) }); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function saveSubscription(value) {
    try {
      await api('/api/orgs/' + id + '/subscription', 'PUT', { expiresAt: value });
      setMsg({ ok: true, text: value ? `Subscription set to expire on ${value}.` : 'Subscription expiry cleared (no expiry).' });
      reload();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function addRoot() {
    try {
      await api('/api/admin/root-teachers', 'POST', { orgId: id, ...form });
      setForm({ name: '', email: '', phone: '' });
      setMsg({ ok: true, text: 'Root teacher created. Copy their signup link from the table below.' });
      reload();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function toggle(t) {
    if (!t.disabled && !(await confirm({ title: `Disable ${t.name}?`, body: 'They will be logged out immediately and cannot log in until you re-enable them.', confirmLabel: 'Disable', danger: true }))) return;
    try { await api('/api/admin/teachers/' + t.id, 'PATCH', { disabled: !t.disabled }); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function copy(text, btn) {
    const ok = await copyText(text);
    const prev = btn.textContent; btn.textContent = ok ? 'Copied!' : 'Press Ctrl/⌘+C';
    setTimeout(() => { btn.textContent = prev; }, ok ? 1500 : 2500);
    return ok;
  }
  async function copyReset(t, btn) {
    try {
      const { resetPath } = await api('/api/admin/teachers/' + t.id + '/reset-link', 'POST');
      const link = window.location.origin + resetPath;
      const ok = await copy(link, btn);
      // Always show the link — if the clipboard was blocked, the admin can still copy it by hand.
      setMsg({ ok: true, text: `${ok ? 'Reset link copied' : 'Copy the reset link below'} for ${t.name} (expires in 1 hour): ${link}` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }

  if (!org) return (
    <div>
      <button className="btn ghost small" onClick={onBack}>← Back to organizations</button>
      <div className="card" style={{ marginTop: 12 }}><p className="muted">Loading…</p></div>
    </div>
  );
  const overLimit = org.maxStudents != null && org.studentCount > org.maxStudents;
  return (
    <div>
      <button className="btn ghost small" onClick={onBack}>← Back to organizations</button>
      <div className="card" style={{ marginTop: 12 }}>
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
