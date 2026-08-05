import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { currentUser, dashboardFor } from '../api.js';

export default function Landing() {
  const navigate = useNavigate();
  useEffect(() => {
    currentUser().then((u) => { if (u) navigate(dashboardFor(u.role), { replace: true }); });
  }, []);
  return (
    <div className="hero">
      <h1>📝 Online Test Platform</h1>
      <p className="muted">Teachers create tests. Students take them online.</p>
      <div className="role-cards">
        <Link className="card" to="/teacher-login">
          <div className="emoji">👩‍🏫</div>
          <h2>I'm a Teacher</h2>
          <p className="muted">Create tests, add students, assign &amp; grade.</p>
          <span className="btn">Teacher login</span>
        </Link>
        <Link className="card" to="/student-login">
          <div className="emoji">🎓</div>
          <h2>I'm a Student</h2>
          <p className="muted">Log in and take your assigned tests.</p>
          <span className="btn secondary">Student login</span>
        </Link>
      </div>
      <p className="muted" style={{ marginTop: 22 }}><Link to="/admin-login">Administrator login</Link></p>
    </div>
  );
}
