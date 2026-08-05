// JSON fetch wrapper. Throws Error(message) on non-2xx responses.
export async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function currentUser() {
  const { user } = await api('/api/me');
  return user;
}

// Where each role belongs after logging in.
export function dashboardFor(role) {
  return role === 'admin' ? '/admin' : role === 'teacher' ? '/teacher' : '/student';
}

export async function logout() {
  await api('/api/logout', 'POST');
  window.location.href = '/';
}
