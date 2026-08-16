import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Modal, fmtDateTime } from '../components.jsx';

export default function StudentDashboard() {
  const user = useRequireRole('student', '/student-login');
  const [assignments, setAssignments] = useState(null);
  const [orgs, setOrgs] = useState(null);
  const [activeOrg, setActiveOrg] = useState(null); // 'all' | orgId(number) | null (not chosen yet)

  useEffect(() => {
    if (!user) return;
    api('/api/my-assignments').then((d) => setAssignments(d.assignments)).catch(() => setAssignments([]));
    api('/api/my-orgs').then((d) => setOrgs(d.orgs)).catch(() => setOrgs([]));
  }, [user]);

  const storeKey = user ? 'testit-active-org-' + user.id : null;

  // Once orgs are known: single-org students skip straight in; multi-org students
  // restore a saved choice, or get the "choose organization" popup.
  useEffect(() => {
    if (!orgs || !storeKey) return;
    if (orgs.length <= 1) { setActiveOrg('all'); return; }
    const saved = localStorage.getItem(storeKey);
    if (saved === 'all') setActiveOrg('all');
    else if (orgs.some((o) => String(o.id) === saved)) setActiveOrg(Number(saved));
    // else: leave null so the chooser modal appears
  }, [orgs, storeKey]);

  function chooseOrg(v) {
    setActiveOrg(v);
    if (storeKey) localStorage.setItem(storeKey, String(v));
  }

  if (!user) return null;

  const multi = orgs && orgs.length > 1;
  const showChooser = multi && activeOrg === null;
  const perOrg = multi && activeOrg !== 'all' && activeOrg !== null;
  const visible = (assignments || []).filter((a) => (perOrg ? a.orgId === activeOrg : true));
  const activeName = perOrg ? (orgs.find((o) => o.id === activeOrg) || {}).name : null;

  return (
    <>
      <DashboardBar who={user.name + ' · Student'}>
        {multi && !showChooser && (
          <label className="row" style={{ gap: 6, alignItems: 'center', margin: 0 }}>
            <span className="muted" style={{ fontSize: 13 }}>Institute:</span>
            <select value={String(activeOrg)} onChange={(e) => chooseOrg(e.target.value === 'all' ? 'all' : Number(e.target.value))} style={{ width: 'auto' }}>
              <option value="all">All organizations</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        )}
      </DashboardBar>
      <div className="container">
        <div className="card">
          <h1>My Tests</h1>
          <p className="muted">
            {perOrg
              ? <>Showing tests from <b>{activeName}</b>. Switch institute from the top bar to see the others.</>
              : 'Tests your teachers have assigned to you.'}
          </p>
        </div>
        {assignments === null ? (
          <div className="card"><p className="muted">Loading…</p></div>
        ) : visible.length === 0 ? (
          <div className="card"><p className="muted">No tests {perOrg ? 'from this organization ' : ''}assigned yet. Check back later!</p></div>
        ) : (
          visible.map((a) => (
            <div className="list-item" key={a.assignmentId}>
              <div>
                <h3>{a.title} {!perOrg && a.orgName && <span className="pill brand" style={{ fontSize: 12, fontWeight: 600 }}>{a.orgName}</span>}</h3>
                <div className="muted" style={{ fontSize: 13 }}>
                  {a.description} {a.questionCount} question(s){a.dueDate ? ' · Due ' + fmtDateTime(a.dueDate) : ''}
                </div>
              </div>
              <div className="row">
                {a.submitted ? (
                  <>
                    {a.needsGrading
                      ? <span className="pill amber">submitted · awaiting grade</span>
                      : <span className="pill green">Score: {a.score} / {a.maxScore}</span>}
                    <Link className="btn secondary small" to={'/review?a=' + a.assignmentId}>Review answers</Link>
                  </>
                ) : a.closed ? (
                  <span className="pill gray">closed · deadline passed</span>
                ) : (
                  <Link className="btn small" to={'/take-test?a=' + a.assignmentId}>{a.started ? 'Resume test' : 'Start test'}</Link>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {showChooser && (
        <Modal title="Choose your institute" onClose={() => chooseOrg('all')}>
          <p className="muted">You're a member of more than one organization. Pick one to view its tests — you can switch anytime from the top bar.</p>
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            {orgs.map((o) => (
              <button key={o.id} className="btn" onClick={() => chooseOrg(o.id)}>{o.name}</button>
            ))}
            <button className="btn ghost" onClick={() => chooseOrg('all')}>Show all organizations together</button>
          </div>
        </Modal>
      )}
    </>
  );
}
