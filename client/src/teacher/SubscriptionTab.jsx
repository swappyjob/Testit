import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg } from '../components.jsx';
import { fmtPrice } from '../pages/AdminDashboard.jsx';
import SubscribeModal, { renewResultMessage, inr, periodLabel, fmtDate } from './SubscribeModal.jsx';

const ACTIVITY = { subscribe: 'Subscribed', renew: 'Renewed', upgrade: 'Upgraded', downgrade: 'Changed plan' };
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

// Root teachers can view their organization's plan and subscribe/renew.
// Non-root teachers see the plans but can't change them.
// `embedded` renders without the big page card (e.g. inside the Profile dialog).
export default function SubscriptionTab({ isRoot, embedded = false, onContact }) {
  const [data, setData] = useState(null); // { plan, studentCount, plans }
  const [billing, setBilling] = useState(null); // { creditBalance, transactions }
  const [msg, setMsg] = useState(null);
  const [subscribeTo, setSubscribeTo] = useState(null); // plan being subscribed to

  const load = () => api('/api/my-org/plan').then(setData).catch((e) => setMsg({ ok: false, text: e.message }));
  const loadBilling = () => api('/api/my-org/transactions').then(setBilling).catch(() => {});
  useEffect(() => { load(); loadBilling(); }, []);

  function onSubscribed(r) {
    setSubscribeTo(null);
    setMsg({ ok: true, text: renewResultMessage(r) });
    load(); loadBilling();
  }

  if (!data) return <p className="muted">Loading…</p>;
  const cur = data.plan;
  const creditBalance = (billing && billing.creditBalance) || 0;

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
      {creditBalance > 0 && (
        <p style={{ marginTop: 0 }}>
          <span className="pill green">💰 Credit balance: ₹{Number(creditBalance).toLocaleString('en-IN')}</span>{' '}
          <span className="muted" style={{ fontSize: 13 }}>— applied automatically to your next charge.</span>
        </p>
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
                      : (isRoot && <button className="btn small" disabled={tooSmall} title={tooSmall ? `Too small for ${data.studentCount} students` : undefined} onClick={() => setSubscribeTo(p)}>{tooSmall ? 'Too small' : 'Subscribe'}</button>)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {isRoot && <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>You pick a billing period (monthly / quarterly / half-yearly / annual) when you subscribe or renew.</p>}
    </div>
  );

  const txns = (billing && billing.transactions) || [];
  const numTd2 = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const history = txns.length > 0 && (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Billing history</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Date</th>
              <th style={{ textAlign: 'left' }}>Activity</th>
              <th style={{ textAlign: 'left' }}>Plan</th>
              <th style={{ textAlign: 'right' }}>Charged</th>
              <th style={{ textAlign: 'right' }}>Credit used</th>
              <th style={{ textAlign: 'right' }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t, i) => (
              <tr key={i}>
                <td>{fmtDate(t.created_at)}</td>
                <td>{ACTIVITY[t.kind] || t.kind}{t.period ? ` · ${periodLabel(t.period)}` : ''}</td>
                <td>{t.plan_name}</td>
                <td style={numTd2}>{t.charged > 0 ? rupees(t.charged) : '—'}</td>
                <td style={numTd2}>{t.credit > 0 ? '−' + rupees(t.credit) : (t.credit < 0 ? '+' + rupees(-t.credit) : '—')}</td>
                <td style={numTd2}>{rupees(t.balance_after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Amounts are recorded now; online payment collection is coming soon.</p>
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
    return <>{summary}<div style={{ marginTop: 12 }}>{plans}</div>{history}{modalEl}</>;
  }
  return (
    <>
      <div className="card"><h1 style={{ marginTop: 0 }}>Subscription</h1>{summary}</div>
      {plans}
      <div className="card">{history || <p className="muted" style={{ margin: 0 }}>No billing history yet.</p>}</div>
      {modalEl}
    </>
  );
}
