import { useState } from 'react';
import { api } from '../api.js';
import { Msg, PasswordInput } from '../components.jsx';

// Profile Details page: email + role (read-only), editable first/last name,
// and change-password. `onUpdated(user)` lets the dashboard refresh the top bar.
export default function ProfileDetails({ me, onUpdated }) {
  const [first, setFirst] = useState(me.firstName || '');
  const [last, setLast] = useState(me.lastName || '');
  const [nameMsg, setNameMsg] = useState(null);
  const [savingName, setSavingName] = useState(false);

  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState(null);

  const roleLabel = me.role === 'teacher' ? (me.isRoot ? 'Root teacher' : 'Teacher')
    : me.role === 'admin' ? 'Administrator'
    : me.role === 'support' ? 'Support agent'
    : me.role.charAt(0).toUpperCase() + me.role.slice(1);

  async function saveName(e) {
    e.preventDefault();
    if (!first.trim()) { setNameMsg({ ok: false, text: 'First name is required.' }); return; }
    setSavingName(true); setNameMsg(null);
    try {
      const { user } = await api('/api/me', 'PATCH', { firstName: first.trim(), lastName: last.trim() });
      setNameMsg({ ok: true, text: 'Profile updated.' });
      if (onUpdated && user) onUpdated(user);
    } catch (e) { setNameMsg({ ok: false, text: e.message }); }
    finally { setSavingName(false); }
  }

  async function savePassword(e) {
    e.preventDefault();
    if (nw !== confirm) { setPwMsg({ ok: false, text: 'The new passwords do not match.' }); return; }
    try {
      await api('/api/change-password', 'POST', { currentPassword: cur, newPassword: nw });
      setPwMsg({ ok: true, text: 'Password updated successfully! Other devices have been logged out.' });
      setCur(''); setNw(''); setConfirm('');
    } catch (e) { setPwMsg({ ok: false, text: e.message }); }
  }

  const ro = { background: 'var(--surface-2, #f1f5f9)', color: 'var(--muted, #64748b)' };

  return (
    <>
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Profile details</h1>
        {nameMsg && <Msg text={nameMsg.text} kind={nameMsg.ok ? 'ok' : 'error'} />}
        <form onSubmit={saveName}>
          <div className="grid two">
            <div><label>First name</label><input type="text" value={first} onChange={(e) => setFirst(e.target.value)} required /></div>
            <div><label>Last name</label><input type="text" value={last} onChange={(e) => setLast(e.target.value)} /></div>
            <div><label>Email</label><input type="email" value={me.email} readOnly style={ro} title="Email can't be changed here" /></div>
            <div><label>Role</label><input type="text" value={roleLabel} readOnly style={ro} /></div>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" type="submit" disabled={savingName}>{savingName ? 'Saving…' : 'Save changes'}</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Change password</h3>
        {pwMsg && <Msg text={pwMsg.text} kind={pwMsg.ok ? 'ok' : 'error'} />}
        <form onSubmit={savePassword}>
          <label>Current password</label>
          <PasswordInput value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" />
          <label>New password (min 6 characters)</label>
          <PasswordInput value={nw} onChange={(e) => setNw(e.target.value)} required autoComplete="new-password" />
          <label>Confirm new password</label>
          <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn" type="submit">Update password</button>
          </div>
        </form>
      </div>
    </>
  );
}
