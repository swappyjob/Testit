import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Topbar, Msg, PasswordInput } from '../components.jsx';

export default function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [info, setInfo] = useState(null);
  const [msg, setMsg] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [role, setRole] = useState('student');

  useEffect(() => {
    if (!token) { setMsg('No reset token in the link.'); return; }
    api('/api/reset/' + encodeURIComponent(token))
      .then((i) => { setInfo(i); setRole(i.role); })
      .catch((e) => setMsg(e.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (pw !== confirm) { setMsg('The passwords do not match.'); return; }
    try {
      const r = await api('/api/reset/' + encodeURIComponent(token), 'POST', { password: pw });
      setRole(r.role);
      setDone(true);
    } catch (e) { setMsg(e.message); }
  }

  const loginUrl = role === 'teacher' ? '/teacher-login' : role === 'admin' ? '/admin-login' : '/student-login';
  return (
    <>
      <Topbar />
      <div className="container narrow">
        <div className="card">
          <h1>Choose a new password</h1>
          <Msg text={msg} />
          {done ? (
            <div>
              <p className="msg ok">Your password has been updated. You can now log in.</p>
              <a className="btn" href={loginUrl}>Go to login</a>
            </div>
          ) : info ? (
            <>
              <p className="muted">Resetting the password for <b>{info.email}</b>.</p>
              <form onSubmit={submit}>
                <label>New password (min 6 characters)</label>
                <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} required />
                <label>Confirm new password</label>
                <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                <div style={{ marginTop: 18 }}><button className="btn" type="submit">Set new password</button></div>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
