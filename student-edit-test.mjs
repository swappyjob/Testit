import { registerTeacher } from './bootstrap.mjs';
// Tests editing a student (name/phone/access), email immutable, permissions.
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
async function call(jar, path_, method = 'GET', body, expectOk = true) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path_, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res);
  let data = {}; try { data = await res.json(); } catch {}
  if (expectOk && !res.ok) throw new Error(`${method} ${path_} -> ${res.status}: ${data.error || 'error'}`);
  return { status: res.status, data };
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);
function ymd(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });

// Create + sign up a student with a future access date.
const email = `st${rand}@x.com`;
const stok = (await call(teacher, '/api/students', 'POST', { name: 'Old Name', email, phone: '9000000001', accessUntil: ymd(5) })).data.token;
const student = makeJar();
await call(student, '/api/signup/' + stok, 'POST', { password: 'pass123' });
const s0 = (await call(teacher, '/api/students')).data.students.find((s) => s.email === email);
ok('created and signed up a student');

// Edit name + phone + access; also TRY to change email (should be ignored).
await call(teacher, '/api/students/' + s0.id, 'PUT', {
  name: 'New Name', phone: '9111111111', accessUntil: ymd(10), email: `hacked${rand}@x.com`,
});
const s1 = (await call(teacher, '/api/students')).data.students.find((s) => s.id === s0.id);
if (s1.name !== 'New Name' || s1.phone !== '9111111111' || s1.accessUntil !== ymd(10))
  throw new Error('edit did not persist');
if (s1.email !== email) throw new Error('email must not change');
ok('name/phone/access updated; email unchanged');

// The change also reflects on the account (login still works with future date).
if ((await call(makeJar(), '/api/login', 'POST', { email, password: 'pass123' }, false)).status !== 200)
  throw new Error('student should still log in (future date)');
ok('account reflects the edit and student can still log in');

// Editing access into the past ends the student's access to THIS org (access is
// per-organization): they can still log in, but the list flags them expired.
await call(teacher, '/api/students/' + s0.id, 'PUT', { name: 'New Name', phone: '9111111111', accessUntil: ymd(-1) });
if ((await call(makeJar(), '/api/login', 'POST', { email, password: 'pass123' }, false)).status !== 200)
  throw new Error('expired student should still be able to log in (per-org access)');
const s2 = (await call(teacher, '/api/students')).data.students.find((s) => s.id === s0.id);
if (!s2.expired) throw new Error('list should show expired');
ok('editing access into the past ends the org’s access (login still works; list shows expired)');

// Validation: blank name / bad phone rejected.
if ((await call(teacher, '/api/students/' + s0.id, 'PUT', { name: '', phone: '9111111111' }, false)).status !== 400)
  throw new Error('blank name should be 400');
if ((await call(teacher, '/api/students/' + s0.id, 'PUT', { name: 'X', phone: 'abc' }, false)).status !== 400)
  throw new Error('bad phone should be 400');
ok('validation enforced (name required, phone format)');

// A pending (not signed up) student can also be edited.
const pemail = `pend${rand}@x.com`;
await call(teacher, '/api/students', 'POST', { name: 'Pending', email: pemail, phone: '9000000002' });
const p0 = (await call(teacher, '/api/students')).data.students.find((s) => s.email === pemail);
await call(teacher, '/api/students/' + p0.id, 'PUT', { name: 'Pending Edited', phone: '9222222222' });
const p1 = (await call(teacher, '/api/students')).data.students.find((s) => s.id === p0.id);
if (p1.name !== 'Pending Edited' || p1.phone !== '9222222222') throw new Error('pending edit failed');
ok('a pending student can be edited too');

// Another teacher cannot edit this student.
const other = await registerTeacher(BASE, makeJar, call, { name: 'O', email: `o${rand}@x.com`, password: 'secret123' });
if ((await call(other, '/api/students/' + s0.id, 'PUT', { name: 'Z', phone: '9000000000' }, false)).status !== 404)
  throw new Error('non-owner edit should be 404');
ok('a teacher cannot edit another teachers student');

console.log('\n✅ STUDENT-EDIT-TEST: ALL CHECKS PASSED\n');
