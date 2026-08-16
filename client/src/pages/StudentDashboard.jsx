import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, fmtDateTime } from '../components.jsx';

export default function StudentDashboard() {
  const user = useRequireRole('student', '/student-login');
  const [assignments, setAssignments] = useState(null);

  useEffect(() => { if (user) api('/api/my-assignments').then((d) => setAssignments(d.assignments)); }, [user]);
  if (!user) return null;

  return (
    <>
      <DashboardBar who={user.name + ' · Student'} />
      <div className="container">
        <div className="card"><h1>My Tests</h1><p className="muted">Tests your teacher has assigned to you.</p></div>
        {assignments === null ? (
          <div className="card"><p className="muted">Loading…</p></div>
        ) : assignments.length === 0 ? (
          <div className="card"><p className="muted">No tests assigned yet. Check back later!</p></div>
        ) : (
          assignments.map((a) => (
            <div className="list-item" key={a.assignmentId}>
              <div>
                <h3>{a.title} {a.orgName && <span className="pill brand" style={{ fontSize: 12, fontWeight: 600 }}>{a.orgName}</span>}</h3>
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
    </>
  );
}
