import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { currentUser, dashboardFor } from './api.js';

// Guard a page for a specific role. Redirects to login if not authed, or to the
// user's own dashboard if the role doesn't match. Returns the user once ready.
export function useRequireRole(role, loginPath) {
  const [user, setUser] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    currentUser()
      .then((u) => {
        if (!active) return;
        if (!u) { navigate(loginPath, { replace: true }); return; }
        if (u.role !== role) { navigate(dashboardFor(u.role), { replace: true }); return; }
        setUser(u);
      })
      .catch(() => navigate(loginPath, { replace: true }));
    return () => { active = false; };
  }, []);
  return user;
}
