import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { Msg, fmtDateTime } from '../components.jsx';
import { MathText } from '../mathText.jsx';

export default function MyTests({ onEdit, onResumeDraft, onCreate, readOnly }) {
  const [tests, setTests] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [detail, setDetail] = useState(null); // { kind:'assign'|'results'|'attempt', test, attemptId }
  const detailRef = useRef(null);

  const load = () => api('/api/tests').then((d) => setTests(d.tests));
  const loadDrafts = () => api('/api/drafts').then((d) => setDrafts(d.drafts)).catch(() => {});
  useEffect(() => { load(); loadDrafts(); }, []);

  async function discardDraft(d) {
    if (!window.confirm(`Discard draft "${d.title || 'Untitled test'}"? This can't be undone.`)) return;
    await api('/api/drafts/' + d.id, 'DELETE');
    loadDrafts();
  }
  // Bring the inline panel into view when it opens (in case it sits below the fold).
  useEffect(() => { if (detail && detailRef.current) detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [detail]);

  async function del(t) {
    if (!window.confirm(`Delete "${t.title}"? This removes its questions and results.`)) return;
    await api('/api/tests/' + t.id, 'DELETE');
    setDetail(null);
    load();
  }
  // Open a panel for a test, or close it if that same panel is already open (toggle).
  const toggle = (kind, t) => setDetail((d) => (d && d.test.id === t.id && d.kind === kind ? null : { kind, test: t }));
  const isOpen = (kind, t) => detail && detail.test.id === t.id && detail.kind === kind;

  if (tests === null) return <div className="card"><p className="muted">Loading…</p></div>;

  return (
    <>
      {drafts.length > 0 && !readOnly && (
        <div className="card" style={{ borderColor: 'var(--brand-2)' }}>
          <h2 style={{ marginTop: 0 }}>📝 Drafts — unfinished tests</h2>
          {drafts.map((d) => (
            <div className="list-item" key={d.id}>
              <div>
                <h3 style={{ margin: 0 }}>{d.title || 'Untitled test'}</h3>
                <div className="muted" style={{ fontSize: 13 }}>Last saved {fmtDateTime(d.updatedAt)}</div>
              </div>
              <div className="row">
                <button className="btn small" onClick={() => onResumeDraft(d.id)}>Resume</button>
                <button className="btn danger small" onClick={() => discardDraft(d)}>Discard</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0 }}>My Tests</h1>
          <button className="btn" disabled={readOnly} onClick={onCreate}>➕ Create test</button>
        </div>
        {tests.length === 0 && <p className="muted" style={{ marginTop: 12 }}>No tests yet. Click <b>Create test</b> to make your first one.</p>}
      </div>
      {tests.map((t) => (
        <div key={t.id}>
          <div className="list-item">
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
              <button className="btn secondary small" disabled={readOnly} onClick={() => onEdit(t.id)}>Edit</button>
              <button className="btn small" disabled={readOnly} onClick={() => toggle('assign', t)}>{isOpen('assign', t) ? 'Close' : 'Assign'}</button>
              <button className="btn secondary small" onClick={() => toggle('results', t)}>{isOpen('results', t) || isOpen('attempt', t) ? 'Close' : 'Results'}</button>
              <button className="btn secondary small" onClick={() => toggle('leaderboard', t)}>{isOpen('leaderboard', t) ? 'Close' : '🏆 Toppers'}</button>
              <button className="btn danger small" disabled={readOnly} onClick={() => del(t)}>Delete</button>
            </div>
          </div>
          {detail && detail.test.id === t.id && (
            <div ref={detailRef} style={{ margin: '-4px 0 16px' }}>
              {detail.kind === 'assign' && <AssignPanel test={t} onChanged={load} />}
              {detail.kind === 'results' && <ResultsPanel test={t} onGrade={(attemptId) => setDetail({ kind: 'attempt', test: t, attemptId })} />}
              {detail.kind === 'attempt' && <AttemptPanel test={t} attemptId={detail.attemptId} readOnly={readOnly} onBack={() => setDetail({ kind: 'results', test: t })} />}
              {detail.kind === 'leaderboard' && <LeaderboardPanel test={t} />}
            </div>
          )}
        </div>
      ))}
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

  const assignable = students ? students.filter((s) => !assigned.has(s.studentId)) : [];
  const allSelected = assignable.length > 0 && assignable.every((s) => checked.has(s.studentId));

  return (
    <div className="card">
      <h2>Assign "{test.title}"</h2>
      {students === null ? <p className="muted">Loading…</p> : students.length === 0 ? (
        <p className="muted">No students have signed up yet. Add students under the Students tab first.</p>
      ) : (
        <>
          <p className="muted">Tick the students who should take this test.</p>
          {assignable.length > 0 && (
            <label className="choice" style={{ fontWeight: 600, borderBottom: '1px solid var(--line)', borderRadius: 0 }}>
              <input type="checkbox" checked={allSelected}
                onChange={(e) => setChecked(e.target.checked ? new Set(assignable.map((s) => s.studentId)) : new Set())} />
              Select all ({assignable.length})
            </label>
          )}
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
  const [proctored, setProctored] = useState(false);
  useEffect(() => { api('/api/tests/' + test.id + '/results').then((d) => { setResults(d.results); setProctored(!!d.proctored); }); }, [test.id]);
  return (
    <div className="card">
      <h2>Results — "{test.title}"</h2>
      {results === null ? <p className="muted">Loading…</p> : results.length === 0 ? (
        <p className="muted">No students have submitted this test yet.</p>
      ) : (
        <table>
          <thead><tr><th>Student</th><th>Score</th>{proctored && <th>Proctoring</th>}<th>Status</th><th></th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.attemptId}>
                <td>{r.name}<div className="muted" style={{ fontSize: 12 }}>{r.email}</div></td>
                <td><b>{r.score}</b> / {r.maxScore}</td>
                {proctored && <td>{r.violations > 0 ? <span className="pill amber">⚠ {r.violations} violation{r.violations === 1 ? '' : 's'}</span> : <span className="pill green">clean</span>}</td>}
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

function LeaderboardPanel({ test }) {
  const [data, setData] = useState(null); // { leaderboard, anyPending }
  useEffect(() => { api('/api/tests/' + test.id + '/leaderboard').then(setData).catch(() => setData({ leaderboard: [] })); }, [test.id]);
  const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>🏆 Toppers — "{test.title}"</h2>
      {data === null ? <p className="muted">Loading…</p> : data.leaderboard.length === 0 ? (
        <p className="muted">No students have submitted this test yet.</p>
      ) : (
        <>
          <p className="muted">Top {data.leaderboard.length} student(s) by score.</p>
          <table>
            <thead><tr><th>Rank</th><th>Student</th><th>Score</th></tr></thead>
            <tbody>
              {data.leaderboard.map((r, i) => (
                <tr key={i}>
                  <td style={{ fontSize: r.rank <= 3 ? 18 : 14, fontWeight: 700 }}>{medal(r.rank)}</td>
                  <td>{r.name}<div className="muted" style={{ fontSize: 12 }}>{r.email}</div></td>
                  <td><b>{r.score}</b> / {r.maxScore}{r.needsGrading ? <span className="pill amber" style={{ marginLeft: 6 }}>pending grading</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.anyPending && <p className="muted" style={{ fontSize: 13 }}>Some scores may change after written answers are graded.</p>}
        </>
      )}
    </div>
  );
}

function AttemptPanel({ test, attemptId, onBack, readOnly }) {
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

  // Per-section breakdown, computed from the answers (in first-appearance order).
  const secOrder = [];
  const secMap = {};
  items.forEach((it) => {
    const sec = it.section || '';
    if (!(sec in secMap)) { secMap[sec] = { awarded: 0, max: 0, pending: false }; secOrder.push(sec); }
    secMap[sec].max += it.points;
    secMap[sec].awarded += (it.pointsAwarded || 0);
    if (it.type === 'short' && it.isCorrect === null) secMap[sec].pending = true;
  });
  const breakdown = secOrder.map((name) => ({ section: name, ...secMap[name] }));
  const hasSections = breakdown.some((b) => b.section);

  return (
    <div className="card">
      <h2>{attempt.name} — {test.title}</h2>
      <p className="muted">
        Score: <b>{attempt.autoScore + attempt.manualScore}</b> / {attempt.maxScore}
        {attempt.needsGrading ? <> · <span className="pill amber">has answers to grade</span></> : null}
        {attempt.violations > 0 ? <> · <span className="pill amber">⚠ {attempt.violations} proctoring violation{attempt.violations === 1 ? '' : 's'}</span></> : null}
      </p>
      {hasSections && (
        <table style={{ maxWidth: 420, marginBottom: 12 }}>
          <thead><tr><th>Section</th><th style={{ textAlign: 'right' }}>Score</th></tr></thead>
          <tbody>
            {breakdown.map((b, i) => (
              <tr key={i}>
                <td>{b.section || 'Other'}{b.pending ? ' *' : ''}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{b.awarded} / {b.max}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Msg text={msg} kind="ok" />
      {items.map((it, i) => (
        <div className="q-card" key={it.answerId}>
          {it.section && <div className="pill brand" style={{ marginBottom: 8 }}>{it.section}</div>}
          <h3>Q{i + 1}. <MathText text={it.prompt} /> <span className="muted">({it.points} pt)</span></h3>
          {it.image && <img src={it.image} alt="" style={{ maxWidth: 280, maxHeight: 200, border: '1px solid var(--line)', borderRadius: 8, display: 'block', marginBottom: 10 }} />}
          {it.type === 'mcq' && (
            <div>
              Answered: <b><MathText text={it.response === '' ? '—' : (it.options[Number(it.response)] ?? it.response)} /></b>{' '}
              {it.isCorrect ? <span className="pill green">correct</span> : <span className="pill gray">wrong</span>}<br />
              <span className="muted">Correct answer: <MathText text={it.options[Number(it.correctAnswer)] ?? it.correctAnswer} /></span>
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
                Answered: <b><MathText text={fmt(it.response)} /></b>{' '}
                {it.isCorrect ? <span className="pill green">correct</span> : <span className="pill gray">wrong</span>}<br />
                <span className="muted">Correct answers: <MathText text={fmt(it.correctAnswer)} /></span>
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
              <div style={{ padding: '8px 0' }}><b>{it.response ? <MathText text={it.response} /> : '(blank)'}</b></div>
              <div className="row">
                <label style={{ margin: 0 }}>Points:</label>
                <input type="number" min="0" max={it.points} value={grades[it.answerId] ?? 0}
                  onChange={(e) => setGrades((g) => ({ ...g, [it.answerId]: Number(e.target.value) }))} style={{ width: 90 }} />
                <span className="muted">/ {it.points} {it.isCorrect === null ? <span className="pill amber">ungraded</span> : null}</span>
              </div>
            </div>
          )}
          {it.explanation && (
            <div className="msg" style={{ background: '#eef2ff', color: 'var(--brand-dark)', marginTop: 10 }}>
              <b>💡 Explanation:</b> <MathText text={it.explanation} />
            </div>
          )}
        </div>
      ))}
      {hasShort && !readOnly && <div style={{ marginTop: 8 }}><button className="btn" onClick={saveGrades}>Save grades</button></div>}
      <div style={{ marginTop: 12 }}><button className="btn ghost small" onClick={onBack}>← Back to results</button></div>
    </div>
  );
}
