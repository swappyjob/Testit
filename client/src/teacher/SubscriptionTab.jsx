import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg } from '../components.jsx';
import { fmtPrice } from '../pages/AdminDashboard.jsx';
import SubscribeModal, { renewResultMessage, inr, periodLabel, fmtDate } from './SubscribeModal.jsx';

const ACTIVITY = { subscribe: 'Subscribed', renew: 'Renewed', upgrade: 'Upgraded', downgrade: 'Changed plan' };
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

// ---------------------------------------------------------------------------
// Subscription page — the current plan, the full plan table, and subscribe /
// renew / change. Billing history + credit balance live on the Billing page.
// ---------------------------------------------------------------------------
export default function SubscriptionTab({ isRoot, embedded = false, onContact }) {
  const [data, setData] = useState(null); // { plan, studentCount, plans }
  const [msg, setMsg] = useState(null);
  const [subscribeTo, setSubscribeTo] = useState(null); // plan being subscribed to, or 'renew'

  const load = () => api('/api/my-org/plan').then(setData).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  function onSubscribed(r) {
    setSubscribeTo(null);
    setMsg({ ok: true, text: renewResultMessage(r) });
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;
  const cur = data.plan;
  const active = !!data.subscriptionUntil && !data.subscriptionExpired; // mid-term vs expired

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

  const priceCell = (p, key) => (p.max_students == null ? '—' : (p.price_monthly > 0 && p.pricing ? inr(p.pricing[key]) : '—'));
  const numTd = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const plans = (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Plan</th>
            <th style={{ textAlign: 'left' }}>Students</th>
            <th style={{ textAlign: 'right' }}>Monthly</th>
            <th style={{ textAlign: 'right' }}>Quarterly</th>
            <th style={{ textAlign: 'right' }}>Half-yearly</th>
            <th style={{ textAlign: 'right' }}>Annual</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.plans.map((p) => {
            const isCurrent = cur && cur.id === p.id;
            const custom = p.max_students == null; // unlimited = custom / negotiated plan
            const tooSmall = p.max_students != null && data.studentCount > p.max_students;
            const isUpgrade = cur && (p.price_monthly || 0) > (cur.price_monthly || 0);
            return (
              <tr key={p.id} style={isCurrent ? { background: 'var(--surface-2, #eef2ff)' } : undefined}>
                <td><b>{p.name}</b>{isCurrent && <span className="pill brand" style={{ marginLeft: 6 }}>Current</span>}</td>
                <td>{custom ? 'Unlimited' : `up to ${p.max_students}`}</td>
                <td style={numTd}>{custom ? 'Custom' : (p.price_monthly > 0 ? inr(p.price_monthly) : 'Free')}</td>
                <td style={numTd}>{priceCell(p, 'quarterly')}</td>
                <td style={numTd}>{priceCell(p, 'half_yearly')}</td>
                <td style={numTd}>{priceCell(p, 'yearly')}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {custom
                    ? (!isCurrent && <button className="btn secondary small" onClick={() => (onContact ? onContact() : null)}>Contact us</button>)
                    : isCurrent
                      ? (isRoot && <button className="btn secondary small" onClick={() => setSubscribeTo('renew')}>Renew</button>)
                      : !isRoot ? null
                        : active
                          ? (isUpgrade
                              ? <button className="btn small" disabled={tooSmall} title={tooSmall ? `Too small for ${data.studentCount} students` : 'Upgrade now on your current billing cycle'} onClick={() => setSubscribeTo(p)}>{tooSmall ? 'Too small' : 'Upgrade'}</button>
                              : <button className="btn secondary small" disabled title="You can move to a lower plan when you renew">At renewal</button>)
                          : <button className="btn small" disabled={tooSmall} title={tooSmall ? `Too small for ${data.studentCount} students` : undefined} onClick={() => setSubscribeTo(p)}>{tooSmall ? 'Too small' : 'Subscribe'}</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {isRoot && <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>You pick a billing period (monthly / quarterly / half-yearly / annual) when you subscribe or renew.</p>}
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

// ---------------------------------------------------------------------------
// Billing page — credit balance and the full billing history (ledger).
// ---------------------------------------------------------------------------
export function BillingTab({ embedded = false }) {
  const [billing, setBilling] = useState(null); // { transactions }
  const [err, setErr] = useState(null);

  useEffect(() => { api('/api/my-org/transactions').then(setBilling).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="card"><Msg text={err} kind="error" /></div>;
  if (!billing) return <p className="muted">Loading…</p>;

  const txns = billing.transactions || [];
  const numTd = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

  const history = txns.length > 0 ? (
    <div style={{ overflowX: 'auto', marginTop: 8 }}>
      <table style={{ width: '100%', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Date</th>
            <th style={{ textAlign: 'left' }}>Activity</th>
            <th style={{ textAlign: 'left' }}>Plan</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {txns.map((t, i) => (
            <tr key={i}>
              <td>{fmtDate(t.created_at)}</td>
              <td>{ACTIVITY[t.kind] || t.kind}{t.period ? ` · ${periodLabel(t.period)}` : ''}</td>
              <td>{t.plan_name}</td>
              <td style={numTd}>{t.charged > 0 ? rupees(t.charged) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Amounts are recorded now; online payment collection is coming soon.</p>
    </div>
  ) : (
    <p className="muted" style={{ margin: 0 }}>No billing history yet.</p>
  );

  if (embedded) return <>{history}</>;
  return (
    <div className="card"><h1 style={{ marginTop: 0 }}>Billing</h1><h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Billing history</h3>{history}</div>
  );
}
