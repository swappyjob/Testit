// Tiny shared helpers used by every page.

// JSON fetch wrapper. Throws Error(message) on non-2xx responses.
async function api(path, method = 'GET', body) {
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

// Return the logged-in user (or null).
async function currentUser() {
  const { user } = await api('/api/me');
  return user;
}

// Redirect to the right dashboard if already logged in, or enforce a role.
async function requireRole(role, redirectIfNone) {
  const user = await currentUser();
  if (!user) { location.href = redirectIfNone; return null; }
  if (user.role !== role) {
    location.href = user.role === 'teacher' ? '/teacher.html' : '/student.html';
    return null;
  }
  return user;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showMsg(container, text, kind = 'error') {
  const box = typeof container === 'string' ? document.getElementById(container) : container;
  box.className = `msg ${kind}`;
  box.textContent = text;
  box.classList.remove('hidden');
}

async function logout() {
  await api('/api/logout', 'POST');
  location.href = '/';
}

// Add a show/hide "eye" toggle to every password field on the page.
function enablePasswordToggles(root = document) {
  root.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.pwToggle) return; // already wrapped
    input.dataset.pwToggle = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button'; // don't submit the form
    btn.className = 'pw-toggle';
    btn.textContent = '👁';
    btn.setAttribute('aria-label', 'Show password');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      input.focus();
    });
    wrap.appendChild(btn);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => enablePasswordToggles());
} else {
  enablePasswordToggles();
}
