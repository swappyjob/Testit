import { useState } from 'react';
import { api } from '../api.js';
import { Topbar } from '../components.jsx';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    try {
      await api('/api/forgot-password', 'POST', { email });
      setDone(true);
      setMsg("If an account exists for that email, a reset link has been sent. Please check your inbox. If email isn't set up on this server, ask your teacher/admin for a reset link.");
    } catch (e) { setMsg(e.message); }
  }

  return (
    <>
      <Topbar />
      <div className="container narrow">
        <div className="card">
          <h1>Forgot your password?</h1>
          <p className="muted">Enter your email and we'll send you a link to reset your password.</p>
          {msg && <div className={'msg ' + (done ? 'ok' : 'error')}>{msg}</div>}
          {!done && (
            <form onSubmit={submit}>
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <div style={{ marginTop: 18 }}><button className="btn" type="submit">Send reset link</button></div>
            </form>
          )}
        </div>
        <p className="center muted"><a href="/teacher-login">Teacher login</a> · <a href="/student-login">Student login</a></p>
      </div>
    </>
  );
}
