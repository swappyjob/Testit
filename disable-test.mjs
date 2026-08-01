// Tests disabling/enabling a student and its effect on login + sessions.
const BASE = 'http://localhost:3000';
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
const teacher = makeJar(), student = makeJar();
const email = `stud${rand}@x.com`;

await call(teacher, '/api/register-teacher', 'POST', { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
const { data: { token } } = await call(teacher, '/api/students', 'POST', { name: 'Ravi', email, phone: '9000000000' });
await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
const studentId = (await call(teacher, '/api/students')).data.students.find((s) => s.email === email).studentId;
ok('student created and signed up (id ' + studentId + ')');

// Logged-in student can access their dashboard
let r = await call(student, '/api/my-assignments');
if (r.status !== 200) throw new Error('active student should reach dashboard');
ok('active student can use the app');

// Disable the student
await call(teacher, '/api/students/' + studentId, 'PATCH', { disabled: true });
ok('teacher disabled the student');

// The student's existing session is now revoked
r = await call(student, '/api/my-assignments', 'GET', undefined, false);
if (r.status !== 401) throw new Error('disabled student session should be revoked, got ' + r.status);
ok('existing session revoked immediately');

// The student can no longer log in
const fresh = makeJar();
r = await call(fresh, '/api/login', 'POST', { email, password: 'pass123' }, false);
if (r.status !== 403) throw new Error('disabled login should be 403, got ' + r.status);
ok('disabled student cannot log in (403)');

// Teacher list shows disabled
let listed = (await call(teacher, '/api/students')).data.students.find((s) => s.email === email);
if (!listed.disabled) throw new Error('list should show disabled=true');
ok('student shows as disabled in the list');

// Re-enable
await call(teacher, '/api/students/' + studentId, 'PATCH', { disabled: false });
const fresh2 = makeJar();
r = await call(fresh2, '/api/login', 'POST', { email, password: 'pass123' }, false);
if (r.status !== 200) throw new Error('re-enabled login should succeed, got ' + r.status);
ok('re-enabled student can log in again');

// A teacher cannot disable a student they do not own
const other = makeJar();
await call(other, '/api/register-teacher', 'POST', { name: 'O', email: `o${rand}@x.com`, password: 'secret123' });
r = await call(other, '/api/students/' + studentId, 'PATCH', { disabled: true }, false);
if (r.status !== 404) throw new Error('non-owner should get 404, got ' + r.status);
ok('a teacher cannot disable another teacher’s student');

console.log('\n✅ DISABLE-TEST: ALL CHECKS PASSED\n');
