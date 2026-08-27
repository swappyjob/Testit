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

// A user-facing message for a subscribe / renew / mid-cycle change result.
export function renewResultMessage(r) {
  if (r.mode === 'change') {
    const base = `${r.upgrade ? 'Upgraded to' : 'Changed to'} the ${r.planName} plan — your renewal date is unchanged (${fmtDate(r.expiresAt)}).`;
    return r.prorated > 0 ? `${base} Prorated ${inr(r.prorated)} for the ${r.daysRemaining} remaining day(s).` : base;
  }
  return `Your organization is now on the ${r.planName} plan (${periodLabel(r.period)}) — active until ${fmtDate(r.expiresAt)}.`;
}

// One modal for all three flows. Pass `targetPlan` to move to that plan; omit it
// to renew the current plan. onDone(result) fires after a successful change.
export default function SubscribeModal({ targetPlan = null, onClose, onDone }) {
  const [data, setData] = useState(null); // { plan, subscriptionUntil, subscriptionExpired }
  const [period, setPeriod] = useState('yearly');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { api('/api/my-org/plan').then(setData).catch((e) => setMsg({ ok: false, text: e.message })); }, []);

  if (!data) {
    return <Modal title={targetPlan ? `Change to ${targetPlan.name}` : 'Renew subscription'} onClose={onClose}><p className="muted">Loading…</p></Modal>;
  }

  const active = !!data.subscriptionUntil && !data.subscriptionExpired;
  const isSwitch = !!targetPlan && (!data.plan || targetPlan.id !== data.plan.id);
  const changeMode = isSwitch && active; // mid-cycle plan change: keep the date, prorate
  const priced = isSwitch ? targetPlan : data.plan;
  const pricing = (priced && priced.pricing) || {};
  const sel = RENEW_PERIODS.find((p) => p.key === period);

  async function confirm() {
    setBusy(true); setMsg(null);
    try {
      const body = changeMode ? { planId: targetPlan.id } : { period, ...(isSwitch ? { planId: targetPlan.id } : {}) };
      onDone(await api('/api/my-org/renew', 'POST', body));
    } catch (e) { setMsg({ ok: false, text: e.message }); setBusy(false); }
  }

  // -------- Mid-cycle change (upgrade / downgrade): no period, keep the date --------
  if (changeMode) {
    const daysRemaining = Math.max(0, Math.ceil((new Date(data.subscriptionUntil).getTime() - Date.now()) / 86400000));
    const diff = (targetPlan.price_monthly || 0) - ((data.plan && data.plan.price_monthly) || 0);
    const upgrade = diff > 0;
    const prorated = upgrade ? Math.round((diff * daysRemaining) / 30) : 0;
    return (
      <Modal title={`${upgrade ? 'Upgrade to' : 'Change to'} ${targetPlan.name}`} onClose={onClose}>
        <p className="muted" style={{ marginTop: 0 }}>
          You're currently on <b>{data.plan ? data.plan.name : '—'}</b>, active until <b>{fmtDate(data.subscriptionUntil)}</b>.
        </p>
        <ul style={{ color: 'var(--muted)', lineHeight: 1.9, marginTop: 0 }}>
          <li>The <b>{targetPlan.name}</b> plan{targetPlan.max_students != null ? ` (up to ${targetPlan.max_students} students)` : ''} applies <b>immediately</b>.</li>
          <li>Your renewal date <b>stays {fmtDate(data.subscriptionUntil)}</b> — it doesn't move.</li>
          {upgrade
            ? <li>Prorated top-up for the <b>{daysRemaining}</b> remaining day(s): <b>{inr(prorated)}</b>. From your renewal date you'll pay {inr(targetPlan.price_monthly)}/mo.</li>
            : <li>No extra charge now — the lower price applies from your next renewal.</li>}
        </ul>
        <div className="msg" style={{ background: '#eef2ff', color: 'var(--brand-dark)', fontSize: 13 }}>
          💳 Online payment is coming soon. For now this applies the change and records the amount owed.
        </div>
        {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
        <div className="row" style={{ marginTop: 16, gap: 10 }}>
          <button className="btn" onClick={confirm} disabled={busy}>{busy ? 'Working…' : (upgrade ? `Upgrade${prorated ? ' — ' + inr(prorated) : ''}` : 'Change plan')}</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </Modal>
    );
  }

  // -------- Fresh subscribe (expired) or renew (same plan): pick a period --------
  const title = isSwitch ? `Subscribe to ${targetPlan.name}` : 'Renew subscription';
  return (
    <Modal title={title} onClose={onClose}>
      {isSwitch
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
        {isSwitch ? 'New term starts today' : (data.subscriptionUntil ? 'Renews from your current expiry' : 'Starts today')} → active until <b>{previewExpiry(isSwitch ? '' : data.subscriptionUntil, sel.months)}</b>{isSwitch ? ` on the ${targetPlan.name} plan` : ''}.
      </p>
      <div className="msg" style={{ background: '#eef2ff', color: 'var(--brand-dark)', fontSize: 13 }}>
        💳 Online payment is coming soon. For now this records the {isSwitch ? 'subscription' : 'renewal'} and sets your access immediately.
      </div>
      {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <button className="btn" onClick={confirm} disabled={busy}>
          {busy ? 'Working…' : `${isSwitch ? 'Subscribe' : 'Renew'} — ${priced ? inr(pricing[period]) : ''}`}
        </button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
