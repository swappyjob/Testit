import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg, fmtDateTime } from '../components.jsx';

export default function MyTests({ onEdit }) {
  const [tests, setTests] = useState(null);
  const [detail, setDetail] = useState(null); // { kind:'assign'|'results'|'attempt', test, attemptId }

  const load = () => api('/api/tests').then((d) => setTests(d.tests));
  useEffect(() => { load(); }, []);

  async function del(t) {
    if (!window.confirm(`Delete "${t.title}"? This removes its questions and results.`)) return;
    await api('/api/tests/' + t.id, 'DELETE');
    setDetail(null);
    load();
  }

  if (tests === null) return <div className="card"><p className="muted">Loading…</p></div>;

  return (
    <>
      <div className="card">
        <h1>My Tests</h1>
        {tests.length === 0 && <p className="muted">No tests yet. Go to <b>Create Test</b> to make your first one.</p>}
        {tests.map((t) => (
          <div className="list-item" key={t.id}>
            <div>
              <h3>
                {t.title}{' '}
                {t.negative_marking ? <span className="pill amber">−{t.penalty} per wrong</span> : null}{' '}
                {t.duration_minutes ? <span className="pill brand">⏱ {t.duration_minutes} min</span> : null}{' '}
                {t.closed ? <span className="pill gray">closed</span> : null}
              </h3>
              <div className="muted" style={{ fontSize: 13 }}>
                {t.question_count} question(s) · assigned to {t.assigned_count} student(s)
                {t.due_date ? ' · Due ' + fmtDateTime(t.due_date) : ''}
              </div>
            </div>
            <div className="row">
              <button className="btn secondary small" onClick={() => onEdit(t.id)}>Edit</button>
              <button className="btn small" onClick={() => setDetail({ kind: 'assign', test: t })}>Assign</button>
              <button className="btn secondary small" onClick={() => setDetail({ kind: 'results', test: t })}>Results</button>
              <button className="btn danger small" onClick={() => del(t)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {detail?.kind === 'assign' && <AssignPanel test={detail.test} onChanged={load} />}
      {detail?.kind === 'results' && <ResultsPanel test={detail.test} onGrade={(attemptId) => setDetail({ kind: 'attempt', test: detail.test, attemptId })} />}
      {detail?.kind === 'attempt' && <AttemptPanel test={detail.test} attemptId={detail.attemptId} onBack={() => setDetail({ kind: 'results', test: detail.test })} />}
    </>
  );
}

function AssignPanel({ test, onChanged }) {
  const [students, setStudents] = useState(null);
  const [assigned, setAssigned] = useState(new Set());
  const [checked, setChecked] = useState(new Set());
  const [msg, setMsg] = useState('');

  const reloadAssigned = () => api('/api/tests/' + test.id + '/assignments').then((a) => setAssigned(new Set(a.assigned.map((x) => x.student_id))));
  useEffect(() => {
    api('/api/students').then((s) => setStudents(s.students.filter((x) => x.signedUp && x.studentId)));
    reloadAssigned();
  }, []);

  function toggle(id) {
    setChecked((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  async function assign() {
    const ids = [...checked];
    if (!ids.length) { setMsg('Select at least one student.'); return; }
    const r = await api('/api/assignments', 'POST', { test_id: test.id, student_ids: ids });
    setMsg(`Assigned to ${r.assigned} student(s).`);
    setChecked(new Set());
    await reloadAssigned();
    onChanged?.();
  }

  return (
    <div className="card">
      <h2>Assign "{test.title}"</h2>
      {students === null ? <p className="muted">Loading…</p> : students.length === 0 ? (
        <p className="muted">No students have signed up yet. Add students under the Students tab first.</p>
      ) : (
        <>
          <p className="muted">Tick the students who should take this test.</p>
          {students.map((s) => {
            const done = assigned.has(s.studentId);
            return (
              <label className="choice" key={s.studentId}>
                <input type="checkbox" disabled={done} checked={done || checked.has(s.studentId)} onChange={() => toggle(s.studentId)} />
                {s.name} <span className="muted">({s.email})</span>
                {done && <span className="pill green">already assigned</span>}
              </label>
            );
          })}
          <div style={{ marginTop: 16 }}><button className="btn" onClick={assign}>Assign to selected</button></div>
        </>
      )}
      <Msg text={msg} kind="ok" />
    </div>
  );
}

function ResultsPanel({ test, onGrade }) {
  const [results, setResults] = useState(null);
  useEffect(() => { api('/api/tests/' + test.id + '/results').then((d) => setResults(d.results)); }, [test.id]);
  return (
    <div className="card">
      <h2>Results — "{test.title}"</h2>
      {results === null ? <p className="muted">Loading…</p> : results.length === 0 ? (
        <p className="muted">No students have submitted this test yet.</p>
      ) : (
        <table>
          <thead><tr><th>Student</th><th>Score</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.attemptId}>
                <td>{r.name}<div className="muted" style={{ fontSize: 12 }}>{r.email}</div></td>
                <td><b>{r.score}</b> / {r.maxScore}</td>
                <td>{r.needsGrading ? <span className="pill amber">needs grading</span> : <span className="pill green">graded</span>}</td>
                <td><button className="btn secondary small" onClick={() => onGrade(r.attemptId)}>View / Grade</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AttemptPanel({ test, attemptId, onBack }) {
  const [data, setData] = useState(null);
  const [grades, setGrades] = useState({}); // answerId -> points
  const [msg, setMsg] = useState('');

  const load = () => api('/api/attempts/' + attemptId).then((d) => {
    setData(d);
    const g = {};
    d.items.filter((i) => i.type === 'short').forEach((i) => { g[i.answerId] = i.pointsAwarded; });
    setGrades(g);
  });
  useEffect(() => { load(); }, [attemptId]);

  async function saveGrades() {
    await api('/api/attempts/' + attemptId + '/grade', 'POST', { grades });
    setMsg('Grades saved!');
    load();
  }

  if (!data) return <div className="card"><p className="muted">Loading…</p></div>;
  const { attempt, items } = data;
  const hasShort = items.some((i) => i.type === 'short');

  return (
    <div className="card">
      <h2>{attempt.name} — {test.title}</h2>
      <p className="muted">
        Score: <b>{attempt.autoScore + attempt.manualScore}</b> / {attempt.maxScore}
        {attempt.needsGrading ? <> · <span className="pill amber">has answers to grade</span></> : null}
      </p>
      <Msg text={msg} kind="ok" />
      {items.map((it, i) => (
        <div className="q-card" key={it.answerId}>
          {it.section && <div className="pill brand" style={{ marginBottom: 8 }}>{it.section}</div>}
          <h3>Q{i + 1}. {it.prompt} <span className="muted">({it.points} pt)</span></h3>
          {it.image && <img src={it.image} alt="" style={{ maxWidth: 280, maxHeight: 200, border: '1px solid var(--line)', borderRadius: 8, display: 'block', marginBottom: 10 }} />}
          {it.type === 'mcq' && (
            <div>
              Answered: <b>{it.response === '' ? '—' : (it.options[Number(it.response)] ?? it.response)}</b>{' '}
              {it.isCorrect ? <span className="pill green">correct</span> : <span className="pill gray">wrong</span>}<br />
              <span className="muted">Correct answer: {it.options[Number(it.correctAnswer)] ?? it.correctAnswer}</span>
            </div>
          )}
          {it.type === 'multi' && (() => {
            const fmt = (raw) => {
              if (raw === '' || raw == null) return '—';
              let a; try { a = JSON.parse(raw); } catch { a = raw; }
              if (!Array.isArray(a)) a = [Number(a)]; // tolerate legacy single-index like "2"
              a = a.filter((n) => Number.isFinite(Number(n)));
              if (a.length === 0) return '—';
              return a.map((idx) => it.options[Number(idx)] ?? idx).join(', ');
            };
            return (
              <div>
                Answered: <b>{fmt(it.response)}</b>{' '}
                {it.isCorrect ? <span className="pill green">correct</span> : <span className="pill gray">wrong</span>}<br />
                <span className="muted">Correct answers: {fmt(it.correctAnswer)}</span>
              </div>
            );
          })()}
          {it.type === 'truefalse' && (
            <div>
              Answered: <b>{it.response === '' ? '—' : it.response}</b>{' '}
              {it.isCorrect ? <span className="pill green">correct</span> : <span className="pill gray">wrong</span>}<br />
              <span className="muted">Correct answer: {it.correctAnswer}</span>
            </div>
          )}
          {it.type === 'short' && (
            <div>
              <span className="muted">Student wrote:</span>
              <div style={{ padding: '8px 0' }}><b>{it.response ? it.response : '(blank)'}</b></div>
              <div className="row">
                <label style={{ margin: 0 }}>Points:</label>
                <input type="number" min="0" max={it.points} value={grades[it.answerId] ?? 0}
                  onChange={(e) => setGrades((g) => ({ ...g, [it.answerId]: Number(e.target.value) }))} style={{ width: 90 }} />
                <span className="muted">/ {it.points} {it.isCorrect === null ? <span className="pill amber">ungraded</span> : null}</span>
              </div>
            </div>
          )}
        </div>
      ))}
      {hasShort && <div style={{ marginTop: 8 }}><button className="btn" onClick={saveGrades}>Save grades</button></div>}
      <div style={{ marginTop: 12 }}><button className="btn ghost small" onClick={onBack}>← Back to results</button></div>
    </div>
  );
}
