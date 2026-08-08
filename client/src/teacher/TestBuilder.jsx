import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg } from '../components.jsx';

const blankQuestion = (type) => ({
  type,
  prompt: '',
  options: type === 'mcq' || type === 'multi' ? ['', '', '', ''] : [],
  correct: type === 'mcq' ? 0 : type === 'multi' ? [] : type === 'truefalse' ? 'true' : '',
  points: 1,
  image: '',
  section: '',
});
const TYPE_LABEL = { mcq: 'Multiple choice', multi: 'Multiple answers', truefalse: 'True / False', short: 'Short answer' };

// Parse a stored multi-answer key ("[0,2]") into an array of numbers.
const parseCorrectSet = (raw) => {
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; }
};

export default function TestBuilder({ editId, onSaved, onCancel }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('');
  const [negativeMarking, setNegativeMarking] = useState(false);
  const [penalty, setPenalty] = useState(1);
  const [sections, setSections] = useState([]); // e.g. ['Quantitative Aptitude', 'Physics']
  const [newSection, setNewSection] = useState('');
  const [questions, setQuestions] = useState([blankQuestion('multi')]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!editId) return;
    api('/api/tests/' + editId).then(({ test, questions }) => {
      setTitle(test.title);
      setDescription(test.description || '');
      setDueDate(test.due_date || '');
      setDurationMinutes(test.duration_minutes || '');
      setNegativeMarking(!!test.negative_marking);
      setPenalty(test.penalty > 0 ? test.penalty : 1);
      const qs = questions.map((q) => ({
        type: q.type,
        prompt: q.prompt,
        options: q.type === 'mcq' || q.type === 'multi' ? q.options : [],
        correct: q.type === 'mcq' ? Number(q.correct_answer)
          : q.type === 'multi' ? parseCorrectSet(q.correct_answer)
          : q.type === 'truefalse' ? q.correct_answer : '',
        points: q.points,
        image: q.image_url || '',
        section: q.section || '',
      }));
      setQuestions(qs);
      // Rebuild the section list from whatever sections the questions use (in order of first appearance).
      const seen = [];
      qs.forEach((q) => { if (q.section && !seen.includes(q.section)) seen.push(q.section); });
      setSections(seen);
    });
  }, [editId]);

  const updateQ = (i, patch) => setQuestions((qs) => qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  const removeQ = (i) => setQuestions((qs) => qs.filter((_, idx) => idx !== i));
  const addQ = (type) => setQuestions((qs) => [...qs, blankQuestion(type)]);
  const setOption = (qi, oi, val) => updateQ(qi, { options: questions[qi].options.map((o, idx) => (idx === oi ? val : o)) });
  const addOption = (qi) => updateQ(qi, { options: [...questions[qi].options, ''] });

  function addSection() {
    const name = newSection.trim();
    if (!name) return;
    if (!sections.includes(name)) setSections((s) => [...s, name]);
    setNewSection('');
  }
  function removeSection(name) {
    setSections((s) => s.filter((x) => x !== name));
    // Un-assign this section from any question that used it.
    setQuestions((qs) => qs.map((q) => (q.section === name ? { ...q, section: '' } : q)));
  }

  async function uploadImage(qi, file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('Image must be 5 MB or smaller.'); return; }
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file.'));
        r.readAsDataURL(file);
      });
      const { url } = await api('/api/upload', 'POST', { dataUrl });
      updateQ(qi, { image: url });
    } catch (e) { alert(e.message); }
  }

  async function save() {
    setMsg('');
    // For MCQ/multi, drop blank choices and remap the correct index/indices to
    // the kept list (indices must line up with the options actually stored).
    const clean = questions.map((q) => {
      if (q.type === 'mcq') {
        const kept = [];
        let correct = -1;
        q.options.forEach((v, idx) => { if (v.trim() !== '') { if (idx === Number(q.correct)) correct = kept.length; kept.push(v); } });
        return { ...q, options: kept, correct };
      }
      if (q.type === 'multi') {
        const kept = [];
        const correct = [];
        const chosen = new Set((q.correct || []).map(Number));
        q.options.forEach((v, idx) => { if (v.trim() !== '') { if (chosen.has(idx)) correct.push(kept.length); kept.push(v); } });
        return { ...q, options: kept, correct };
      }
      return q;
    });
    const payload = {
      title, description, dueDate,
      durationMinutes: Number(durationMinutes) || 0,
      negativeMarking, penalty, questions: clean,
    };
    try {
      if (editId) await api('/api/tests/' + editId, 'PUT', payload);
      else await api('/api/tests', 'POST', payload);
      onSaved();
    } catch (e) { setMsg(e.message); }
  }

  return (
    <div className="card">
      <h1>{editId ? 'Edit test' : 'Create a new test'}</h1>
      {editId && (
        <div className="msg" style={{ background: '#fef3c7', color: '#92400e' }}>
          You are editing an existing test. Existing student submissions are preserved with their original questions; your changes apply only to students who haven't taken it yet.
        </div>
      )}
      <Msg text={msg} />
      <label>Test title</label>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Chapter 1 Quiz" />
      <label>Description (optional)</label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Instructions for students..." />

      <label>End date &amp; time (optional deadline)</label>
      <input type="datetime-local" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={{ width: 'auto' }} />
      <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>After this moment, students can no longer open or submit the test. Leave blank for no deadline.</p>

      <label>Time limit in minutes (optional timer)</label>
      <input type="number" min="0" step="1" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} placeholder="0 = no timer" style={{ width: 180 }} />
      <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>Each student's timer starts when they open the test and it auto-submits when time runs out. Leave 0 for no timer.</p>

      <div className="q-card" style={{ marginTop: 16 }}>
        <label className="choice" style={{ fontWeight: 600 }}>
          <input type="checkbox" checked={negativeMarking} onChange={(e) => setNegativeMarking(e.target.checked)} />
          Enable negative marking (deduct marks for wrong answers)
        </label>
        {negativeMarking && (
          <div style={{ marginTop: 8 }}>
            <label>Marks deducted per wrong answer</label>
            <input type="number" min="1" step="1" value={penalty} onChange={(e) => setPenalty(Number(e.target.value) || 1)} style={{ width: 120 }} />
            <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
              Applies to multiple-choice, multiple-answer &amp; true/false questions. Blank answers are never penalized. A student's total can go negative.
            </p>
          </div>
        )}
      </div>

      <div className="q-card" style={{ marginTop: 16 }}>
        <label style={{ fontWeight: 600 }}>Sections (optional)</label>
        <p className="muted" style={{ fontSize: 13, margin: '2px 0 8px' }}>
          Group questions into sections like Quantitative Aptitude, Physics or Chemistry, then pick a section for each question below.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input type="text" value={newSection} onChange={(e) => setNewSection(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSection(); } }}
            placeholder="e.g. Quantitative Aptitude" style={{ flex: 1 }} />
          <button className="btn secondary small" type="button" onClick={addSection}>+ Add section</button>
        </div>
        {sections.length > 0 && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {sections.map((s) => (
              <span key={s} className="pill brand" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {s}
                <button type="button" onClick={() => removeSection(s)}
                  title="Remove section" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700, lineHeight: 1 }}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      <h2 style={{ marginTop: 22 }}>Questions</h2>
      {questions.map((q, i) => (
        <div className="q-card" key={i}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="pill brand">{TYPE_LABEL[q.type]}</span>
            <button className="btn danger small" onClick={() => removeQ(i)}>Remove</button>
          </div>
          {sections.length > 0 && (
            <>
              <label>Section</label>
              <select value={q.section || ''} onChange={(e) => updateQ(i, { section: e.target.value })} style={{ width: 'auto' }}>
                <option value="">— No section —</option>
                {sections.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </>
          )}
          <label>Question text</label>
          <textarea value={q.prompt} onChange={(e) => updateQ(i, { prompt: e.target.value })} placeholder="Type the question..." />

          <label>Image (optional)</label>
          {q.image ? (
            <div style={{ marginTop: 8 }}>
              <img src={q.image} alt="" style={{ maxWidth: 240, maxHeight: 180, border: '1px solid var(--line)', borderRadius: 8, display: 'block' }} />
              <button className="btn danger small" style={{ marginTop: 6 }} onClick={() => updateQ(i, { image: '' })}>Remove image</button>
            </div>
          ) : (
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => uploadImage(i, e.target.files[0])} />
          )}

          {q.type === 'mcq' && (
            <>
              <label>Choices (select the correct one)</label>
              {q.options.map((opt, oi) => (
                <div className="row" key={oi} style={{ marginBottom: 6 }}>
                  <input type="radio" name={'correct-' + i} checked={Number(q.correct) === oi} onChange={() => updateQ(i, { correct: oi })} style={{ width: 'auto' }} />
                  <input type="text" value={opt} onChange={(e) => setOption(i, oi, e.target.value)} placeholder={'Choice ' + (oi + 1)} style={{ flex: 1 }} />
                </div>
              ))}
              <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => addOption(i)}>+ Add choice</button>
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
                      if (cur.has(oi)) cur.delete(oi); else cur.add(oi);
                      updateQ(i, { correct: [...cur].sort((a, b) => a - b) });
                    }} style={{ width: 'auto' }} />
                    <input type="text" value={opt} onChange={(e) => setOption(i, oi, e.target.value)} placeholder={'Choice ' + (oi + 1)} style={{ flex: 1 }} />
                  </div>
                );
              })}
              <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => addOption(i)}>+ Add choice</button>
              <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>Students see checkboxes and may pick more than one. Full marks only if they select exactly the ticked answers.</p>
            </>
          )}
          {q.type === 'truefalse' && (
            <>
              <label>Correct answer</label>
              <select value={q.correct} onChange={(e) => updateQ(i, { correct: e.target.value })}>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            </>
          )}
          {q.type === 'short' && (
            <p className="muted" style={{ fontSize: 13 }}>Students type a written answer. You grade it later.</p>
          )}
          <label>Points</label>
          <input type="number" min="1" value={q.points} onChange={(e) => updateQ(i, { points: Number(e.target.value) || 1 })} style={{ width: 100 }} />
        </div>
      ))}

      <div className="row">
        <button className="btn secondary small" onClick={() => addQ('multi')}>+ Multiple answers</button>
        <button className="btn secondary small" onClick={() => addQ('truefalse')}>+ True / False</button>
        <button className="btn secondary small" onClick={() => addQ('short')}>+ Short answer</button>
      </div>
      <div className="row" style={{ marginTop: 22 }}>
        <button className="btn" onClick={save}>{editId ? 'Update test' : 'Save test'}</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
