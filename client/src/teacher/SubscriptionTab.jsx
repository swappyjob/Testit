import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg } from '../components.jsx';
import { fmtPrice, fmtCap } from '../pages/AdminDashboard.jsx';

// Root teachers can view their organization's plan and switch to another.
// Non-root teachers see the plans but can't change them.
export default function SubscriptionTab({ isRoot }) {
  const [data, setData] = useState(null); // { plan, studentCount, plans }
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/api/my-org/plan').then(setData).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  async function subscribe(p) {
    if (!window.confirm(`Switch your organization to the ${p.name} plan (${fmtPrice(p)})?`)) return;
    setBusy(true); setMsg(null);
    try {
      await api('/api/my-org/plan', 'POST', { planId: p.id });
      setMsg({ ok: true, text: `Your organization is now on the ${p.name} plan.` });
      await load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  }

  if (!data) return <div className="card"><p className="muted">Loading…</p></div>;
  const cur = data.plan;

  return (
    <>
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Subscription</h1>
        {cur ? (
          <p className="muted">
            Your organization is on the <b>{cur.name}</b> plan ({fmtPrice(cur)}) — using{' '}
            <b>{data.studentCount}{cur.max_students != null ? ` / ${cur.max_students}` : ''}</b> student slots.
          </p>
        ) : (
          <p className="muted">No plan assigned yet. Choose one below.</p>
        )}
        {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
        {!isRoot && <p className="muted">Only a root teacher can change the plan.</p>}
      </div>

      <div className="grid two">
        {data.plans.map((p) => {
          const isCurrent = cur && cur.id === p.id;
          const tooSmall = p.max_students != null && data.studentCount > p.max_students;
          return (
            <div className="card" key={p.id} style={isCurrent ? { border: '2px solid var(--brand)' } : undefined}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <h2 style={{ margin: 0 }}>{p.name}</h2>
                {isCurrent && <span className="pill brand">Current plan</span>}
              </div>
              <p style={{ fontSize: 24, fontWeight: 700, margin: '8px 0 2px' }}>{fmtPrice(p)}</p>
              <p className="muted" style={{ marginTop: 0 }}>{fmtCap(p)}</p>
              {isRoot && !isCurrent && (
                <button className="btn" disabled={busy || tooSmall} onClick={() => subscribe(p)}>
                  {tooSmall ? `Too small for ${data.studentCount} students` : 'Subscribe to this plan'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
