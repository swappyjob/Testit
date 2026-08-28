import { useState, useEffect } from 'react';
import { api, logout } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar } from '../components.jsx';
import { useConfirm } from '../confirm.jsx';
import MyTests from '../teacher/MyTests.jsx';
import TestBuilder from '../teacher/TestBuilder.jsx';
import StudentsTab from '../teacher/StudentsTab.jsx';
import TeachersTab from '../teacher/TeachersTab.jsx';
import SubscriptionTab, { BillingTab } from '../teacher/SubscriptionTab.jsx';
import ProfileDetails from '../teacher/ProfileDetails.jsx';
import SubscribeModal, { renewResultMessage } from '../teacher/SubscribeModal.jsx';
import QuestionBank from '../teacher/QuestionBank.jsx';
import AuditLogs from '../teacher/AuditLogs.jsx';
import SupportTickets from '../teacher/SupportTickets.jsx';
import TeacherHome from '../teacher/TeacherHome.jsx';

export default function TeacherDashboard() {
  const me = useRequireRole('teacher', '/teacher-login');
  const confirm = useConfirm();
  const [tab, setTab] = useState('home');
  const [editTestId, setEditTestId] = useState(null);
  const [draftId, setDraftId] = useState(null);
  const [resultsFor, setResultsFor] = useState(null); // open this test's results in My Tests
  const [meOverride, setMeOverride] = useState(null); // local name updates (reflect in top bar)
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
  const u = meOverride ? { ...me, ...meOverride } : me;

  const openProfile = (pane = 'profile') => setTab(pane);
  async function confirmLogout() {
    if (await confirm({ title: 'Log out?', body: 'You will need to sign in again to access your organization.', confirmLabel: 'Log out' })) logout();
  }
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
      <DashboardBar who={u.name + ' · ' + (me.isRoot ? 'Root teacher' : 'Teacher')} orgName={me.orgName} hideLogout>
        <ProfileMenu isRoot={me.isRoot} onNavigate={setTab} onLogout={confirmLogout} />
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
        {tab !== 'create' && tab !== 'home' && !['profile', 'subscription', 'billing'].includes(tab) && <StatsBar onNavigate={setTab} />}
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
        {tab === 'profile' && <ProfileDetails me={u} onUpdated={(user) => setMeOverride(user)} />}
        {tab === 'subscription' && <SubscriptionTab isRoot={me.isRoot} onContact={() => setTab('support')} />}
        {tab === 'billing' && <BillingTab />}
      </div>
      {showRenew && (
        <SubscribeModal
          onClose={() => setShowRenew(false)}
          onDone={(r) => {
            setRenewedUntil(r.expiresAt);
            setShowRenew(false);
            setRenewMsg(renewResultMessage(r));
          }}
        />
      )}
    </>
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

// Profile dropdown in the top bar: Profile Details, Subscription & Billing
// (root only), and Log out (with a confirmation dialog).
function ProfileMenu({ isRoot, onNavigate, onLogout }) {
  const [open, setOpen] = useState(false);
  const go = (view) => { setOpen(false); onNavigate(view); };
  const item = { display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap' };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn ghost small" onClick={() => setOpen((v) => !v)} aria-haspopup="true" aria-expanded={open}>⚙ Profile ▾</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 41, background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.12)', minWidth: 190, overflow: 'hidden', padding: '4px 0' }}>
            <button style={item} onClick={() => go('profile')} onMouseDown={(e) => e.preventDefault()}>👤 Profile details</button>
            {isRoot && <button style={item} onClick={() => go('subscription')} onMouseDown={(e) => e.preventDefault()}>💳 Subscription</button>}
            {isRoot && <button style={item} onClick={() => go('billing')} onMouseDown={(e) => e.preventDefault()}>🧾 Billing</button>}
            <div style={{ borderTop: '1px solid var(--line, #e2e8f0)', margin: '4px 0' }} />
            <button style={{ ...item, color: 'var(--red, #dc2626)' }} onClick={() => { setOpen(false); onLogout(); }} onMouseDown={(e) => e.preventDefault()}>↩ Log out</button>
          </div>
        </>
      )}
    </div>
  );
}
