import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Msg } from '../components.jsx';
import { MathText } from '../mathText.jsx';

// Format an answer value into readable text for a given question type.
function fmtAnswer(type, value, options) {
  if (value === '' || value == null) return '—';
  if (type === 'mcq') return options[Number(value)] ?? value;
  if (type === 'truefalse') return value === 'true' ? 'True' : value === 'false' ? 'False' : value;
  if (type === 'multi') {
    let a; try { a = JSON.parse(value); } catch { a = value; }
    if (!Array.isArray(a)) a = [Number(a)];
    a = a.filter((n) => Number.isFinite(Number(n)));
    return a.length ? a.map((i) => options[Number(i)] ?? i).join(', ') : '—';
  }
  return value; // short answer
}

export default function StudentReview() {
  const user = useRequireRole('student', '/student-login');
  const [params] = useSearchParams();
  const assignmentId = params.get('a');
  const [data, setData] = useState(null);
  const [rankInfo, setRankInfo] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!user) return;
    api('/api/my-review/' + assignmentId).then(setData).catch((e) => setMsg(e.message));
    api('/api/my-assignments/' + assignmentId + '/rank').then(setRankInfo).catch(() => {});
  }, [user]);

  if (!user) return null;
  const bar = <DashboardBar who={user.name + ' · Student'}><Link className="btn ghost small" to="/student">Back to my tests</Link></DashboardBar>;

  if (msg) return (<>{bar}<div className="container"><Msg text={msg} /></div></>);
  if (!data) return (<>{bar}<div className="container"><div className="card"><p className="muted">Loading…</p></div></div></>);

  return (
    <>
      {bar}
      <div className="container">
        <div className="card">
          <h1>Review — {data.test.title}</h1>
          <p style={{ fontSize: 20 }}>
            {data.needsGrading ? 'Auto-graded score' : 'Your score'}: <b>{data.score}</b> / {data.maxScore}
            {data.needsGrading ? <span className="muted" style={{ fontSize: 14 }}> · some written answers still to be graded</span> : null}
          </p>
          {rankInfo && rankInfo.percentile != null && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="pill" style={{ background: '#e0e7ff', color: '#3730a3', fontWeight: 600 }}>📊 {rankInfo.percentile} percentile</span>
              <span className="pill" style={{ background: '#e0e7ff', color: '#3730a3', fontWeight: 600 }}>🏅 Rank {rankInfo.rank} of {rankInfo.total}</span>
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>live — updates as more students finish</span>
            </div>
          )}
          <p className="muted">Here are all the questions with your answers and the correct answers. This page is read-only.</p>
        </div>

        {data.items.map((it, i) => {
          const yours = fmtAnswer(it.type, it.response, it.options);
          const correct = fmtAnswer(it.type, it.correctAnswer, it.options);
          const graded = it.isCorrect !== null;
          return (
            <div className="q-card" key={i}>
              {it.section && <div className="pill brand" style={{ marginBottom: 8 }}>{it.section}</div>}
              <h3>Q{i + 1}. <MathText text={it.prompt} /> <span className="muted">({it.points} pt)</span></h3>
              {it.image && <img src={it.image} alt="" style={{ maxWidth: '100%', maxHeight: 240, border: '1px solid var(--line)', borderRadius: 8, display: 'block', marginBottom: 10 }} />}
              <div>
                Your answer: <b><MathText text={yours} /></b>{' '}
                {graded
                  ? (it.isCorrect ? <span className="pill green">correct</span> : <span className="pill gray">wrong</span>)
                  : <span className="pill amber">awaiting grading</span>}
                {' '}<span className="muted">({it.pointsAwarded} / {it.points})</span>
              </div>
              {it.type !== 'short' && (
                <div className="muted" style={{ marginTop: 4 }}>Correct answer: <MathText text={correct} /></div>
              )}
              {it.explanation && (
                <div className="msg" style={{ background: '#eef2ff', color: 'var(--brand-dark)', marginTop: 10 }}>
                  <b>💡 Explanation:</b> <MathText text={it.explanation} />
                </div>
              )}
            </div>
          );
        })}

        <div className="card center">
          <Link className="btn" to="/student">Back to my tests</Link>
        </div>
      </div>
    </>
  );
}
