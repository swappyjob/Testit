import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Modal, Msg, PasswordInput } from '../components.jsx';
import MyTests from '../teacher/MyTests.jsx';
import TestBuilder from '../teacher/TestBuilder.jsx';
import StudentsTab from '../teacher/StudentsTab.jsx';
import TeachersTab from '../teacher/TeachersTab.jsx';
import SubscriptionTab from '../teacher/SubscriptionTab.jsx';

export default function TeacherDashboard() {
  const me = useRequireRole('teacher', '/teacher-login');
  const [tab, setTab] = useState('tests');
  const [editTestId, setEditTestId] = useState(null);
  const [draftId, setDraftId] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [profilePane, setProfilePane] = useState('account');
  const [orgPlan, setOrgPlan] = useState(null); // { plan, studentCount, plans }
  const [limitDismissed, setLimitDismissed] = useState(false);

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

  const readOnly = !!me.subscriptionExpired;
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
        {tab !== 'create' && <StatsBar onNavigate={setTab} />}
        <div className="tabs">
          <Tab id="tests" label="My Tests" icon="📋" />
          <Tab id="students" label="Students" icon="👥" />
          <Tab id="teachers" label="Teachers" icon="🧑‍🏫" />
        </div>
        {tab === 'tests' && <MyTests onEdit={openEdit} onResumeDraft={openDraft} onCreate={openCreate} readOnly={readOnly} />}
        {tab === 'create' && !readOnly && <TestBuilder key={editTestId ? 'e' + editTestId : draftId ? 'd' + draftId : 'new'} editId={editTestId} draftId={draftId} onSaved={afterSave} onCancel={cancelBuild} />}
        {tab === 'students' && <StudentsTab readOnly={readOnly} />}
        {tab === 'teachers' && <TeachersTab readOnly={readOnly} />}
      </div>
      {showProfile && <ProfileModal me={me} initialPane={profilePane} onClose={() => setShowProfile(false)} />}
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
      const assigned = tests.reduce((n, t) => n + (t.assigned_count || 0), 0);
      setS({ tests: tests.length, students: signedUpStudents || students.length, teachers: teachers.length, assigned });
    });
    return () => { alive = false; };
  }, []);
  if (!s) return null;
  const items = [
    { ic: '📝', n: s.tests, l: 'Tests', to: 'tests' },
    { ic: '👥', n: s.students, l: 'Students', to: 'students' },
    { ic: '🧑‍🏫', n: s.teachers, l: 'Teachers', to: 'teachers' },
    { ic: '📌', n: s.assigned, l: 'Assignments', to: 'tests' },
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

function ProfileModal({ me, onClose, initialPane = 'account' }) {
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

      {pane === 'subscription' && <SubscriptionTab isRoot={me.isRoot} embedded />}
    </Modal>
  );
}
