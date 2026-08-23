import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { Msg, DateTime12 } from '../components.jsx';
import { useAlert } from '../confirm.jsx';
import { BankPicker } from './QuestionBank.jsx';
import { MathText } from '../mathText.jsx';
import DrawingPad from './DrawingPad.jsx';
import RichMathInput from './RichMathInput.jsx';

const TYPE_LABEL = { mcq: 'Single choice', multi: 'Multiple answers', truefalse: 'True / False', short: 'Short answer' };
const parseCorrectSet = (raw) => { try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; } };

const blankQuestion = (type, points = 1) => ({
  type,
  prompt: '',
  options: type === 'mcq' || type === 'multi' ? ['', '', '', ''] : [],
  correct: type === 'mcq' ? 0 : type === 'multi' ? [] : type === 'truefalse' ? 'true' : '',
  points,
  image: '',
  section: '',
  explanation: '',
});

// A resumable, one-question-per-page test builder. New tests auto-save as a
// server draft; editing an existing test saves only on Publish.
export default function TestBuilder({ editId, draftId: propDraftId, onSaved, onCancel }) {
  const alert = useAlert();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [requiresSlot, setRequiresSlot] = useState(false);
  const [slots, setSlots] = useState([]); // { id?, at, capacity }
  const [durationMinutes, setDurationMinutes] = useState('');
  const [negativeMarking, setNegativeMarking] = useState(false);
  const [penalty, setPenalty] = useState(1);
  const [proctored, setProctored] = useState(false);
  const [maxViolations, setMaxViolations] = useState(3);
  const [defaultPoints, setDefaultPoints] = useState(1);
  const [sections, setSections] = useState([]);
  const [newSection, setNewSection] = useState('');
  const [questions, setQuestions] = useState([blankQuestion('mcq', 1)]);
  const [page, setPage] = useState(0); // 0 = details, 1..N = questions, N+1 = review
  const [msg, setMsg] = useState('');
  const [draftId, setDraftId] = useState(propDraftId || null);
  const [ready, setReady] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [showBank, setShowBank] = useState(false);
  const [bankMsg, setBankMsg] = useState('');
  const [showDraw, setShowDraw] = useState(false);
  const savingRef = useRef(false);
  const lastSnapRef = useRef(null);

  const isDraftMode = !editId; // editing a live test does not auto-save drafts

  // ---- Load an existing test (edit) or a saved draft (resume) ----
  useEffect(() => {
    let alive = true;
    async function loadEdit() {
      const { test, questions: qs, slots: sl } = await api('/api/tests/' + editId);
      if (!alive) return;
      setTitle(test.title); setDescription(test.description || '');
      setDueDate(test.due_date || ''); setDurationMinutes(test.duration_minutes || '');
      setStartsAt(test.starts_at || ''); setRequiresSlot(!!test.requires_slot);
      setSlots(Array.isArray(sl) ? sl.map((s) => ({ id: s.id, at: s.at, capacity: s.capacity })) : []);
      setNegativeMarking(!!test.negative_marking); setPenalty(test.penalty > 0 ? test.penalty : 1);
      setProctored(!!test.proctored); setMaxViolations(test.max_violations > 0 ? test.max_violations : 3);
      const mapped = qs.map((q) => ({
        type: q.type, prompt: q.prompt,
        options: q.type === 'mcq' || q.type === 'multi' ? q.options : [],
        correct: q.type === 'mcq' ? Number(q.correct_answer) : q.type === 'multi' ? parseCorrectSet(q.correct_answer) : q.type === 'truefalse' ? q.correct_answer : '',
        points: q.points, image: q.image_url || '', section: q.section || '', explanation: q.explanation || '',
      }));
      setQuestions(mapped.length ? mapped : [blankQuestion('mcq', 1)]);
      setDefaultPoints(mapped[0] ? mapped[0].points : 1);
      const secs = []; mapped.forEach((q) => { if (q.section && !secs.includes(q.section)) secs.push(q.section); });
      setSections(secs);
      setReady(true);
    }
    async function loadDraft() {
      const d = await api('/api/drafts/' + propDraftId);
      if (!alive) return;
      let s = {}; try { s = JSON.parse(d.data); } catch { /* ignore */ }
      setTitle(s.title || ''); setDescription(s.description || '');
      setDueDate(s.dueDate || ''); setDurationMinutes(s.durationMinutes || '');
      setStartsAt(s.startsAt || ''); setRequiresSlot(!!s.requiresSlot);
      setSlots(Array.isArray(s.slots) ? s.slots : []);
      setNegativeMarking(!!s.negativeMarking); setPenalty(s.penalty > 0 ? s.penalty : 1);
      setProctored(!!s.proctored); setMaxViolations(s.maxViolations > 0 ? s.maxViolations : 3);
      setDefaultPoints(s.defaultPoints > 0 ? s.defaultPoints : 1);
      setSections(Array.isArray(s.sections) ? s.sections : []);
      setQuestions(Array.isArray(s.questions) && s.questions.length ? s.questions : [blankQuestion('mcq', s.defaultPoints || 1)]);
      setPage(Number.isInteger(s.page) ? s.page : 0);
      setReady(true);
    }
    if (editId) loadEdit().catch((e) => setMsg(e.message));
    else if (propDraftId) loadDraft().catch((e) => setMsg(e.message));
    else setReady(true);
    return () => { alive = false; };
  }, [editId, propDraftId]);

  // ---- Auto-save (new/draft only), debounced, only after a real change ----
  const snapshot = JSON.stringify({ title, description, dueDate, startsAt, requiresSlot, slots, durationMinutes, negativeMarking, penalty, proctored, maxViolations, defaultPoints, sections, questions, page });
  // Content only (no page) — used to dismiss the edit-mode "Saved" tick on real edits, not on navigation.
  const contentSnap = JSON.stringify({ title, description, dueDate, startsAt, requiresSlot, slots, durationMinutes, negativeMarking, penalty, proctored, maxViolations, sections, questions });
  async function saveDraft() {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const t = title.trim() || 'Untitled test';
      if (draftId) await api('/api/drafts/' + draftId, 'PUT', { title: t, data: snapshot });
      else { const r = await api('/api/drafts', 'POST', { title: t, data: snapshot }); setDraftId(r.id); }
      setSavedAt(Date.now());
    } catch { /* ignore auto-save errors (e.g. read-only) */ }
    finally { savingRef.current = false; }
  }
  useEffect(() => {
    if (!isDraftMode || !ready) return;
    if (lastSnapRef.current === null) { lastSnapRef.current = snapshot; return; }
    if (snapshot === lastSnapRef.current) return;
    const timer = setTimeout(async () => { await saveDraft(); lastSnapRef.current = snapshot; }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, ready]);

  // In edit mode, dismiss the "✓ Saved" tick as soon as the teacher changes something.
  useEffect(() => { if (editId) setSavedAt(null); /* eslint-disable-next-line */ }, [contentSnap]);

  // ---- Helpers ----
  const updateQ = (i, patch) => setQuestions((qs) => qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  const setOption = (qi, oi, val) => updateQ(qi, { options: questions[qi].options.map((o, idx) => (idx === oi ? val : o)) });
  const addOption = (qi) => updateQ(qi, { options: [...questions[qi].options, ''] });
  function changeType(i, newType) {
    const keepOptions = (newType === 'multi' || newType === 'mcq');
    updateQ(i, {
      type: newType,
      options: keepOptions ? (questions[i].options.length ? questions[i].options : ['', '', '', '']) : [],
      correct: newType === 'mcq' ? 0 : newType === 'multi' ? [] : newType === 'truefalse' ? 'true' : '',
    });
  }
  function addQuestion() {
    setQuestions((qs) => { const n = [...qs, blankQuestion('mcq', Number(defaultPoints) || 1)]; setPage(n.length); return n; });
  }
  function addFromBank(newOnes) {
    setShowBank(false);
    if (!newOnes || !newOnes.length) return;
    setQuestions((qs) => { const n = [...qs, ...newOnes]; setPage(qs.length + 1); return n; });
  }
  async function saveToBank(i) {
    const cur = questions[i];
    if (!cur) return;
    try {
      await api('/api/bank', 'POST', { type: cur.type, prompt: cur.prompt, options: cur.options, correct: cur.correct, points: cur.points, explanation: cur.explanation, topic: cur.section || '', difficulty: '' });
      setBankMsg('✓ Saved to bank'); setTimeout(() => setBankMsg(''), 2500);
    } catch (e) { setBankMsg(e.message); }
  }
  // Changing the default also updates any question still on the previous default
  // (i.e. not individually overridden), so the first pre-created question follows it.
  function changeDefaultPoints(val) {
    const nv = Number(val) || 1;
    const prev = Number(defaultPoints);
    setQuestions((qs) => qs.map((q) => (Number(q.points) === prev ? { ...q, points: nv } : q)));
    setDefaultPoints(nv);
  }
  function removeQuestion(i) {
    setQuestions((qs) => {
      if (qs.length <= 1) return qs;
      const n = qs.filter((_, idx) => idx !== i);
      setPage((p) => Math.min(p, n.length));
      return n;
    });
  }
  const addSlot = () => setSlots((sl) => [...sl, { at: '', capacity: 0 }]);
  const updateSlot = (i, patch) => setSlots((sl) => sl.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeSlot = (i) => setSlots((sl) => sl.filter((_, idx) => idx !== i));
  function addSection() { const name = newSection.trim(); if (name && !sections.includes(name)) setSections((s) => [...s, name]); setNewSection(''); }
  function removeSection(name) { setSections((s) => s.filter((x) => x !== name)); setQuestions((qs) => qs.map((q) => (q.section === name ? { ...q, section: '' } : q))); }
  // Save a PNG drawn on the pad: upload it and attach as the question image.
  async function saveDrawing(dataUrl) {
    setShowDraw(false);
    try {
      const { url } = await api('/api/upload', 'POST', { dataUrl });
      updateQ(qIndex, { image: url });
    } catch (e) { alert(e.message); }
  }
  function cleanQuestions() {
    return questions.map((q) => {
      if (q.type === 'multi') {
        const kept = []; const correct = []; const chosen = new Set((q.correct || []).map(Number));
        q.options.forEach((v, idx) => { if (v.trim() !== '') { if (chosen.has(idx)) correct.push(kept.length); kept.push(v); } });
        return { ...q, options: kept, correct };
      }
      if (q.type === 'mcq') {
        const kept = []; let correct = -1;
        q.options.forEach((v, idx) => { if (v.trim() !== '') { if (idx === Number(q.correct)) correct = kept.length; kept.push(v); } });
        return { ...q, options: kept, correct };
      }
      return q;
    });
  }
  function buildPayload() {
    return {
      title, description, dueDate, startsAt,
      durationMinutes: Number(durationMinutes) || 0,
      requiresSlot,
      slots: requiresSlot ? slots.filter((s) => s.at).map((s) => ({ id: s.id, at: s.at, capacity: Number(s.capacity) || 0 })) : [],
      negativeMarking, penalty,
      proctored, maxViolations: Number(maxViolations) || 3,
      questions: cleanQuestions(),
    };
  }
  async function publish() {
    setMsg('');
    try {
      if (editId) await api('/api/tests/' + editId, 'PUT', buildPayload());
      else await api('/api/tests', 'POST', buildPayload());
      if (draftId) { try { await api('/api/drafts/' + draftId, 'DELETE'); } catch { /* ignore */ } }
      onSaved();
    } catch (e) { setMsg(e.message); }
  }
  // Save the edits to the server without leaving the wizard (edit mode only).
  async function saveEdit() {
    setMsg('');
    try { await api('/api/tests/' + editId, 'PUT', buildPayload()); setSavedAt(Date.now()); }
    catch (e) { setMsg(e.message); }
  }
  // Auto-save on Next (edit mode). Silent on validation errors so navigation stays
  // smooth while a question is still being filled in; the explicit Save surfaces them.
  async function autoSaveOnNext() {
    if (!editId) return;
    try { await api('/api/tests/' + editId, 'PUT', buildPayload()); setSavedAt(Date.now()); }
    catch { /* ignore — an incomplete question just won't save until it's valid */ }
  }

  // ---- Render ----
  const total = questions.length;
  const onHeader = page === 0;
  const onReview = page === total + 1;
  const qIndex = onHeader || onReview ? -1 : page - 1;
  const q = qIndex >= 0 ? questions[qIndex] : null;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>{editId ? 'Edit test' : 'Create a test'}</h1>
        {isDraftMode && <span className="pill gray">{draftId ? (savedAt ? '✓ Draft saved' : 'Saving…') : 'Auto-saves as you go'}</span>}
        {editId && (
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            {savedAt && <span className="pill green">✓ Saved</span>}
            <button className="btn small" type="button" onClick={saveEdit}>💾 Save</button>
          </div>
        )}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        {onHeader ? 'Step 1 — Test details (applies to the whole test)' : onReview ? `Review — ${total} question(s)` : `Question ${page} of ${total}`}
      </p>
      <Msg text={msg} />

      {/* ---------------- DETAILS PAGE ---------------- */}
      {onHeader && (
        <>
          <label>Test title</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Chapter 1 Quiz" />
          <label>Description (optional)</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Instructions for students..." />

          <label>Start date &amp; time (optional — when the test opens)</label>
          <DateTime12 value={startsAt} onChange={setStartsAt} />

          <label>End date &amp; time (optional deadline)</label>
          <DateTime12 value={dueDate} onChange={setDueDate} />

          <label>Time limit in minutes (optional timer)</label>
          <input type="number" min="0" step="1" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} placeholder="0 = no timer" style={{ width: 180 }} />

          <label>Default marks per question</label>
          <input type="number" min="1" step="1" value={defaultPoints} onChange={(e) => changeDefaultPoints(e.target.value)} style={{ width: 140 }} />
          <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>New questions use this value; you can still change an individual question's marks.</p>

          <div className="q-card" style={{ marginTop: 16 }}>
            <label className="choice" style={{ fontWeight: 600 }}>
              <input type="checkbox" checked={negativeMarking} onChange={(e) => setNegativeMarking(e.target.checked)} />
              Enable negative marking (deduct marks for wrong answers)
            </label>
            {negativeMarking && (
              <div style={{ marginTop: 8 }}>
                <label>Marks deducted per wrong answer</label>
                <input type="number" min="1" step="1" value={penalty} onChange={(e) => setPenalty(Number(e.target.value) || 1)} style={{ width: 120 }} />
              </div>
            )}
          </div>

          <div className="q-card" style={{ marginTop: 16 }}>
            <label className="choice" style={{ fontWeight: 600 }}>
              <input type="checkbox" checked={proctored} onChange={(e) => setProctored(e.target.checked)} />
              🔒 Enable proctoring (fullscreen + anti-cheating monitoring)
            </label>
            {proctored && (
              <div style={{ marginTop: 8 }}>
                <label>Auto-submit after this many violations</label>
                <input type="number" min="1" step="1" value={maxViolations} onChange={(e) => setMaxViolations(Number(e.target.value) || 1)} style={{ width: 120 }} />
              </div>
            )}
          </div>

          <div className="q-card" style={{ marginTop: 16 }}>
            <label className="choice" style={{ fontWeight: 600 }}>
              <input type="checkbox" checked={requiresSlot} onChange={(e) => setRequiresSlot(e.target.checked)} />
              🗓 Students book a time slot to appear
            </label>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
              Add the slots you want to offer; each student picks one and can only enter during that window.
              The window opens 30&nbsp;min before the slot and closes 30&nbsp;min after the slot plus the test's duration
              (so a short connection drop won't lock them out). Needs a time limit set above.
            </p>
            {requiresSlot && (
              <div style={{ marginTop: 12 }}>
                {!(Number(durationMinutes) > 0) && (
                  <p className="pill amber" style={{ display: 'inline-block' }}>Set a time limit above so each slot has a window.</p>
                )}
                {slots.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No slots yet — add at least one.</p>}
                {slots.map((s, i) => (
                  <div key={i} className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 260px' }}><DateTime12 value={s.at} onChange={(v) => updateSlot(i, { at: v })} /></div>
                    <label className="muted" style={{ fontSize: 13, margin: 0 }}>Seats
                      <input type="number" min="0" step="1" value={s.capacity} onChange={(e) => updateSlot(i, { capacity: Number(e.target.value) || 0 })}
                        title="0 = unlimited" placeholder="0 = ∞" style={{ width: 90, marginLeft: 6 }} />
                    </label>
                    <button className="btn danger small" type="button" onClick={() => removeSlot(i)}>Remove</button>
                  </div>
                ))}
                <button className="btn secondary small" type="button" onClick={addSlot}>+ Add slot</button>
              </div>
            )}
          </div>

          <div className="q-card" style={{ marginTop: 16 }}>
            <label style={{ fontWeight: 600 }}>Sections (optional)</label>
            <p className="muted" style={{ fontSize: 13, margin: '2px 0 8px' }}>Group questions (e.g. Quantitative Aptitude, Physics), then pick a section per question.</p>
            <div className="row" style={{ gap: 8 }}>
              <input type="text" value={newSection} onChange={(e) => setNewSection(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSection(); } }} placeholder="e.g. Physics" style={{ flex: 1 }} />
              <button className="btn secondary small" type="button" onClick={addSection}>+ Add section</button>
            </div>
            {sections.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {sections.map((s) => (
                  <span key={s} className="pill brand" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {s}<button type="button" onClick={() => removeSection(s)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700 }}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ---------------- QUESTION PAGE ---------------- */}
      {q && (
        <div className="q-card">
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 360px', minWidth: 0 }}>
          <label>Question type</label>
          <select value={q.type} onChange={(e) => changeType(qIndex, e.target.value)} style={{ width: 'auto' }}>
            <option value="mcq">Single choice (one correct)</option>
            <option value="multi">Multiple answers (one or more correct)</option>
            <option value="truefalse">True / False</option>
            <option value="short">Short answer</option>
          </select>

          <label>Question text</label>
          <RichMathInput value={q.prompt} onChange={(v) => updateQ(qIndex, { prompt: v })}
            placeholder="Type the question. For any maths, click ➕ Insert equation." />

          <label>Diagram (optional)</label>
          {q.image ? (
            <div style={{ marginTop: 8 }}>
              <img src={q.image} alt="" style={{ maxWidth: 240, maxHeight: 180, border: '1px solid var(--line)', borderRadius: 8, display: 'block' }} />
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <button className="btn ghost small" onClick={() => setShowDraw(true)}>✏️ Edit drawing</button>
                <button className="btn danger small" onClick={() => updateQ(qIndex, { image: '' })}>Remove</button>
              </div>
            </div>
          ) : (
            <button className="btn secondary small" type="button" onClick={() => setShowDraw(true)}>✏️ Draw a diagram</button>
          )}

          {sections.length > 0 && (
            <>
              <label>Section</label>
              <select value={q.section || ''} onChange={(e) => updateQ(qIndex, { section: e.target.value })} style={{ width: 'auto' }}>
                <option value="">— No section —</option>
                {sections.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </>
          )}

          {q.type === 'mcq' && (
            <>
              <label>Choices (select the correct one)</label>
              {q.options.map((opt, oi) => (
                <div className="row" key={oi} style={{ marginBottom: 6 }}>
                  <input type="radio" name={'correct-' + qIndex} checked={Number(q.correct) === oi} onChange={() => updateQ(qIndex, { correct: oi })} style={{ width: 'auto' }} />
                  <div style={{ flex: 1 }}><RichMathInput value={opt} onChange={(v) => setOption(qIndex, oi, v)} placeholder={'Choice ' + (oi + 1)} oneLine /></div>
                </div>
              ))}
              <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => addOption(qIndex)}>+ Add choice</button>
            </>
          )}
          {q.type === 'multi' && (
            <>
              <label>Choices (tick every correct answer)</label>
              {q.options.map((opt, oi) => {
                const chosen = Array.isArray(q.correct) && q.correct.map(Number).includes(oi);
                return (
                  <div className="row" key={oi} style={{ marginBottom: 6 }}>
                    <input type="checkbox" checked={chosen} onChange={() => {
                      const cur = new Set((q.correct || []).map(Number));
                      cur.has(oi) ? cur.delete(oi) : cur.add(oi);
                      updateQ(qIndex, { correct: [...cur].sort((a, b) => a - b) });
                    }} style={{ width: 'auto' }} />
                    <div style={{ flex: 1 }}><RichMathInput value={opt} onChange={(v) => setOption(qIndex, oi, v)} placeholder={'Choice ' + (oi + 1)} oneLine /></div>
                  </div>
                );
              })}
              <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => addOption(qIndex)}>+ Add choice</button>
            </>
          )}
          {q.type === 'truefalse' && (
            <>
              <label>Correct answer</label>
              <select value={q.correct} onChange={(e) => updateQ(qIndex, { correct: e.target.value })}>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            </>
          )}
          {q.type === 'short' && <p className="muted" style={{ fontSize: 13 }}>Students type a written answer. You grade it later.</p>}

          <label>Marks</label>
          <input type="number" min="1" value={q.points} onChange={(e) => updateQ(qIndex, { points: Number(e.target.value) || 1 })} style={{ width: 100 }} />

          <label>Explanation for the correct answer (optional)</label>
          <RichMathInput value={q.explanation} onChange={(v) => updateQ(qIndex, { explanation: v })}
            placeholder="Shown to students when they review the test." />

          <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 10 }}>
            <button className="btn ghost small" type="button" onClick={() => saveToBank(qIndex)}>💾 Save this question to the bank</button>
            {bankMsg && <span className="muted">{bankMsg}</span>}
          </div>
          </div>{/* end left (editor) column */}

          {/* Live preview — exactly how the question renders for students.
              Sticky right column so it stays in view while the teacher types. */}
          <div style={{ flex: '1 1 280px', minWidth: 0, position: 'sticky', top: 12, alignSelf: 'flex-start', padding: 12, background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>👁 Student preview</div>
            <div style={{ fontWeight: 600 }}>Q{page}. <MathText text={q.prompt || 'Your question will appear here.'} /></div>
            {q.image && <img src={q.image} alt="" style={{ maxWidth: '100%', maxHeight: 220, border: '1px solid var(--line)', borderRadius: 8, display: 'block', margin: '8px 0' }} />}
            {(q.type === 'mcq' || q.type === 'multi') && (
              <div style={{ marginTop: 6 }}>
                {q.options.filter((o) => o.trim() !== '').map((o, oi) => (
                  <div key={oi} style={{ margin: '2px 0' }}>{q.type === 'mcq' ? '◯' : '☐'} <MathText text={o} /></div>
                ))}
              </div>
            )}
            {q.explanation && <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>💡 <MathText text={q.explanation} /></div>}
          </div>{/* end right (preview) column */}
          </div>{/* end two-column layout */}
        </div>
      )}

      {/* ---------------- REVIEW PAGE ---------------- */}
      {onReview && (
        <div className="q-card">
          <h2 style={{ marginTop: 0 }}>{title || <span className="muted">Untitled test</span>}</h2>
          <p className="muted">{total} question(s) · {questions.reduce((n, x) => n + (Number(x.points) || 0), 0)} total marks</p>
          <table>
            <thead><tr><th>#</th><th>Type</th><th>Question</th><th>Marks</th></tr></thead>
            <tbody>
              {questions.map((x, i) => (
                <tr key={i} style={{ cursor: 'pointer' }} onClick={() => setPage(i + 1)}>
                  <td>{i + 1}</td>
                  <td>{TYPE_LABEL[x.type]}</td>
                  <td>{x.prompt ? x.prompt.slice(0, 60) : <span className="pill amber">no text</span>}</td>
                  <td>{x.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 13 }}>Click a row to jump back and edit it.</p>
        </div>
      )}

      {/* ---------------- NAV ---------------- */}
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 22 }}>
        <button className="btn ghost" type="button" onClick={() => (onHeader ? onCancel() : setPage((p) => p - 1))}>{onHeader ? 'Cancel' : '← Back'}</button>
        <div className="row">
          {q && <button className="btn danger small" type="button" onClick={() => removeQuestion(qIndex)} disabled={total <= 1}>Remove question</button>}
          {(q || onReview) && <button className="btn secondary" type="button" onClick={() => setShowBank(true)}>📚 Add from bank</button>}
          {(q || onReview) && <button className="btn secondary" type="button" onClick={addQuestion}>+ Add question</button>}
          {onReview
            ? <button className="btn" type="button" onClick={publish}>{editId ? 'Save changes' : 'Publish test'}</button>
            : <button className="btn" type="button" onClick={() => { autoSaveOnNext(); setPage((p) => Math.min(total + 1, p + 1)); }}>{page === total ? 'Review →' : 'Next →'}</button>}
        </div>
      </div>

      {showBank && <BankPicker onClose={() => setShowBank(false)} onAdd={addFromBank} />}
      {showDraw && q && <DrawingPad initial={q.image || null} onClose={() => setShowDraw(false)} onSave={saveDrawing} />}
    </div>
  );
}
