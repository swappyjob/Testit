import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg } from '../components.jsx';
import { fmtPrice, fmtCap } from '../pages/AdminDashboard.jsx';
import SubscribeModal, { renewResultMessage } from './SubscribeModal.jsx';

// Root teachers can view their organization's plan and subscribe/renew.
// Non-root teachers see the plans but can't change them.
// `embedded` renders without the big page card (e.g. inside the Profile dialog).
export default function SubscriptionTab({ isRoot, embedded = false, onContact }) {
  const [data, setData] = useState(null); // { plan, studentCount, plans }
  const [msg, setMsg] = useState(null);
  const [subscribeTo, setSubscribeTo] = useState(null); // plan being subscribed to

  const load = () => api('/api/my-org/plan').then(setData).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  function onSubscribed(r) {
    setSubscribeTo(null);
    setMsg({ ok: true, text: renewResultMessage(r) });
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;
  const cur = data.plan;

  const summary = (
    <>
      {cur ? (
        <p className="muted" style={{ marginTop: 0 }}>
          Your organization is on the <b>{cur.name}</b> plan ({fmtPrice(cur)}) — using{' '}
          <b>{data.studentCount}{cur.max_students != null ? ` / ${cur.max_students}` : ''}</b> student slots.
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>No plan assigned yet. Choose one below.</p>
      )}
      {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
      {!isRoot && <p className="muted">Only a root teacher can change the plan.</p>}
    </>
  );

  const plans = (
    <div className="grid two">
      {data.plans.map((p) => {
        const isCurrent = cur && cur.id === p.id;
        const tooSmall = p.max_students != null && data.studentCount > p.max_students;
        const custom = p.max_students == null; // unlimited = custom / negotiated plan
        return (
          <div className="q-card" key={p.id} style={{ margin: 0, ...(isCurrent ? { border: '2px solid var(--brand)' } : {}) }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 17 }}>{p.name}</h3>
              {isCurrent && <span className="pill brand">Current</span>}
            </div>
            <p style={{ fontSize: 22, fontWeight: 700, margin: '6px 0 2px' }}>{fmtPrice(p)}</p>
            <p className="muted" style={{ margin: '0 0 10px' }}>{fmtCap(p)}</p>
            {!custom && p.price_monthly > 0 && p.pricing && (
              <div style={{ margin: '0 0 12px', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                {[['Quarterly', 'quarterly'], ['Half-yearly', 'half_yearly'], ['Annual', 'yearly']].map(([label, key]) => (
                  <div key={key} className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <span className="muted">{label}</span>
                    <b>₹{Number(p.pricing[key]).toLocaleString('en-IN')}</b>
                  </div>
                ))}
                <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>Pick a billing period when you subscribe.</p>
              </div>
            )}
            {custom ? (
              !isCurrent && <>
                <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>Tailored to your size — get in touch to discuss terms and pricing.</p>
                <button className="btn secondary small" onClick={() => (onContact ? onContact() : null)}>Contact us</button>
              </>
            ) : isCurrent ? (
              isRoot && <button className="btn secondary small" onClick={() => setSubscribeTo('renew')}>Renew</button>
            ) : (
              isRoot && (
                <button className="btn small" disabled={tooSmall} onClick={() => setSubscribeTo(p)}>
                  {tooSmall ? `Too small for ${data.studentCount} students` : 'Subscribe'}
                </button>
              )
            )}
          </div>
        );
      })}
    </div>
  );

  const modalEl = subscribeTo && (
    <SubscribeModal
      targetPlan={subscribeTo === 'renew' ? null : subscribeTo}
      onClose={() => setSubscribeTo(null)}
      onDone={onSubscribed}
    />
  );

  if (embedded) {
    return <>{summary}<div style={{ marginTop: 12 }}>{plans}</div>{modalEl}</>;
  }
  return (
    <>
      <div className="card"><h1 style={{ marginTop: 0 }}>Subscription</h1>{summary}</div>
      {plans}
      {modalEl}
    </>
  );
}
