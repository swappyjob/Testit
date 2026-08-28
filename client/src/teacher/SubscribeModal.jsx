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

const PERIOD_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

// A user-facing message for a subscribe / renew / mid-cycle change result.
export function renewResultMessage(r) {
  if (r.mode === 'change') {
    const dateBit = r.periodChanged
      ? `new ${periodLabel(r.period).toLowerCase()} term — active until ${fmtDate(r.expiresAt)}`
      : `renewal date unchanged (${fmtDate(r.expiresAt)})`;
    const parts = [`${r.upgrade ? 'Upgraded to' : 'Changed to'} the ${r.planName} plan — ${dateBit}.`];
    if (r.netPay > 0) parts.push(`You pay ${inr(r.netPay)}${r.credit ? ` (${inr(r.charge)}${r.periodChanged ? '' : ' for the remaining term'} − ${inr(r.credit)} credit for the unused term)` : ''}.`);
    else if (r.bankedCredit > 0) parts.push(`${inr(r.bankedCredit)} credited to your balance (now ${inr(r.creditBalance)}).`);
    else parts.push('Nothing to pay now.');
    return parts.join(' ');
  }
  const creditNote = r.balanceUsed ? ` · ${inr(r.balanceUsed)} credit applied` : '';
  return `Your organization is now on the ${r.planName} plan (${periodLabel(r.period)}) — active until ${fmtDate(r.expiresAt)}${creditNote}.`;
}

