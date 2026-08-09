import { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Msg, fmtDateTime } from '../components.jsx';

// Per-section score table. Only renders when the test actually used sections.
function SectionBreakdown({ rows }) {
  if (!Array.isArray(rows)) return null;
  const named = rows.filter((r) => r.section);
  if (named.length === 0) return null;
  const anyPending = rows.some((r) => r.pending);
  return (
    <div style={{ maxWidth: 420, margin: '4px auto 18px', textAlign: 'left' }}>
      <h3 style={{ marginBottom: 6 }}>Section-wise score</h3>
      <table>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.section || 'Other'}{r.pending ? ' *' : ''}</td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.awarded} / {r.max}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {anyPending && <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>* includes written answers still to be graded.</p>}
    </div>
  );
}

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

  // --- Proctoring state ---
  const violationsRef = useRef(0);
  const [violationMsg, setViolationMsg] = useState('');
  const [outOfFs, setOutOfFs] = useState(false);
  const [started, setStarted] = useState(false); // proctored start gate (fullscreen)
  const proctored = !!(data && data.test && data.test.proctored);
  const maxV = (data && data.test && data.test.max_violations) || 3;

  useEffect(() => {
    if (!user) return;
    api('/api/take/' + assignmentId)
      .then((d) => { setData(d); if (d.durationMinutes > 0 && d.remainingSeconds != null) setRemaining(d.remainingSeconds); })
      .catch((e) => setMsg(e.message));
  }, [user]);

  async function requestFs() {
    try { await document.documentElement.requestFullscreen(); } catch { /* best effort */ }
  }
  async function startProctored() { await requestFs(); setStarted(true); }

  // Monitor for tab-switches, fullscreen exits, and copy/paste while a proctored
  // test is in progress. Each violation warns; at the limit the test auto-submits.
  useEffect(() => {
    if (!proctored || !started || result) return;
    function flag(reason) {
      if (submitting.current || result) return;
      violationsRef.current += 1;
      const n = violationsRef.current;
      if (n >= maxV) {
        setViolationMsg(`Violation limit reached (${n}/${maxV}). Submitting your test…`);
        doSubmit(true, 'violations');
        return;
      }
      setViolationMsg(`⚠️ Warning ${n} of ${maxV}: leaving the test (${reason}) is not allowed. At ${maxV} the test auto-submits.`);
    }
    const onVis = () => { if (document.hidden) flag('switching tabs'); };
    const onFs = () => {
      if (submitting.current || result) return;
      if (!document.fullscreenElement) { setOutOfFs(true); flag('exiting fullscreen'); } else { setOutOfFs(false); }
    };
    const block = (e) => e.preventDefault();
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('copy', block);
    document.addEventListener('cut', block);
    document.addEventListener('paste', block);
    document.addEventListener('contextmenu', block);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('copy', block);
      document.removeEventListener('cut', block);
      document.removeEventListener('paste', block);
      document.removeEventListener('contextmenu', block);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proctored, started, result]);

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

  async function doSubmit(auto, reason) {
    if (submitting.current) return;
    if (!auto && !window.confirm('Submit your test? You cannot change answers after this.')) return;
    submitting.current = true;
    clearInterval(intervalRef.current);
    try {
      const payload = {};
      data.questions.forEach((q) => { payload[q.id] = answers[q.id] ?? ''; });
      const r = await api('/api/submit/' + assignmentId, 'POST', { answers: payload, violations: violationsRef.current });
      if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* ignore */ } }
      setResult({ ...r, auto, reason });
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
              {result.reason === 'violations' ? '🔒 Your test was auto-submitted because the proctoring violation limit was reached. ' : (result.auto ? "⏱ Time's up — your test was submitted automatically. " : '')}
              {result.needsGrading ? 'Some written answers still need to be graded by your teacher.' : ''}
            </p>
            <SectionBreakdown rows={result.sectionBreakdown} />
            <Link className="btn" to="/student">Back to my tests</Link>
          </div>
        </div>
      </>
    );
  }

  if (msg && !data) return (<>{bar}<div className="container"><Msg text={msg} /></div></>);
  if (!data) return (<>{bar}<div className="container"><div className="card"><p className="muted">Loading…</p></div></div></>);

  // Proctored tests start behind a fullscreen gate with the rules.
  if (proctored && !started) {
    return (
      <>
        {bar}
        <div className="container">
          <div className="card center">
            <h1>🔒 {data.test.title}</h1>
            <p className="muted" style={{ maxWidth: 520, margin: '8px auto' }}>
              This is a <b>proctored</b> test — it runs in fullscreen and monitors for cheating:
            </p>
            <ul style={{ textAlign: 'left', maxWidth: 520, margin: '0 auto 16px', color: 'var(--muted)', lineHeight: 1.9 }}>
              <li>Stay in <b>fullscreen</b> — leaving it counts as a violation.</li>
              <li>Do <b>not</b> switch tabs or windows.</li>
              <li>Copy, paste and right-click are disabled.</li>
              <li>After <b>{maxV}</b> violations the test auto-submits, and every violation is recorded for your teacher.</li>
            </ul>
            <button className="btn" onClick={startProctored}>Start test in fullscreen</button>
          </div>
        </div>
      </>
    );
  }

  const { test, questions } = data;
  const q = questions[current];
  const last = current === questions.length - 1;
  const timed = data.durationMinutes > 0 && remaining != null;
  const mm = Math.floor((remaining || 0) / 60);
  const ss = String((remaining || 0) % 60).padStart(2, '0');

  return (
    <>
      {bar}
      {proctored && outOfFs && !result && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.93)', color: '#fff', zIndex: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 44 }}>🔒</div>
          <h2 style={{ color: '#fff', margin: 0 }}>You left fullscreen</h2>
          <p style={{ maxWidth: 460 }}>This has been recorded as a violation. Return to fullscreen to continue your test.</p>
          <button className="btn" onClick={requestFs}>Return to fullscreen</button>
        </div>
      )}
      <div className="container">
        <Msg text={msg} />
        {proctored && violationMsg && (
          <div className="msg error" style={{ position: 'sticky', top: 8, zIndex: 20 }}>{violationMsg}</div>
        )}
        <div className="card">
          {proctored && <div className="pill amber" style={{ marginBottom: 8 }}>🔒 Proctored — stay in fullscreen, don't switch tabs</div>}
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
          {q.section && <div className="pill brand" style={{ marginBottom: 8 }}>{q.section}</div>}
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
