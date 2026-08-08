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
  const [showProfile, setShowProfile] = useState(false);
  if (!me) return null;

  const openCreate = () => { setEditTestId(null); setTab('create'); };
  const openEdit = (id) => { setEditTestId(id); setTab('create'); };
  const afterSave = () => { setEditTestId(null); setTab('tests'); };

  const Tab = ({ id, label, icon, onClick }) => (
    <button className={'tab' + (tab === id ? ' active' : '')} onClick={onClick || (() => setTab(id))}>
      <span aria-hidden="true">{icon}</span> {label}
    </button>
  );

  return (
    <>
      <DashboardBar who={me.name + ' · ' + (me.isRoot ? 'Root teacher' : 'Teacher')} orgName={me.orgName}>
        <button className="btn ghost small" onClick={() => setShowProfile(true)}>⚙ Profile</button>
      </DashboardBar>
      <div className="container">
        {tab !== 'create' && <StatsBar />}
        <div className="tabs">
          <Tab id="tests" label="My Tests" icon="📋" />
          <Tab id="create" label="Create Test" icon="➕" onClick={openCreate} />
          <Tab id="students" label="Students" icon="👥" />
          <Tab id="teachers" label="Teachers" icon="🧑‍🏫" />
          <Tab id="subscription" label="Subscription" icon="💳" />
        </div>
        {tab === 'tests' && <MyTests onEdit={openEdit} />}
        {tab === 'create' && <TestBuilder key={editTestId || 'new'} editId={editTestId} onSaved={afterSave} onCancel={() => { setEditTestId(null); setTab('tests'); }} />}
        {tab === 'students' && <StudentsTab />}
        {tab === 'teachers' && <TeachersTab />}
        {tab === 'subscription' && <SubscriptionTab isRoot={me.isRoot} />}
      </div>
      {showProfile && <ProfileModal me={me} onClose={() => setShowProfile(false)} />}
    </>
  );
}

// At-a-glance counts across the organization. Fails quietly if any call errors.
function StatsBar() {
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
    { ic: '📝', n: s.tests, l: 'Tests' },
    { ic: '👥', n: s.students, l: 'Students' },
    { ic: '🧑‍🏫', n: s.teachers, l: 'Teachers' },
    { ic: '📌', n: s.assigned, l: 'Assignments' },
  ];
  return (
    <div className="stats">
      {items.map((it) => (
        <div className="stat" key={it.l}>
          <span className="ic" aria-hidden="true">{it.ic}</span>
          <span><span className="n">{it.n}</span><br /><span className="l">{it.l}</span></span>
        </div>
      ))}
    </div>
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
