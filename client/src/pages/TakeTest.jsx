import { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Msg, fmtDateTime } from '../components.jsx';

export default function TakeTest() {
  const user = useRequireRole('student', '/student-login');
  const [params] = useSearchParams();
  const assignmentId = params.get('a');

  const [data, setData] = useState(null);       // { test, questions, durationMinutes, remainingSeconds }
  const [msg, setMsg] = useState('');
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState({});   // { questionId: value }
  const [remaining, setRemaining] = useState(null);
  const [result, setResult] = useState(null);   // { autoScore, maxScore, needsGrading, auto }
  const submitting = useRef(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    api('/api/take/' + assignmentId)
      .then((d) => { setData(d); if (d.durationMinutes > 0 && d.remainingSeconds != null) setRemaining(d.remainingSeconds); })
      .catch((e) => setMsg(e.message));
  }, [user]);

  // Countdown for timed tests.
  useEffect(() => {
    if (remaining == null || !data) return;
    if (remaining <= 0) { doSubmit(true); return; }
    intervalRef.current = setInterval(() => {
      setRemaining((r) => (r <= 1 ? 0 : r - 1));
    }, 1000);
    return () => clearInterval(intervalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining != null && data != null]);

  useEffect(() => {
    if (remaining === 0 && data && data.durationMinutes > 0 && !result) doSubmit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  function setAnswer(qid, value) { setAnswers((a) => ({ ...a, [qid]: value })); }

  // Multi-answer selections are stored as a JSON array string, e.g. "[0,2]".
  const parseSel = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; } };
  function toggleMulti(qid, idx) {
    const s = new Set(parseSel(answers[qid]));
    if (s.has(idx)) s.delete(idx); else s.add(idx);
    setAnswer(qid, JSON.stringify([...s].sort((a, b) => a - b)));
  }

  async function doSubmit(auto) {
    if (submitting.current) return;
    if (!auto && !window.confirm('Submit your test? You cannot change answers after this.')) return;
    submitting.current = true;
    clearInterval(intervalRef.current);
    try {
      const payload = {};
      data.questions.forEach((q) => { payload[q.id] = answers[q.id] ?? ''; });
      const r = await api('/api/submit/' + assignmentId, 'POST', { answers: payload });
      setResult({ ...r, auto });
    } catch (e) { submitting.current = false; setMsg(e.message); }
  }

  if (!user) return null;

  const bar = <DashboardBar who={user.name + ' · Student'}><Link className="btn ghost small" to="/student">Exit</Link></DashboardBar>;

  if (result) {
    return (
      <>
        {bar}
        <div className="container">
          <div className="card center">
            <h1>✅ Test submitted!</h1>
            <p style={{ fontSize: 22 }}>
              {result.needsGrading ? `Auto-graded score: ${result.autoScore} / ${result.maxScore}` : `Your score: ${result.autoScore} / ${result.maxScore}`}
            </p>
            <p className="muted">
              {result.auto ? "⏱ Time's up — your test was submitted automatically. " : ''}
              {result.needsGrading ? 'Some written answers still need to be graded by your teacher.' : ''}
            </p>
            <Link className="btn" to="/student">Back to my tests</Link>
          </div>
        </div>
      </>
    );
  }

  if (msg && !data) return (<>{bar}<div className="container"><Msg text={msg} /></div></>);
  if (!data) return (<>{bar}<div className="container"><div className="card"><p className="muted">Loading…</p></div></div></>);

  const { test, questions } = data;
  const q = questions[current];
  const last = current === questions.length - 1;
  const timed = data.durationMinutes > 0 && remaining != null;
  const mm = Math.floor((remaining || 0) / 60);
  const ss = String((remaining || 0) % 60).padStart(2, '0');

  return (
    <>
      {bar}
      <div className="container">
        <Msg text={msg} />
        <div className="card">
          <h1>{test.title}</h1>
          <p className="muted">
            {test.description}
            {test.due_date ? (test.description ? '  ·  ' : '') + '⏰ Due: ' + fmtDateTime(test.due_date) : ''}
          </p>
          {test.negative_marking ? (
            <div className="msg" style={{ background: '#fef3c7', color: '#92400e' }}>
              ⚠️ Negative marking is ON: {test.penalty} mark(s) will be deducted for each wrong multiple-choice, multiple-answer or true/false answer. Leaving a question blank costs nothing.
            </div>
          ) : null}
          {timed && (
            <div style={{ fontWeight: 700, fontSize: 20, marginTop: 8, color: remaining <= 30 ? 'var(--red)' : 'var(--brand)' }}>
              ⏱ Time left: {mm}:{ss}
            </div>
          )}
        </div>

        <div className="q-card">
          <h3>Q{current + 1}. {q.prompt} <span className="muted">({q.points} pt)</span></h3>
          {q.image && <img src={q.image} alt="" style={{ maxWidth: '100%', maxHeight: 260, border: '1px solid var(--line)', borderRadius: 8, display: 'block', marginBottom: 10 }} />}
          {q.type === 'mcq' && q.options.map((opt, idx) => (
            <label className="choice" key={idx}>
              <input type="radio" name={'q' + q.id} checked={answers[q.id] === String(idx)} onChange={() => setAnswer(q.id, String(idx))} /> {opt}
            </label>
          ))}
          {q.type === 'multi' && (
            <>
              <p className="muted" style={{ margin: '0 0 8px' }}>Select all that apply.</p>
              {q.options.map((opt, idx) => (
                <label className="choice" key={idx}>
                  <input type="checkbox" checked={parseSel(answers[q.id]).includes(idx)} onChange={() => toggleMulti(q.id, idx)} /> {opt}
                </label>
              ))}
            </>
          )}
          {q.type === 'truefalse' && ['true', 'false'].map((v) => (
            <label className="choice" key={v}>
              <input type="radio" name={'q' + q.id} checked={answers[q.id] === v} onChange={() => setAnswer(q.id, v)} /> {v === 'true' ? 'True' : 'False'}
            </label>
          ))}
          {q.type === 'short' && (
            <textarea placeholder="Type your answer..." value={answers[q.id] || ''} onChange={(e) => setAnswer(q.id, e.target.value)} />
          )}
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <button className="btn ghost" type="button" disabled={current === 0} onClick={() => setCurrent((c) => Math.max(0, c - 1))}>← Previous</button>
            <span className="muted">Question {current + 1} of {questions.length}</span>
            {last
              ? <button className="btn" type="button" onClick={() => doSubmit(false)}>Submit test</button>
              : <button className="btn" type="button" onClick={() => setCurrent((c) => Math.min(questions.length - 1, c + 1))}>Next →</button>}
          </div>
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
            Use Previous / Next to move between questions. Your answers are kept as you navigate. You can only submit once.
          </p>
        </div>
      </div>
    </>
  );
}
