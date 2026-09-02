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
  const [showImport, setShowImport] = useState(false);
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
          {!readOnly && (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary small" onClick={() => setShowImport(true)}>⬆ Import CSV</button>
              <button className="btn" onClick={() => setEditing({ isNew: true })}>➕ Add question</button>
            </div>
          )}
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
      {showImport && (
        <BankImport onClose={() => setShowImport(false)}
          onDone={(r) => { setShowImport(false); setMsg({ ok: true, text: `Imported ${r.created} question(s)${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.` }); load(); }} />
      )}
    </>
  );
}

// --- Bulk CSV import -------------------------------------------------------
const csvEsc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function parseCSV(text) {
  return String(text).split(/\r?\n/).filter((l) => l.trim() !== '').map((line) => {
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  });
}
const typeAlias = (t) => {
  const s = String(t || '').trim().toLowerCase();
  if (/^(mcq|single|one correct)/.test(s)) return 'mcq';
  if (/^(multi|multiple)/.test(s)) return 'multi';
  if (/^(tf|true)/.test(s)) return 'truefalse';
  if (/^(short|subjective|numeric)/.test(s)) return 'short';
  return '';
};
const TEMPLATE_ROWS = [
  ['Type', 'Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct', 'Points', 'Topic', 'Difficulty', 'Explanation'],
  ['mcq', 'What is $2+2$?', '3', '4', '5', '6', 'B', '4', 'Arithmetic', 'Easy', '$2+2=4$'],
  ['multi', 'Which of these are prime?', '2', '3', '4', '5', 'A,B,D', '4', 'Numbers', 'Medium', ''],
  ['truefalse', 'The earth is flat.', '', '', '', '', 'False', '1', 'GK', 'Easy', ''],
  ['short', "State Newton's second law.", '', '', '', '', '', '4', 'Mechanics', 'Medium', ''],
];
const BANK_TEMPLATE = 'data:text/csv;charset=utf-8,' + encodeURIComponent(TEMPLATE_ROWS.map((r) => r.map(csvEsc).join(',')).join('\n') + '\n');

function BankImport({ onClose, onDone }) {
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  function onFile(file) {
    if (!file) return;
    setFileName(file.name); setMsg(''); setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const grid = parseCSV(reader.result);
      if (!grid.length) { setMsg('The file is empty.'); setRows([]); return; }
      const header = grid[0].map((h) => h.toLowerCase().trim());
      const hasHeader = header.some((h) => /type|question|prompt/.test(h));
      const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
      const cols = hasHeader ? {
        type: idx('type'), prompt: idx('question', 'prompt'),
        a: idx('option a', 'a', 'optiona'), b: idx('option b', 'b', 'optionb'), c: idx('option c', 'c', 'optionc'),
        d: idx('option d', 'd', 'optiond'), e: idx('option e', 'e', 'optione'), f: idx('option f', 'f', 'optionf'),
        correct: idx('correct', 'answer', 'correct answer'), points: idx('points', 'marks'),
        topic: idx('topic'), difficulty: idx('difficulty', 'level'), explanation: idx('explanation', 'solution'),
      } : { type: 0, prompt: 1, a: 2, b: 3, c: 4, d: 5, e: -1, f: -1, correct: 6, points: 7, topic: 8, difficulty: 9, explanation: 10 };
      const g = (row, i) => (i >= 0 && row[i] != null ? row[i] : '');
      const dataRows = hasHeader ? grid.slice(1) : grid;
      const qs = dataRows.map((c) => {
        const type = typeAlias(g(c, cols.type));
        const prompt = g(c, cols.prompt).trim();
        const optCells = [cols.a, cols.b, cols.c, cols.d, cols.e, cols.f].map((i) => g(c, i).trim());
        const options = []; const map = {};
        optCells.forEach((v, i) => { if (v) { map[String.fromCharCode(65 + i)] = options.length; options.push(v); } });
        const correctRaw = g(c, cols.correct).trim();
        let correct = '';
        if (type === 'mcq') { const byL = map[correctRaw.toUpperCase()]; correct = byL != null ? byL : (Number.isInteger(+correctRaw) && correctRaw !== '' ? +correctRaw - 1 : -1); }
        else if (type === 'multi') { correct = correctRaw.split(/[,;|/\s]+/).map((s) => map[s.trim().toUpperCase()]).filter((x) => x != null); }
        else if (type === 'truefalse') { correct = /^(t|true|1|yes)/i.test(correctRaw) ? 'true' : 'false'; }
        const points = parseInt(g(c, cols.points), 10);
        return { type, prompt, options, correct, points: Number.isInteger(points) && points > 0 ? points : 1, topic: g(c, cols.topic).trim(), difficulty: g(c, cols.difficulty).trim(), explanation: g(c, cols.explanation).trim() };
      }).filter((q) => q.type || q.prompt);
      if (!qs.length) setMsg('No questions found. Expected columns: Type, Question, Option A–D, Correct, Points, Topic, Difficulty, Explanation.');
      setRows(qs);
    };
    reader.onerror = () => setMsg('Could not read the file.');
    reader.readAsText(file);
  }

  async function submit() {
    if (!rows || !rows.length) return;
    setBusy(true); setMsg('');
    try { setResult(await api('/api/bank/bulk', 'POST', { questions: rows })); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Import questions from CSV" onClose={onClose} wide>
      {!result ? (
        <>
          <p className="muted">Upload a CSV with columns <b>Type, Question, Option A–D, Correct, Points, Topic, Difficulty, Explanation</b>. <b>Type</b> is <code>mcq</code>, <code>multi</code>, <code>truefalse</code>, or <code>short</code>; <b>Correct</b> is the option letter(s) — e.g. <code>B</code> or <code>A,C</code> — or True/False. Maths can use <code>$…$</code> LaTeX.</p>
          <p><a href={BANK_TEMPLATE} download="question-bank-template.csv">⬇ Download a template</a></p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files[0])} />
          {rows && <p className="muted" style={{ marginTop: 8 }}>{fileName}: <b>{rows.length}</b> question(s) ready to import.</p>}
          {msg && <Msg text={msg} />}
          <div className="row" style={{ marginTop: 16, gap: 10 }}>
            <button className="btn" disabled={!rows || !rows.length || busy} onClick={submit}>{busy ? 'Importing…' : `Import ${rows && rows.length ? rows.length : ''} question(s)`}</button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <Msg text={`Imported ${result.created} question(s)${result.skipped.length ? `, skipped ${result.skipped.length}.` : '.'}`} kind="ok" />
          {result.skipped.length > 0 && (
            <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
              <table style={{ width: '100%', fontSize: 13 }}>
                <thead><tr><th style={{ textAlign: 'left' }}>Skipped</th><th style={{ textAlign: 'left' }}>Reason</th></tr></thead>
                <tbody>{result.skipped.map((s, i) => <tr key={i}><td>{s.label}</td><td className="muted">{s.reason}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => onDone(result)}>Done</button>
          </div>
        </>
      )}
    </Modal>
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
