import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg, Modal } from '../components.jsx';
import { useConfirm } from '../confirm.jsx';

const TYPE_LABEL = { mcq: 'Single choice', multi: 'Multiple answers', truefalse: 'True / False', short: 'Short answer' };
const parseCorrectSet = (raw) => { try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; } };

// Convert a bank item (stored shape) into the editable/builder question shape.
export function bankToQuestion(b) {
  return {
    type: b.type, prompt: b.prompt,
    options: (b.type === 'mcq' || b.type === 'multi') ? b.options : [],
    correct: b.type === 'mcq' ? Number(b.correctAnswer) : b.type === 'multi' ? parseCorrectSet(b.correctAnswer) : b.type === 'truefalse' ? b.correctAnswer : '',
    points: b.points, image: b.image || '', section: '', explanation: b.explanation || '',
  };
}

function useBank(filters) {
  const [data, setData] = useState(null);
  const load = () => {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.topic) p.set('topic', filters.topic);
    if (filters.type) p.set('type', filters.type);
    return api('/api/bank' + (p.toString() ? '?' + p : '')).then(setData).catch(() => setData({ questions: [], topics: [] }));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters.q, filters.topic, filters.type]);
  return [data, load];
}

function Filters({ filters, setFilters, topics }) {
  return (
    <div className="row" style={{ gap: 8, marginTop: 8 }}>
      <input type="text" placeholder="🔍 Search question text..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} style={{ flex: 1 }} />
      <select value={filters.topic} onChange={(e) => setFilters({ ...filters, topic: e.target.value })} style={{ width: 'auto' }}>
        <option value="">All topics</option>
        {(topics || []).map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} style={{ width: 'auto' }}>
        <option value="">All types</option>
        <option value="mcq">Single choice</option>
        <option value="multi">Multiple answers</option>
        <option value="truefalse">True / False</option>
        <option value="short">Short answer</option>
      </select>
    </div>
  );
}

