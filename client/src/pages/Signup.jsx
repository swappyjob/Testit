import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, dashboardFor } from '../api.js';
import { Topbar, Msg, PasswordInput } from '../components.jsx';

export default function Signup() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) { setErr('No signup token in the link.'); return; }
    api('/api/signup/' + encodeURIComponent(token)).then(setInfo).catch((e) => setErr(e.message));
  }, []);

  // New account: set a password.
  async function submit(e) {
    e.preventDefault();
    try {
      const { user } = await api('/api/signup/' + encodeURIComponent(token), 'POST', { password });
      navigate(dashboardFor(user.role), { replace: true });
    } catch (e) { setErr(e.message); }
  }

  // Existing account (student already registered elsewhere): log in and join.
  async function joinExisting(e) {
    e.preventDefault();
    try {
      await api('/api/login', 'POST', { email: info.email, password });
      await api('/api/accept-invite/' + encodeURIComponent(token), 'POST');
      navigate('/student', { replace: true });
    } catch (e) { setErr(e.message); }
  }

  const isTeacher = info?.role === 'teacher';
  const rejoining = info && !isTeacher && info.existingAccount;

  return (
    <>
      <Topbar />
      <div className="container narrow">
        <div className="card">
          <h1>{isTeacher ? 'Welcome! 👩‍🏫' : 'Welcome! 🎓'}</h1>
          <Msg text={err} />
          {info && rejoining && (
            <>
              <p className="muted">
                You already have an account with <b>{info.email}</b>. Log in to join{' '}
                <b>{info.orgName || 'this organization'}</b> — its mock tests will then appear on your dashboard,
                alongside any tests from your other institutes.
              </p>
              <label>Email</label>
              <input type="email" value={info.email} disabled />
              <form onSubmit={joinExisting}>
                <label>Your password</label>
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required />
                <div style={{ marginTop: 18 }}>
                  <button className="btn" type="submit">Log in &amp; join {info.orgName || 'organization'}</button>
                </div>
              </form>
            </>
          )}
          {info && !rejoining && (
            <>
              <p className="muted">
                {isTeacher
                  ? `You've been invited as a ${info.isRoot ? 'root teacher' : 'teacher'}. Set a password to finish creating your account.`
                  : `Your teacher${info.orgName ? ` at ${info.orgName}` : ''} invited you. Set a password to finish creating your account.`}
              </p>
              <label>Name</label>
              <input type="text" value={info.name} disabled />
              <label>Email</label>
              <input type="email" value={info.email} disabled />
              <form onSubmit={submit}>
                <label>Choose a password (min 6 characters)</label>
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required />
                <div style={{ marginTop: 18 }}><button className="btn" type="submit">Create account &amp; log in</button></div>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
