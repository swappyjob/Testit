// Tests the change-password flow.
const BASE = process.env.TEST_BASE || 'http://localhost:3000';
function makeJar() {
  const jar = {};
  return {
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => {
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = c.split(';'); const i = pair.indexOf('=');
        jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
    },
  };
}
async function call(jar, path, method = 'GET', body, expectOk = true) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res);
  let data = {}; try { data = await res.json(); } catch {}
  if (expectOk && !res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || 'error'}`);
  return { status: res.status, data };
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);
const email = `t${rand}@x.com`;

// Session A logs in by registering
const a = makeJar();
await call(a, '/api/register-teacher', 'POST', { name: 'T', email, password: 'oldpass1' });
// Session B: a second login for the same account (simulating another device)
const b = makeJar();
await call(b, '/api/login', 'POST', { email, password: 'oldpass1' });
if ((await call(b, '/api/my-assignments', 'GET', undefined, false)).status === 500) {} // ignore (teacher)
ok('teacher registered; second device logged in');

// Wrong current password is rejected
let r = await call(a, '/api/change-password', 'POST', { currentPassword: 'WRONG', newPassword: 'newpass1' }, false);
if (r.status !== 403) throw new Error('wrong current password should be 403, got ' + r.status);
ok('wrong current password rejected');

// Too-short new password is rejected
r = await call(a, '/api/change-password', 'POST', { currentPassword: 'oldpass1', newPassword: '123' }, false);
if (r.status !== 400) throw new Error('short new password should be 400, got ' + r.status);
ok('too-short new password rejected');

// Successful change
r = await call(a, '/api/change-password', 'POST', { currentPassword: 'oldpass1', newPassword: 'newpass1' });
if (r.status !== 200) throw new Error('valid change should be 200');
ok('password changed successfully');

// Old password no longer works
const c = makeJar();
r = await call(c, '/api/login', 'POST', { email, password: 'oldpass1' }, false);
if (r.status !== 401) throw new Error('old password should fail, got ' + r.status);
ok('old password no longer works');

// New password works
const d = makeJar();
r = await call(d, '/api/login', 'POST', { email, password: 'newpass1' }, false);
if (r.status !== 200) throw new Error('new password should work, got ' + r.status);
ok('new password works');

// The changer's own session (A) is still valid
r = await call(a, '/api/tests', 'GET', undefined, false);
if (r.status !== 200) throw new Error('current session should stay valid, got ' + r.status);
ok('current session stays logged in');

// The OTHER device (B) was logged out
r = await call(b, '/api/tests', 'GET', undefined, false);
if (r.status !== 401) throw new Error('other device should be logged out, got ' + r.status);
ok('other devices were logged out');

console.log('\n✅ PASSWORD-TEST: ALL CHECKS PASSED\n');
