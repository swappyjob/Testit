import { useState, useEffect } from 'react';
import { api } from '../api.js';

const ACTION_LABEL = {
  'test.create': 'created a test', 'test.update': 'edited a test', 'test.delete': 'deleted a test',
  'test.assign': 'assigned a test', 'student.create': 'added a student', 'student.disable': 'disabled a student',
  'student.enable': 'enabled a student', 'teacher.create': 'invited a teacher',
};
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
// First name, but keep a leading honorific with it ("Dr. Anjali Verma" → "Dr. Anjali").
const TITLES = new Set(['dr', 'dr.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'prof', 'prof.', 'mx', 'mx.']);
function displayName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length > 1 && TITLES.has(parts[0].toLowerCase())) return parts[0] + ' ' + parts[1];
  return parts[0] || '';
}
function ago(s) {
  const d = new Date(s); if (isNaN(d)) return '';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
const Icon = ({ d }) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;

export default function TeacherHome({ me, onCreate, onNavigate, readOnly }) {
  const [s, setS] = useState(null);
  const [activity, setActivity] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/api/teacher/summary').then((d) => { if (alive) setS(d); }).catch(() => { if (alive) setS({}); });
    api('/api/audit').then((d) => { if (alive) setActivity(d.logs.slice(0, 6)); }).catch(() => { if (alive) setActivity([]); });
    return () => { alive = false; };
  }, []);

  const tiles = [
    { key: 'students', label: 'Students', value: s?.students ?? '—', to: 'students', bg: '#dcfce7', fg: '#16a34a', icon: <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /> },
    { key: 'tests', label: 'Tests', value: s?.tests ?? '—', to: 'tests', bg: '#eef2ff', fg: '#4f46e5', icon: <path d="M9 12h6M9 16h6M9 8h6M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /> },
    { key: 'teachers', label: 'Teachers', value: s?.teachers ?? '—', to: 'teachers', bg: '#fef3c7', fg: '#d97706', icon: <path d="M22 10v6M2 10l10-5 10 5-10 5z M6 12v5c3 3 9 3 12 0v-5" /> },
  ];
  const actions = [
    { label: 'Create a test', sub: 'Build questions with math & diagrams', bg: '#eef2ff', fg: '#4f46e5', icon: <path d="M12 5v14M5 12h14" />, onClick: () => !readOnly && onCreate() },
    { label: 'Add students', sub: 'Invite students to your organization', bg: '#dcfce7', fg: '#16a34a', icon: <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6" />, onClick: () => onNavigate('students') },
    { label: 'Question bank', sub: 'Reuse questions across tests', bg: '#fef3c7', fg: '#d97706', icon: <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z" />, onClick: () => onNavigate('bank') },
  ];

  return (
    <>
      <div className="card" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>{greeting()}, {displayName(me.name)}</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>Here's what's happening{me.orgName ? ` at ${me.orgName}` : ''}.</p>
        </div>
        {!readOnly && <button className="btn" onClick={onCreate}>+ Create test</button>}
      </div>

      {/* metric tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${tiles.length}, minmax(0,1fr))`, gap: 14, marginTop: 16 }}>
        {tiles.map((t) => (
          <div key={t.key} className="card" role="button" tabIndex={0} onClick={() => onNavigate(t.to)}
            onKeyDown={(e) => { if (e.key === 'Enter') onNavigate(t.to); }}
            style={{ padding: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 42, height: 42, borderRadius: 11, background: t.bg, color: t.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon d={t.icon} /></div>
            <div><div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1 }}>{t.value}</div><div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t.label}</div></div>
          </div>
        ))}
      </div>

      {/* quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 14, marginTop: 14 }}>
        {actions.map((a) => (
          <div key={a.label} className="card" role="button" tabIndex={0} onClick={a.onClick}
            onKeyDown={(e) => { if (e.key === 'Enter') a.onClick(); }}
            style={{ padding: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: a.bg, color: a.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon d={a.icon} /></div>
            <div><div style={{ fontWeight: 700 }}>{a.label}</div><div className="muted" style={{ fontSize: 12 }}>{a.sub}</div></div>
          </div>
        ))}
      </div>

      {/* recent tests + activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14, marginTop: 14 }}>
        <div className="card" style={{ padding: '18px 20px' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <b>Recent tests</b>
            <button className="btn ghost small" onClick={() => onNavigate('tests')}>View all</button>
          </div>
          {!s ? <p className="muted">Loading…</p> : s.recentTests && s.recentTests.length ? s.recentTests.map((t) => (
            <div key={t.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--line)' }}>
              <div><div style={{ fontWeight: 600 }}>{t.title}</div><div className="muted" style={{ fontSize: 12 }}>{t.submitted} submitted{t.assigned ? ` of ${t.assigned}` : ''}{t.closed ? ' · closed' : ''}</div></div>
              <button className="btn secondary small" onClick={() => onNavigate('tests')}>Results</button>
            </div>
          )) : <p className="muted">No tests yet. Create your first one above.</p>}
        </div>

        <div className="card" style={{ padding: '18px 20px' }}>
          <b>Recent activity</b>
          <div style={{ marginTop: 8 }}>
            {activity === null ? <p className="muted">Loading…</p> : activity.length ? activity.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 10, padding: '7px 0', fontSize: 13 }}>
                <span style={{ color: 'var(--brand)' }}>•</span>
                <div><b>{a.actor}</b> {ACTION_LABEL[a.action] || a.action}{a.entityLabel ? <> — {a.entityLabel}</> : ''}<div className="muted" style={{ fontSize: 11 }}>{ago(a.at)}</div></div>
              </div>
            )) : <p className="muted">No activity yet.</p>}
          </div>
        </div>
      </div>
    </>
  );
}
