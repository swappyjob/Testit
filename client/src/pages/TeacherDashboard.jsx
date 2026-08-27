import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Modal, Msg, PasswordInput } from '../components.jsx';
import MyTests from '../teacher/MyTests.jsx';
import TestBuilder from '../teacher/TestBuilder.jsx';
import StudentsTab from '../teacher/StudentsTab.jsx';
import TeachersTab from '../teacher/TeachersTab.jsx';
import SubscriptionTab from '../teacher/SubscriptionTab.jsx';
import QuestionBank from '../teacher/QuestionBank.jsx';
import AuditLogs from '../teacher/AuditLogs.jsx';
import SupportTickets from '../teacher/SupportTickets.jsx';
import TeacherHome from '../teacher/TeacherHome.jsx';

export default function TeacherDashboard() {
  const me = useRequireRole('teacher', '/teacher-login');
  const [tab, setTab] = useState('home');
  const [editTestId, setEditTestId] = useState(null);
  const [draftId, setDraftId] = useState(null);
  const [resultsFor, setResultsFor] = useState(null); // open this test's results in My Tests
  const [showProfile, setShowProfile] = useState(false);
  const [profilePane, setProfilePane] = useState('account');
  const [orgPlan, setOrgPlan] = useState(null); // { plan, studentCount, plans }
  const [limitDismissed, setLimitDismissed] = useState(false);
  const [expiryDismissed, setExpiryDismissed] = useState(false);
  const [showRenew, setShowRenew] = useState(false);
  const [renewedUntil, setRenewedUntil] = useState(null); // set after a successful renewal
  const [renewMsg, setRenewMsg] = useState('');

  useEffect(() => {
    let alive = true;
    api('/api/my-org/plan').then((d) => { if (alive) setOrgPlan(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!me) return null;

  const openProfile = (pane = 'account') => { setProfilePane(pane); setShowProfile(true); };
  const cap = orgPlan && orgPlan.plan ? orgPlan.plan.max_students : null;
  const used = orgPlan ? orgPlan.studentCount : null;
  const atLimit = cap != null && used != null && used >= cap;
  const nearLimit = cap != null && used != null && !atLimit && used >= Math.ceil(cap * 0.9);
  const showLimitBanner = (atLimit || nearLimit) && !limitDismissed;

  // A just-completed renewal overrides the (stale) value from /api/me until reload.
  const renewedExpired = renewedUntil ? new Date(renewedUntil).getTime() < Date.now() : null;
  const readOnly = renewedUntil ? !!renewedExpired : !!me.subscriptionExpired;
  // Warn when the subscription is within 3 days of expiring (renew before service is interrupted).
  const subUntil = renewedUntil || me.subscriptionUntil || '';
  const daysToExpiry = subUntil && !isNaN(new Date(subUntil)) ? Math.ceil((new Date(subUntil).getTime() - Date.now()) / 86400000) : null;
  const expiryLabel = subUntil ? new Date(subUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const showExpiryBanner = !readOnly && daysToExpiry != null && daysToExpiry <= 3 && !expiryDismissed;

  const openCreate = () => { if (readOnly) return; setEditTestId(null); setDraftId(null); setTab('create'); };
  const openEdit = (id) => { setEditTestId(id); setDraftId(null); setTab('create'); };
  const openDraft = (id) => { setEditTestId(null); setDraftId(id); setTab('create'); };
  const afterSave = () => { setEditTestId(null); setDraftId(null); setTab('tests'); };
  const cancelBuild = () => { setEditTestId(null); setDraftId(null); setTab('tests'); };

  const Tab = ({ id, label, icon, onClick, disabled }) => (
    <button className={'tab' + (tab === id ? ' active' : '')} disabled={disabled}
      title={disabled ? 'Unavailable while the subscription is expired' : undefined}
      onClick={onClick || (() => setTab(id))}>
      <span aria-hidden="true">{icon}</span> {label}
    </button>
  );

  return (
    <>
      <DashboardBar who={me.name + ' · ' + (me.isRoot ? 'Root teacher' : 'Teacher')} orgName={me.orgName}>
        <button className="btn ghost small" onClick={() => openProfile('account')}>⚙ Profile</button>
      </DashboardBar>
      <div className="container">
        {renewMsg && (
          <div className="msg" style={{ background: '#dcfce7', color: '#166534', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>✅</span>
            <span style={{ flex: 1 }}>{renewMsg}</span>
            <button className="btn ghost small" onClick={() => setRenewMsg('')}>Dismiss</button>
          </div>
        )}
        {showExpiryBanner && (
          <div className="msg" style={{ background: '#fef3c7', color: '#92400e', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>⏳</span>
            <span style={{ flex: 1 }}>
              <b>Your subscription {daysToExpiry <= 0 ? 'expires today' : daysToExpiry === 1 ? 'expires tomorrow' : `expires in ${daysToExpiry} days`}{expiryLabel ? ` (on ${expiryLabel})` : ''}.</b>{' '}
              Renew now to keep uninterrupted access for your students.{' '}
              {!me.isRoot && <span>Ask a root teacher or your administrator to renew.</span>}
            </span>
            {me.isRoot && <button className="btn small" onClick={() => setShowRenew(true)}>Renew now</button>}
            <button className="btn ghost small" onClick={() => setExpiryDismissed(true)}>Dismiss</button>
          </div>
        )}
        {showLimitBanner && (
          <div className="msg" style={{ background: atLimit ? '#fee2e2' : '#fef3c7', color: atLimit ? '#991b1b' : '#92400e', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>{atLimit ? '🚫' : '⚠️'}</span>
            <span style={{ flex: 1 }}>
              {atLimit
                ? <><b>Student limit reached ({used} / {cap}).</b> You can't add more students until your plan is upgraded. </>
                : <><b>You're approaching your student limit ({used} / {cap}).</b> Upgrade your plan soon to keep adding students. </>}
              {me.isRoot
                ? <a href="#" onClick={(e) => { e.preventDefault(); openProfile('subscription'); }}>Manage subscription →</a>
                : <span>Ask a root teacher or your administrator to upgrade.</span>}
            </span>
            <button className="btn ghost small" onClick={() => setLimitDismissed(true)}>Dismiss</button>
          </div>
        )}
        {readOnly && (
          <div className="msg error" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>🔒</span>
            <span>
              <b>Read-only mode — your organization's subscription has expired</b>
              {me.subscriptionUntil ? ` (on ${me.subscriptionUntil})` : ''}. You can still view everything, but creating,
              editing and deleting are disabled. Ask your administrator to renew the subscription.
            </span>
          </div>
        )}
        {tab !== 'create' && tab !== 'home' && <StatsBar onNavigate={setTab} />}
        <div className="tabs">
          <Tab id="home" label="Home" icon="🏠" />
          <Tab id="tests" label="My Tests" icon="📋" />
          <Tab id="students" label="Students" icon="👥" />
          <Tab id="teachers" label="Teachers" icon="🧑‍🏫" />
          <Tab id="bank" label="Question Bank" icon="📚" />
          <Tab id="audit" label="Audit Logs" icon="📜" />
          <Tab id="support" label="Support" icon="🎫" />
        </div>
        {tab === 'home' && <TeacherHome me={me} onCreate={openCreate} onNavigate={setTab} onOpenResults={(id) => { setResultsFor(id); setTab('tests'); }} readOnly={readOnly} />}
        {tab === 'tests' && <MyTests onEdit={openEdit} onResumeDraft={openDraft} onCreate={openCreate} readOnly={readOnly} openResultsFor={resultsFor} onResultsOpened={() => setResultsFor(null)} />}
        {tab === 'create' && !readOnly && <TestBuilder key={editTestId ? 'e' + editTestId : draftId ? 'd' + draftId : 'new'} editId={editTestId} draftId={draftId} onSaved={afterSave} onCancel={cancelBuild} />}
        {tab === 'students' && <StudentsTab readOnly={readOnly} />}
        {tab === 'teachers' && <TeachersTab readOnly={readOnly} />}
        {tab === 'bank' && <QuestionBank readOnly={readOnly} />}
        {tab === 'audit' && <AuditLogs />}
        {tab === 'support' && <SupportTickets />}
      </div>
      {showProfile && <ProfileModal me={me} initialPane={profilePane} onClose={() => setShowProfile(false)} onContactSupport={() => { setShowProfile(false); setTab('support'); }} />}
      {showRenew && (
        <RenewModal
          onClose={() => setShowRenew(false)}
          onRenewed={(newExpiry) => {
            setRenewedUntil(newExpiry);
            setShowRenew(false);
            setRenewMsg(`Subscription renewed — now active until ${new Date(newExpiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.`);
          }}
        />
      )}
    </>
  );
}

const RENEW_PERIODS = [
  { key: 'monthly', label: 'Monthly', months: 1 },
  { key: 'quarterly', label: 'Quarterly', months: 3 },
  { key: 'half_yearly', label: 'Half-yearly', months: 6 },
  { key: 'yearly', label: 'Annual', months: 12 },
];
const inr = (n) => (n > 0 ? '₹' + Number(n).toLocaleString('en-IN') : 'Free');
function previewExpiry(currentUntil, months) {
  const now = new Date();
  const cur = currentUntil ? new Date(currentUntil) : null;
  const base = cur && !isNaN(cur) && cur.getTime() > now.getTime() ? cur : now;
  const d = new Date(base.getTime());
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Root teacher renews their organization's subscription for a chosen billing
// period. The actual payment step slots in here once a gateway is integrated.
function RenewModal({ onClose, onRenewed }) {
  const [data, setData] = useState(null); // { plan, subscriptionUntil, ... }
  const [period, setPeriod] = useState('yearly');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { api('/api/my-org/plan').then(setData).catch((e) => setMsg({ ok: false, text: e.message })); }, []);

  async function renew() {
    setBusy(true); setMsg(null);
    try { const r = await api('/api/my-org/renew', 'POST', { period }); onRenewed(r.expiresAt, r); }
    catch (e) { setMsg({ ok: false, text: e.message }); setBusy(false); }
  }

  if (!data) return <Modal title="Renew subscription" onClose={onClose}><p className="muted">Loading…</p></Modal>;
  const plan = data.plan;
  const pricing = (plan && plan.pricing) || {};
  const sel = RENEW_PERIODS.find((p) => p.key === period);

  return (
    <Modal title="Renew subscription" onClose={onClose}>
      {plan
        ? <p className="muted" style={{ marginTop: 0 }}>Your organization is on the <b>{plan.name}</b> plan. Choose a billing period to renew.</p>
        : <p className="muted" style={{ marginTop: 0 }}>No plan is assigned to your organization yet.</p>}
      <div style={{ display: 'grid', gap: 8 }}>
        {RENEW_PERIODS.map((p) => (
          <label key={p.key} className="choice" style={{ display: 'flex', alignItems: 'center', gap: 10, ...(period === p.key ? { border: '2px solid var(--brand)' } : {}) }}>
            <input type="radio" name="renew-period" checked={period === p.key} onChange={() => setPeriod(p.key)} style={{ width: 'auto' }} />
            <span style={{ flex: 1 }}>{p.label} <span className="muted" style={{ fontSize: 13 }}>· {p.months} month{p.months === 1 ? '' : 's'}</span></span>
            <b>{plan ? inr(pricing[p.key]) : '—'}</b>
          </label>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
        Renews from {data.subscriptionUntil ? 'your current expiry' : 'today'} → new expiry <b>{previewExpiry(data.subscriptionUntil, sel.months)}</b>.
      </p>
      <div className="msg" style={{ background: '#eef2ff', color: 'var(--brand-dark)', fontSize: 13 }}>
        💳 Online payment is coming soon. For now this records the renewal and extends your access immediately.
      </div>
      {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <button className="btn" onClick={renew} disabled={busy}>{busy ? 'Renewing…' : `Renew — ${plan ? inr(pricing[period]) : ''}`}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// At-a-glance counts across the organization. Fails quietly if any call errors.
function StatsBar({ onNavigate }) {
  const [s, setS] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api('/api/tests').then((d) => d.tests).catch(() => []),
      api('/api/students').then((d) => d.students).catch(() => []),
      api('/api/teachers').then((d) => d.teachers).catch(() => []),
    ]).then(([tests, students, teachers]) => {
      if (!alive) return;
      const signedUpStudents = students.filter((x) => x.signedUp).length;
      setS({ tests: tests.length, students: signedUpStudents || students.length, teachers: teachers.length });
    });
    return () => { alive = false; };
  }, []);
  if (!s) return null;
  const items = [
    { ic: '📝', n: s.tests, l: 'Tests', to: 'tests' },
    { ic: '👥', n: s.students, l: 'Students', to: 'students' },
    { ic: '🧑‍🏫', n: s.teachers, l: 'Teachers', to: 'teachers' },
  ];
  return (
    <div className="stats">
      {items.map((it) => (
        <div className="stat" key={it.l} role="button" tabIndex={0} title={`Open ${it.l}`}
          style={{ cursor: 'pointer' }}
          onClick={() => onNavigate(it.to)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onNavigate(it.to); }}>
          <span className="ic" aria-hidden="true">{it.ic}</span>
          <span><span className="n">{it.n}</span><br /><span className="l">{it.l} ›</span></span>
        </div>
      ))}
    </div>
  );
}

function ProfileModal({ me, onClose, initialPane = 'account', onContactSupport }) {
  // Only root teachers get the Subscription pane.
  const [pane, setPane] = useState(me.isRoot ? initialPane : 'account');
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
    <Modal title="Profile" onClose={onClose} wide>
      <p className="muted">{me.name} · {me.email}</p>
      {me.isRoot && (
        <div className="tabs" style={{ marginTop: 10, marginBottom: 18 }}>
          <button className={'tab' + (pane === 'account' ? ' active' : '')} onClick={() => setPane('account')}>🔒 Account</button>
          <button className={'tab' + (pane === 'subscription' ? ' active' : '')} onClick={() => setPane('subscription')}>💳 Subscription</button>
        </div>
      )}

      {pane === 'account' && (
        <>
          {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
          <h3>Change password</h3>
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
        </>
      )}

      {pane === 'subscription' && <SubscriptionTab isRoot={me.isRoot} embedded onContact={onContactSupport} />}
    </Modal>
  );
}