// One modal for all three flows. Pass `targetPlan` to move to that plan; omit it
// to renew the current plan. onDone(result) fires after a successful change.
export default function SubscribeModal({ targetPlan = null, onClose, onDone }) {
  const [data, setData] = useState(null); // { plan, subscriptionUntil, subscriptionExpired }
  const [period, setPeriod] = useState('yearly');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    api('/api/my-org/plan')
      .then((d) => { setData(d); if (d.subscriptionPeriod && PERIOD_MONTHS[d.subscriptionPeriod]) setPeriod(d.subscriptionPeriod); })
      .catch((e) => setMsg({ ok: false, text: e.message }));
  }, []);

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
      const body = changeMode ? { planId: targetPlan.id, period } : { period, ...(isSwitch ? { planId: targetPlan.id } : {}) };
      onDone(await api('/api/my-org/renew', 'POST', body));
    } catch (e) { setMsg({ ok: false, text: e.message }); setBusy(false); }
  }

  // -------- Mid-cycle change (upgrade / downgrade): pick a period. Same period keeps
  //          the renewal date & prorates; a different one starts a fresh term today. --------
  if (changeMode) {
    // Mirror the server's period-aware proration for the live preview.
    const currentPeriod = data.subscriptionPeriod && PERIOD_MONTHS[data.subscriptionPeriod] ? data.subscriptionPeriod : 'monthly';
    const samePeriod = period === currentPeriod;
    // Credit for the unused portion of the CURRENT prepaid term (independent of the new period).
    const pDays = PERIOD_MONTHS[currentPeriod] * 30;
    const daysRemaining = Math.min(pDays, Math.max(0, Math.ceil((new Date(data.subscriptionUntil).getTime() - Date.now()) / 86400000)));
    const fraction = pDays > 0 ? daysRemaining / pDays : 0;
    const oldTermPrice = data.subscriptionTermPrice > 0 ? data.subscriptionTermPrice : ((data.plan && data.plan.pricing && data.plan.pricing[currentPeriod]) || 0);
    const credit = Math.round(oldTermPrice * fraction);
    // Charge: prorated new plan for the remaining days (same period) or a full fresh term (different period).
    const charge = samePeriod
      ? Math.round(((targetPlan.pricing && targetPlan.pricing[currentPeriod]) || 0) * fraction)
      : ((targetPlan.pricing && targetPlan.pricing[period]) || 0);
    const dueAfterTermCredit = Math.max(0, charge - credit);
    const bankedCredit = Math.max(0, credit - charge);
    const balance = data.creditBalance || 0;
    const balanceUsed = Math.min(balance, dueAfterTermCredit);
    const netPay = dueAfterTermCredit - balanceUsed;
    const upgrade = (targetPlan.price_monthly || 0) > ((data.plan && data.plan.price_monthly) || 0);
    const newExpiry = samePeriod ? fmtDate(data.subscriptionUntil) : previewExpiry('', PERIOD_MONTHS[period]);
    const Row = ({ label, val, sign }) => (
      <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
        <span className="muted">{label}</span><b>{sign === '-' ? '−' : ''}{inr(val)}</b>
      </div>
    );
    return (
      <Modal title={`${upgrade ? 'Upgrade to' : 'Change to'} ${targetPlan.name}`} onClose={onClose}>
        <p className="muted" style={{ marginTop: 0 }}>
          You're on <b>{data.plan ? data.plan.name : '—'}</b> ({periodLabel(currentPeriod).toLowerCase()}), active until <b>{fmtDate(data.subscriptionUntil)}</b>.
          The <b>{targetPlan.name}</b> plan{targetPlan.max_students != null ? ` (up to ${targetPlan.max_students} students)` : ''} applies <b>immediately</b>. Choose a billing period:
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {RENEW_PERIODS.map((p) => (
            <label key={p.key} className="choice" style={{ display: 'flex', alignItems: 'center', gap: 10, ...(period === p.key ? { border: '2px solid var(--brand)' } : {}) }}>
              <input type="radio" name="change-period" checked={period === p.key} onChange={() => setPeriod(p.key)} style={{ width: 'auto' }} />
              <span style={{ flex: 1 }}>
                {p.label}{' '}
                {p.key === currentPeriod
                  ? <span className="pill green" style={{ fontSize: 11 }}>keeps your renewal date</span>
                  : <span className="muted" style={{ fontSize: 12 }}>· new term</span>}
              </span>
              <b>{inr((targetPlan.pricing && targetPlan.pricing[p.key]) || 0)}</b>
            </label>
          ))}
        </div>
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', fontSize: 14, marginTop: 12 }}>
          <Row label={samePeriod ? `${targetPlan.name} for the remaining ${daysRemaining} day(s)` : `${targetPlan.name} — new ${periodLabel(period).toLowerCase()} term`} val={charge} />
          <Row label={`Credit for unused ${data.plan ? data.plan.name : ''} term`} val={credit} sign="-" />
          {balanceUsed > 0 && <Row label="Existing credit balance applied" val={balanceUsed} sign="-" />}
          <div className="row" style={{ justifyContent: 'space-between', padding: '8px 0 0', marginTop: 6, borderTop: '1px solid var(--line)', fontSize: 16 }}>
            <b>You pay now</b><b style={{ color: 'var(--brand)' }}>{inr(netPay)}</b>
          </div>
          {bankedCredit > 0 && <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>₹{Number(bankedCredit).toLocaleString('en-IN')} will be credited to your balance for a future renewal.</p>}
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          {samePeriod
            ? <>Your renewal date <b>doesn't move</b> — still <b>{newExpiry}</b>.</>
            : <>Starts a <b>new {periodLabel(period).toLowerCase()} term</b> today → active until <b>{newExpiry}</b>.</>}
        </p>
        <div className="msg" style={{ background: '#eef2ff', color: 'var(--brand-dark)', fontSize: 13, marginTop: 8 }}>
          💳 Online payment is coming soon. For now this applies the change and records the amounts.
        </div>
        {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
        <div className="row" style={{ marginTop: 16, gap: 10 }}>
          <button className="btn" onClick={confirm} disabled={busy}>{busy ? 'Working…' : (netPay > 0 ? `${upgrade ? 'Upgrade' : 'Change'} — ${inr(netPay)}` : `${upgrade ? 'Upgrade' : 'Change'} plan`)}</button>
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
