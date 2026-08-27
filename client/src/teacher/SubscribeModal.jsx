import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Modal, Msg } from '../components.jsx';

export const RENEW_PERIODS = [
  { key: 'monthly', label: 'Monthly', months: 1 },
  { key: 'quarterly', label: 'Quarterly', months: 3 },
  { key: 'half_yearly', label: 'Half-yearly', months: 6 },
  { key: 'yearly', label: 'Annual', months: 12 },
];
export const periodLabel = (key) => (RENEW_PERIODS.find((p) => p.key === key) || {}).label || key;
export const inr = (n) => (n > 0 ? '₹' + Number(n).toLocaleString('en-IN') : 'Free');
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function previewExpiry(currentUntil, months) {
  const now = new Date();
  const cur = currentUntil ? new Date(currentUntil) : null;
  const base = cur && !isNaN(cur) && cur.getTime() > now.getTime() ? cur : now;
  const d = new Date(base.getTime());
  d.setMonth(d.getMonth() + months);
  return fmtDate(d);
}

// One modal for both flows: pass `targetPlan` to subscribe to that plan for a
// chosen period; omit it to renew the current plan. onDone(result) fires after
// a successful subscribe/renew.
export default function SubscribeModal({ targetPlan = null, onClose, onDone }) {
  const [data, setData] = useState(null); // { plan, subscriptionUntil, ... }
  const [period, setPeriod] = useState('yearly');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { api('/api/my-org/plan').then(setData).catch((e) => setMsg({ ok: false, text: e.message })); }, []);

  const subscribing = !!targetPlan;
  const title = subscribing ? `Subscribe to ${targetPlan.name}` : 'Renew subscription';

  async function confirm() {
    setBusy(true); setMsg(null);
    try {
      const body = { period };
      if (subscribing) body.planId = targetPlan.id;
      const r = await api('/api/my-org/renew', 'POST', body);
      onDone(r);
    } catch (e) { setMsg({ ok: false, text: e.message }); setBusy(false); }
  }

  if (!data) return <Modal title={title} onClose={onClose}><p className="muted">Loading…</p></Modal>;

  const priced = subscribing ? targetPlan : data.plan;
  const pricing = (priced && priced.pricing) || {};
  const sel = RENEW_PERIODS.find((p) => p.key === period);
  const isSwitch = subscribing && (!data.plan || targetPlan.id !== data.plan.id);
  const base = isSwitch ? '' : data.subscriptionUntil; // fresh term when switching plans

  return (
    <Modal title={title} onClose={onClose}>
      {subscribing
        ? <p className="muted" style={{ marginTop: 0 }}>Choose a billing period for the <b>{targetPlan.name}</b> plan{targetPlan.max_students != null ? ` (up to ${targetPlan.max_students} students)` : ''}.</p>
        : (data.plan
            ? <p className="muted" style={{ marginTop: 0 }}>Your organization is on the <b>{data.plan.name}</b> plan. Choose a billing period to renew.</p>
            : <p className="muted" style={{ marginTop: 0 }}>No plan is assigned to your organization yet.</p>)}

      <div style={{ display: 'grid', gap: 8 }}>
        {RENEW_PERIODS.map((p) => (
          <label key={p.key} className="choice" style={{ display: 'flex', alignItems: 'center', gap: 10, ...(period === p.key ? { border: '2px solid var(--brand)' } : {}) }}>
            <input type="radio" name="renew-period" checked={period === p.key} onChange={() => setPeriod(p.key)} style={{ width: 'auto' }} />
            <span style={{ flex: 1 }}>{p.label} <span className="muted" style={{ fontSize: 13 }}>· {p.months} month{p.months === 1 ? '' : 's'}</span></span>
            <b>{priced ? inr(pricing[p.key]) : '—'}</b>
          </label>
        ))}
      </div>

      <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
        {isSwitch ? 'New term starts today' : (data.subscriptionUntil ? 'Renews from your current expiry' : 'Starts today')} → active until <b>{previewExpiry(base, sel.months)}</b>{subscribing ? ` on the ${targetPlan.name} plan` : ''}.
      </p>
      <div className="msg" style={{ background: '#eef2ff', color: 'var(--brand-dark)', fontSize: 13 }}>
        💳 Online payment is coming soon. For now this records the {subscribing ? 'subscription' : 'renewal'} and sets your access immediately.
      </div>
      {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <button className="btn" onClick={confirm} disabled={busy}>
          {busy ? 'Working…' : `${subscribing ? 'Subscribe' : 'Renew'} — ${priced ? inr(pricing[period]) : ''}`}
        </button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
