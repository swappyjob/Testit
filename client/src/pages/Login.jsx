import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, currentUser, dashboardFor } from '../api.js';
import { Topbar, Msg, PasswordInput } from '../components.jsx';

export default function Login({ title, subtitle, footer }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    currentUser().then((u) => { if (u) navigate(dashboardFor(u.role), { replace: true }); });
  }, []);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      const { user } = await api('/api/login', 'POST', { email, password });
      navigate(dashboardFor(user.role), { replace: true });
    } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <Topbar />
      <div className="container narrow">
        <div className="card">
          <h1>{title}</h1>
          <p className="muted">{subtitle}</p>
          <Msg text={err} />
          <form onSubmit={submit}>
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label>Password</label>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required />
            <div style={{ marginTop: 18 }}><button className="btn" type="submit">Log in</button></div>
          </form>
        </div>
        <p className="center muted">{footer}</p>
      </div>
    </>
  );
}