export default function QuestionBank({ readOnly }) {
  const confirm = useConfirm();
  const [filters, setFilters] = useState({ q: '', topic: '', type: '' });
  const [data, load] = useBank(filters);
  const [editing, setEditing] = useState(null); // editable question (+id) or { isNew:true }
  const [msg, setMsg] = useState(null);

  async function del(qid) {
    if (!(await confirm({ title: 'Delete question?', body: 'Delete this question from the bank?', confirmLabel: 'Delete', danger: true }))) return;
    await api('/api/bank/' + qid, 'DELETE'); load();
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0 }}>📚 Question Bank</h1>
          {!readOnly && <button className="btn" onClick={() => setEditing({ isNew: true })}>➕ Add question</button>}
        </div>
        <p className="muted">Reusable questions shared across your organization. Pull them into any test from the test builder.</p>
        {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
        <Filters filters={filters} setFilters={setFilters} topics={data?.topics} />
      </div>

      <div className="card">
        {data === null ? <p className="muted">Loading…</p> : data.questions.length === 0 ? (
          <p className="muted">No questions {filters.q || filters.topic || filters.type ? 'match your filters' : 'in the bank yet'}.</p>
        ) : (
          <table>
            <thead><tr><th>Question</th><th>Type</th><th>Topic</th><th>Difficulty</th><th>Marks</th>{!readOnly && <th></th>}</tr></thead>
            <tbody>
              {data.questions.map((q) => (
                <tr key={q.id}>
                  <td>{q.prompt.slice(0, 70)}{q.prompt.length > 70 ? '…' : ''}</td>
                  <td>{TYPE_LABEL[q.type]}</td>
                  <td>{q.topic || <span className="muted">—</span>}</td>
                  <td>{q.difficulty || <span className="muted">—</span>}</td>
                  <td>{q.points}</td>
                  {!readOnly && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn ghost small" onClick={() => setEditing({ ...bankToQuestion(q), topic: q.topic, difficulty: q.difficulty, id: q.id })}>Edit</button>
                      <button className="btn danger small" style={{ marginLeft: 6 }} onClick={() => del(q.id)}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <BankQuestionForm initial={editing.isNew ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => { setEditing(null); setMsg({ ok: true, text }); load(); }} />
      )}
    </>
  );
}

const blank = () => ({ type: 'mcq', prompt: '', options: ['', '', '', ''], correct: 0, points: 1, explanation: '', topic: '', difficulty: '' });

function BankQuestionForm({ initial, onClose, onSaved }) {
  const [q, setQ] = useState(initial ? { ...blank(), ...initial } : blank());
  const [msg, setMsg] = useState('');
  const up = (patch) => setQ((x) => ({ ...x, ...patch }));
  const setOpt = (i, v) => up({ options: q.options.map((o, idx) => (idx === i ? v : o)) });
  function changeType(type) {
    up({
      type,
      options: (type === 'mcq' || type === 'multi') ? (q.options.length ? q.options : ['', '', '', '']) : [],
      correct: type === 'mcq' ? 0 : type === 'multi' ? [] : type === 'truefalse' ? 'true' : '',
    });
  }
  async function save() {
    try {
      const payload = { type: q.type, prompt: q.prompt, options: q.options, correct: q.correct, points: Number(q.points) || 1, explanation: q.explanation, topic: q.topic, difficulty: q.difficulty };
      if (initial && initial.id) await api('/api/bank/' + initial.id, 'PUT', payload);
      else await api('/api/bank', 'POST', payload);
      onSaved(initial && initial.id ? 'Question updated.' : 'Question added to the bank.');
    } catch (e) { setMsg(e.message); }
  }
  return (
    <Modal title={initial && initial.id ? 'Edit question' : 'Add question to bank'} onClose={onClose} wide>
      <Msg text={msg} />
      <label>Type</label>
      <select value={q.type} onChange={(e) => changeType(e.target.value)} style={{ width: 'auto' }}>
        <option value="mcq">Single choice (one correct)</option>
        <option value="multi">Multiple answers (one or more correct)</option>
        <option value="truefalse">True / False</option>
        <option value="short">Short answer</option>
      </select>
      <label>Question text</label>
      <textarea value={q.prompt} onChange={(e) => up({ prompt: e.target.value })} placeholder="Type the question..." />

      {q.type === 'mcq' && (
        <>
          <label>Choices (select the correct one)</label>
          {q.options.map((o, i) => (
            <div className="row" key={i} style={{ marginBottom: 6 }}>
              <input type="radio" name="bankcorrect" checked={Number(q.correct) === i} onChange={() => up({ correct: i })} style={{ width: 'auto' }} />
              <input type="text" value={o} onChange={(e) => setOpt(i, e.target.value)} placeholder={'Choice ' + (i + 1)} style={{ flex: 1 }} />
            </div>
          ))}
          <button className="btn ghost small" onClick={() => up({ options: [...q.options, ''] })}>+ Add choice</button>
        </>
      )}
      {q.type === 'multi' && (
        <>
          <label>Choices (tick every correct answer)</label>
          {q.options.map((o, i) => {
            const chosen = Array.isArray(q.correct) && q.correct.map(Number).includes(i);
            return (
              <div className="row" key={i} style={{ marginBottom: 6 }}>
                <input type="checkbox" checked={chosen} onChange={() => { const s = new Set((q.correct || []).map(Number)); s.has(i) ? s.delete(i) : s.add(i); up({ correct: [...s].sort((a, b) => a - b) }); }} style={{ width: 'auto' }} />
                <input type="text" value={o} onChange={(e) => setOpt(i, e.target.value)} placeholder={'Choice ' + (i + 1)} style={{ flex: 1 }} />
              </div>
            );
          })}
          <button className="btn ghost small" onClick={() => up({ options: [...q.options, ''] })}>+ Add choice</button>
        </>
      )}
      {q.type === 'truefalse' && (
        <>
          <label>Correct answer</label>
          <select value={q.correct} onChange={(e) => up({ correct: e.target.value })}><option value="true">True</option><option value="false">False</option></select>
        </>
      )}
      {q.type === 'short' && <p className="muted" style={{ fontSize: 13 }}>Students type a written answer; you grade it later.</p>}

      <div className="grid two" style={{ marginTop: 8 }}>
        <div><label>Topic (optional)</label><input type="text" value={q.topic} onChange={(e) => up({ topic: e.target.value })} placeholder="e.g. Algebra" /></div>
        <div><label>Difficulty (optional)</label>
          <select value={q.difficulty} onChange={(e) => up({ difficulty: e.target.value })}>
            <option value="">—</option><option value="Easy">Easy</option><option value="Medium">Medium</option><option value="Hard">Hard</option>
          </select>
        </div>
        <div><label>Marks</label><input type="number" min="1" value={q.points} onChange={(e) => up({ points: Number(e.target.value) || 1 })} style={{ width: 100 }} /></div>
      </div>
      <label>Explanation (optional)</label>
      <textarea value={q.explanation} onChange={(e) => up({ explanation: e.target.value })} placeholder="Explain the correct answer (shown to students in review)." />

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// Picker used from the test builder to copy bank questions into a test.
export function BankPicker({ onClose, onAdd }) {
  const [filters, setFilters] = useState({ q: '', topic: '', type: '' });
  const [data] = useBank(filters);
  const [sel, setSel] = useState(new Set());
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Modal title="Add from question bank" onClose={onClose} wide>
      <Filters filters={filters} setFilters={setFilters} topics={data?.topics} />
      <div style={{ maxHeight: '48vh', overflowY: 'auto', marginTop: 12 }}>
        {data === null ? <p className="muted">Loading…</p> : data.questions.length === 0 ? <p className="muted">No questions found.</p> : data.questions.map((q) => (
          <label className="choice" key={q.id}>
            <input type="checkbox" checked={sel.has(q.id)} onChange={() => toggle(q.id)} />
            <span><b>{q.prompt.slice(0, 80)}{q.prompt.length > 80 ? '…' : ''}</b> <span className="muted">· {TYPE_LABEL[q.type]}{q.topic ? ' · ' + q.topic : ''} · {q.points} pt</span></span>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" disabled={sel.size === 0} onClick={() => onAdd((data?.questions || []).filter((x) => sel.has(x.id)).map(bankToQuestion))}>
          Add {sel.size || ''} question{sel.size === 1 ? '' : 's'}
        </button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
