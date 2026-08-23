import { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Modal, Msg, fmtDateTime } from '../components.jsx';
import { MathText } from '../mathText.jsx';

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
  const storageKey = 'testit-attempt-' + assignmentId; // browser-side resume, no server load

  const [preview, setPreview] = useState(null); // instructions metadata (no attempt created yet)
  const [data, setData] = useState(null);       // { test, questions, durationMinutes, remainingSeconds }
  const [beginning, setBeginning] = useState(false);
  const [msg, setMsg] = useState('');
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState({});   // { questionId: value }
  const [remaining, setRemaining] = useState(null);
  const [result, setResult] = useState(null);   // { autoScore, maxScore, needsGrading, auto }
  const [confirmSubmit, setConfirmSubmit] = useState(false); // in-app submit confirmation
  const [marked, setMarked] = useState(() => new Set());   // question ids flagged for review
  const [visited, setVisited] = useState(() => new Set()); // question indices seen at least once
  const submitting = useRef(false);
  const intervalRef = useRef(null);

  // --- Proctoring state ---
  const violationsRef = useRef(0);
  const [violationMsg, setViolationMsg] = useState('');
  const [outOfFs, setOutOfFs] = useState(false);
  const [started, setStarted] = useState(false); // proctored start gate (fullscreen)
  const testMeta = (data && data.test) || (preview && preview.test) || null;
  const proctored = !!(testMeta && testMeta.proctored);
  const maxV = (testMeta && testMeta.max_violations) || 3;

  // First load only the instructions (no attempt / no timer yet).
  useEffect(() => {
    if (!user) return;
    api('/api/take/' + assignmentId + '?preview=1')
      .then((d) => {
        setPreview(d);
        // A non-proctored test already in progress resumes straight in (the
        // student clicked "Resume"). Proctored tests show the gate so the
        // student re-enters fullscreen with a click.
        if (d.inProgress && !(d.test && d.test.proctored)) beginTest();
      })
      .catch((e) => setMsg(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Create the attempt (starts the timer) and load the questions.
  async function beginTest() {
    if (beginning) return;
    setBeginning(true); setMsg('');
    try {
      if (proctored) await requestFs();
      const d = await api('/api/take/' + assignmentId);
      setData(d);
      // Resume answers/position from the browser (survives refresh on this device).
      let saved = null;
      try { const raw = localStorage.getItem(storageKey); if (raw) saved = JSON.parse(raw); } catch { /* ignore */ }
      const ans = (saved && saved.answers) || {};
      const idx = saved && Number.isInteger(saved.current) ? saved.current : 0;
      if (Object.keys(ans).length) setAnswers(ans);
      if (saved && Array.isArray(saved.marked)) setMarked(new Set(saved.marked));
      if (saved && Array.isArray(saved.visited)) setVisited(new Set(saved.visited));
      if (d.questions) setCurrent(Math.max(0, Math.min(idx, d.questions.length - 1)));
      if (d.durationMinutes > 0 && d.remainingSeconds != null) setRemaining(d.remainingSeconds);
      setStarted(true);
    } catch (e) { setMsg(e.message); }
    finally { setBeginning(false); }
  }

  // Persist answers + position + review flags to the browser only (no server writes).
  useEffect(() => {
    if (!data || result) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ answers, current, marked: [...marked], visited: [...visited] })); } catch { /* ignore */ }
  }, [answers, current, marked, visited, data, result, storageKey]);

  // Track which questions the student has landed on (for the palette's
  // "not answered" vs "not visited" distinction).
  useEffect(() => {
    if (!data) return;
    setVisited((prev) => (prev.has(current) ? prev : new Set(prev).add(current)));
  }, [current, data]);

  async function requestFs() {
    try { await document.documentElement.requestFullscreen(); } catch { /* best effort */ }
  }

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
    setConfirmSubmit(false);
    submitting.current = true;
    clearInterval(intervalRef.current);
    try {
      const payload = {};
      data.questions.forEach((q) => { payload[q.id] = answers[q.id] ?? ''; });
      const r = await api('/api/submit/' + assignmentId, 'POST', { answers: payload, violations: violationsRef.current });
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
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
            <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
              <Link className="btn secondary" to={'/review?a=' + assignmentId}>Review my answers</Link>
              <Link className="btn" to="/student">Back to my tests</Link>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (msg && !preview && !data) return (<>{bar}<div className="container"><Msg text={msg} /></div></>);
  if (!preview && !data) return (<>{bar}<div className="container"><div className="card"><p className="muted">Loading…</p></div></div></>);

  // Instructions screen — shown until the student clicks Begin (which creates the
  // attempt and, for timed tests, starts the countdown). Also the proctoring gate.
  if (!data) {
    const t = preview.test;
    const beginLabel = preview.inProgress ? 'Resume test' : proctored ? 'Start test in fullscreen' : 'Begin test';
    return (
      <>
        {bar}
        <div className="container">
          <div className="card">
            <h1 style={{ marginTop: 0 }}>{proctored ? '🔒 ' : ''}{t.title}</h1>
            {t.description && <p style={{ marginTop: 4 }}>{t.description}</p>}
            <h3 style={{ margin: '16px 0 8px' }}>Before you begin</h3>
            <ul style={{ color: 'var(--muted)', lineHeight: 1.9, marginTop: 0 }}>
              <li><b>{preview.questionCount}</b> question(s) · <b>{preview.totalMarks}</b> total marks.</li>
              {preview.durationMinutes > 0
                ? <li>Time limit: <b>{preview.durationMinutes} minute(s)</b>. The timer starts the moment you click <b>{beginLabel}</b>.</li>
                : <li>No time limit — take as long as you need.</li>}
              {t.due_date && <li>Deadline: <b>{fmtDateTime(t.due_date)}</b>.</li>}
              {preview.slotCloseAt && <li>Your slot closes at <b>{fmtDateTime(preview.slotCloseAt)}</b> — submit before then.</li>}
              <li>Use <b>Previous / Next</b> to move between questions. Your answers are kept as you navigate.</li>
              <li>You can <b>submit only once</b>, and can't change answers after submitting.</li>
              {t.negative_marking
                ? <li style={{ color: '#92400e' }}>⚠️ <b>Negative marking is ON</b>: {t.penalty} mark(s) deducted per wrong multiple-choice / multiple-answer / true-false answer. Blank answers cost nothing.</li>
                : null}
            </ul>
            {proctored && (
              <div className="msg" style={{ background: '#fef3c7', color: '#92400e' }}>
                <b>🔒 This is a proctored test.</b> It runs in fullscreen and monitors for cheating:
                <ul style={{ margin: '6px 0 0', lineHeight: 1.8 }}>
                  <li>Stay in <b>fullscreen</b> — leaving it counts as a violation.</li>
                  <li>Do <b>not</b> switch tabs or windows. Copy, paste and right-click are disabled.</li>
                  <li>After <b>{maxV}</b> violations the test auto-submits, and every violation is recorded for your teacher.</li>
                </ul>
              </div>
            )}
            <Msg text={msg} />
            <div className="row" style={{ marginTop: 16, gap: 10 }}>
              <button className="btn" onClick={beginTest} disabled={beginning}>{beginning ? 'Starting…' : beginLabel}</button>
              <Link className="btn ghost" to="/student">Cancel</Link>
            </div>
          </div>
        </div>
      </>
    );
  }

  const { test, questions } = data;
  const q = questions[current];
  const last = current === questions.length - 1;
  const isAnswered = (qq) => { const v = answers[qq.id]; return v != null && v !== '' && v !== '[]'; };
  const blankCount = questions.filter((qq) => !isAnswered(qq)).length;
  const answeredCount = questions.length - blankCount;
  const markedCount = questions.filter((qq) => marked.has(qq.id)).length;
  const timed = data.durationMinutes > 0 && remaining != null;
  const mm = Math.floor((remaining || 0) / 60);
  const ss = String((remaining || 0) % 60).padStart(2, '0');

  // Review flags + response controls for the current question.
  const isMarkedCurrent = !!(q && marked.has(q.id));
  const toggleMark = () => { if (!q) return; setMarked((prev) => { const n = new Set(prev); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; }); };
  const clearResponse = () => { if (!q) return; setAnswers((a) => { const n = { ...a }; delete n[q.id]; return n; }); };

  // Palette status → colour. Mirrors the familiar exam-hall legend.
  const PAL = {
    answered: { bg: '#16a34a', fg: '#fff', label: 'Answered' },
    'not-answered': { bg: '#dc2626', fg: '#fff', label: 'Not answered' },
    marked: { bg: '#7c3aed', fg: '#fff', label: 'Marked for review' },
    'answered-marked': { bg: '#7c3aed', fg: '#fff', label: 'Answered & marked' },
    'not-visited': { bg: '#e5e7eb', fg: '#334155', label: 'Not visited' },
  };
  const statusOf = (i) => {
    const qq = questions[i];
    const ans = isAnswered(qq);
    const mk = marked.has(qq.id);
    if (ans && mk) return 'answered-marked';
    if (mk) return 'marked';
    if (ans) return 'answered';
    if (visited.has(i)) return 'not-answered';
    return 'not-visited';
  };

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

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '3 1 420px', minWidth: 0 }}>
        <div className="q-card">
          {q.section && <div className="pill brand" style={{ marginBottom: 8 }}>{q.section}</div>}
          <h3>Q{current + 1}. <MathText text={q.prompt} /> <span className="muted">({q.points} pt)</span>
            {isMarkedCurrent && <span className="pill" style={{ background: '#ede9fe', color: '#6d28d9', marginLeft: 8 }}>🚩 Marked for review</span>}
          </h3>
          {q.image && <img src={q.image} alt="" style={{ maxWidth: '100%', maxHeight: 260, border: '1px solid var(--line)', borderRadius: 8, display: 'block', marginBottom: 10 }} />}
          {q.type === 'mcq' && q.options.map((opt, idx) => (
            <label className="choice" key={idx}>
              <input type="radio" name={'q' + q.id} checked={answers[q.id] === String(idx)} onChange={() => setAnswer(q.id, String(idx))} /> <MathText text={opt} />
            </label>
          ))}
          {q.type === 'multi' && (
            <>
              <p className="muted" style={{ margin: '0 0 8px' }}>Select all that apply.</p>
              {q.options.map((opt, idx) => (
                <label className="choice" key={idx}>
                  <input type="checkbox" checked={parseSel(answers[q.id]).includes(idx)} onChange={() => toggleMulti(q.id, idx)} /> <MathText text={opt} />
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
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button className={'btn small' + (isMarkedCurrent ? '' : ' secondary')} type="button" onClick={toggleMark}>
              {isMarkedCurrent ? '🚩 Unmark review' : '🚩 Mark for review'}
            </button>
            <button className="btn ghost small" type="button" onClick={clearResponse} disabled={!isAnswered(q)}>Clear response</button>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <button className="btn ghost" type="button" disabled={current === 0} onClick={() => setCurrent((c) => Math.max(0, c - 1))}>← Previous</button>
            <span className="muted">Question {current + 1} of {questions.length}</span>
            {last
              ? <button className="btn" type="button" onClick={() => setConfirmSubmit(true)}>Submit test</button>
              : <button className="btn" type="button" onClick={() => setCurrent((c) => Math.min(questions.length - 1, c + 1))}>Next →</button>}
          </div>
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
            Jump to any question from the palette. Your answers are kept as you navigate. You can only submit once.
          </p>
        </div>
        </div>{/* end question column */}

        {/* Question palette — jump anywhere, see what's answered / marked. */}
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div className="card" style={{ position: 'sticky', top: 12 }}>
            <h3 style={{ marginTop: 0, fontSize: 16 }}>Questions</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {questions.map((qq, i) => {
                const st = statusOf(i);
                const c = PAL[st];
                const isCur = i === current;
                return (
                  <button key={qq.id} type="button" onClick={() => setCurrent(i)}
                    title={`Q${i + 1} — ${c.label}`}
                    style={{ position: 'relative', width: 38, height: 38, borderRadius: 8, fontWeight: 700, cursor: 'pointer',
                      background: c.bg, color: c.fg, border: isCur ? '3px solid #111827' : '1px solid rgba(0,0,0,.12)' }}>
                    {i + 1}
                    {st === 'answered-marked' && (
                      <span style={{ position: 'absolute', top: -4, right: -4, width: 13, height: 13, borderRadius: '50%', background: '#16a34a', border: '2px solid #fff' }} />
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: 14, display: 'grid', gap: 6, fontSize: 12 }}>
              {['answered', 'not-answered', 'marked', 'answered-marked', 'not-visited'].map((k) => (
                <div key={k} className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 16, height: 16, borderRadius: 4, background: PAL[k].bg, border: '1px solid rgba(0,0,0,.12)', display: 'inline-block' }} />
                  <span className="muted">{PAL[k].label}</span>
                </div>
              ))}
            </div>
            <p className="muted" style={{ margin: '12px 0 0', fontSize: 13 }}>
              <b>{answeredCount}</b> answered · <b>{markedCount}</b> marked · <b>{blankCount}</b> left
            </p>
            {last
              ? <button className="btn" type="button" style={{ marginTop: 12, width: '100%' }} onClick={() => setConfirmSubmit(true)}>Submit test</button>
              : <button className="btn secondary" type="button" style={{ marginTop: 12, width: '100%' }} onClick={() => setConfirmSubmit(true)}>Submit test</button>}
          </div>
        </div>
        </div>{/* end question + palette row */}
      </div>

      {confirmSubmit && (
        <Modal title="Submit your test?" onClose={() => setConfirmSubmit(false)}>
          <p style={{ marginTop: 0 }}>Once you submit, you <b>can't change your answers</b>.</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="pill green">{answeredCount} answered</span>
            {blankCount > 0 && <span className="pill amber">{blankCount} unanswered</span>}
            {markedCount > 0 && <span className="pill" style={{ background: '#ede9fe', color: '#6d28d9' }}>{markedCount} marked for review</span>}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
            <button className="btn ghost" type="button" onClick={() => setConfirmSubmit(false)}>Keep working</button>
            <button className="btn" type="button" onClick={() => doSubmit(false)}>Submit now</button>
          </div>
        </Modal>
      )}
    </>
  );
}
