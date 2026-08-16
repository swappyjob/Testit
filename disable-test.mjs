import { registerTeacher } from './bootstrap.mjs';
// Tests disabling/enabling a student and its effect on login + sessions.
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
const student = makeJar();
const email = `stud${rand}@x.com`;

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
const { data: { token } } = await call(teacher, '/api/students', 'POST', { name: 'Ravi', email, phone: '9000000000' });
await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
const studentId = (await call(teacher, '/api/students')).data.students.find((s) => s.email === email).studentId;
ok('student created and signed up (id ' + studentId + ')');

// Give the student a test to see.
const { id: testId } = (await call(teacher, '/api/tests', 'POST', { title: 'T1', questions: [{ type: 'truefalse', prompt: 'A', correct: 'true', points: 1 }] })).data;
await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [studentId] });

// Active: the student sees and can open the assigned test.
let r = await call(student, '/api/my-assignments');
if (r.status !== 200 || r.data.assignments.length !== 1) throw new Error('active student should see the assigned test');
const aid = r.data.assignments[0].assignmentId;
if ((await call(student, '/api/take/' + aid)).status !== 200) throw new Error('active student should open the test');
ok('active student sees and can open the assigned test');

// Disable the student within this organization.
await call(teacher, '/api/students/' + studentId, 'PATCH', { disabled: true });
ok('teacher disabled the student');

// Per-org disable: the student stays logged in, but the org's tests vanish and can't be opened.
r = await call(student, '/api/my-assignments');
if (r.status !== 200) throw new Error('disabled student stays logged in (per-org disable), got ' + r.status);
if (r.data.assignments.length !== 0) throw new Error("a disabled org's tests should be hidden");
if ((await call(student, '/api/take/' + aid, 'GET', undefined, false)).status !== 403) throw new Error('disabled student should not open the test (403)');
ok('disabled: student stays logged in but the org’s tests are hidden and blocked (403)');

// The account itself is still usable — the student can still log in.
const fresh = makeJar();
if ((await call(fresh, '/api/login', 'POST', { email, password: 'pass123' }, false)).status !== 200) throw new Error('disabled student can still log in (per-org model)');
ok('disabled student can still log in (the account stays active)');

// Teacher list shows disabled.
let listed = (await call(teacher, '/api/students')).data.students.find((s) => s.email === email);
if (!listed.disabled) throw new Error('list should show disabled=true');
ok('student shows as disabled in the list');

// Re-enable → the test comes back.
await call(teacher, '/api/students/' + studentId, 'PATCH', { disabled: false });
r = await call(student, '/api/my-assignments');
if (r.data.assignments.length !== 1) throw new Error('re-enabled student should see the test again');
ok('re-enabling restores access to the org’s tests');

// A teacher cannot disable a student they do not own
const other = await registerTeacher(BASE, makeJar, call, { name: 'O', email: `o${rand}@x.com`, password: 'secret123' });
r = await call(other, '/api/students/' + studentId, 'PATCH', { disabled: true }, false);
if (r.status !== 404) throw new Error('non-owner should get 404, got ' + r.status);
ok('a teacher cannot disable another teacher’s student');

console.log('\n✅ DISABLE-TEST: ALL CHECKS PASSED\n');
