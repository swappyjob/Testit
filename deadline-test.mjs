import { registerTeacher } from './bootstrap.mjs';
// Tests the per-test end date (deadline) enforcement.
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

// Build a datetime-local string (YYYY-MM-DDTHH:MM) offset from now.
function localDT(offsetMs) {
  const d = new Date(Date.now() + offsetMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const PAST = localDT(-60 * 60 * 1000);      // 1 hour ago
const FUTURE = localDT(24 * 60 * 60 * 1000); // tomorrow

const student = makeJar();
const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });

const mkTest = (title, dueDate) => call(teacher, '/api/tests', 'POST', {
  title, dueDate,
  questions: [{ type: 'mcq', prompt: 'Pick A', options: ['A', 'B'], correct: 0, points: 1 }],
});
const past = (await mkTest('Past', PAST)).data.id;
const future = (await mkTest('Future', FUTURE)).data.id;
const none = (await mkTest('NoDeadline', '')).data.id;
ok('created past / future / no-deadline tests');

// Teacher list reflects the closed flag
const tests = (await call(teacher, '/api/tests')).data.tests;
const byId = Object.fromEntries(tests.map((t) => [t.id, t]));
if (!byId[past].closed) throw new Error('past test should be closed');
if (byId[future].closed) throw new Error('future test should be open');
if (byId[none].closed) throw new Error('no-deadline test should be open');
ok('teacher list: closed flag correct for each test');

// Assign all three to a student
const { token } = (await call(teacher, '/api/students', 'POST', { name: 'S', email: `s${rand}@x.com`, phone: '9000000000' })).data;
const { user: su } = (await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' })).data;
for (const id of [past, future, none]) await call(teacher, '/api/assignments', 'POST', { test_id: id, student_ids: [su.id] });
ok('assigned all three to the student');

const mine = (await call(student, '/api/my-assignments')).data.assignments;
const aFor = (testId) => mine.find((a) => a.testId === testId);
if (!aFor(past).closed) throw new Error('student view: past should be closed');
if (aFor(future).closed) throw new Error('student view: future should be open');
ok('student dashboard shows past test as closed');

// Past test: cannot open or submit
let r = await call(student, '/api/take/' + aFor(past).assignmentId, 'GET', undefined, false);
if (r.status !== 403) throw new Error('opening a closed test should be 403, got ' + r.status);
r = await call(student, '/api/submit/' + aFor(past).assignmentId, 'POST', { answers: {} }, false);
if (r.status !== 403) throw new Error('submitting a closed test should be 403, got ' + r.status);
ok('closed test blocks both open and submit (403)');

// Future test: can open and submit
r = await call(student, '/api/take/' + aFor(future).assignmentId);
if (r.status !== 200) throw new Error('future test should open');
const qid = r.data.questions[0].id;
r = await call(student, '/api/submit/' + aFor(future).assignmentId, 'POST', { answers: { [qid]: '0' } });
if (r.status !== 200 || r.data.autoScore !== 1) throw new Error('future test should submit and score 1');
ok('open test can be taken and submitted normally');

// No-deadline test also works
r = await call(student, '/api/take/' + aFor(none).assignmentId);
if (r.status !== 200) throw new Error('no-deadline test should open');
ok('test with no deadline is always open');

// Editing a test to a past date closes it
await call(teacher, '/api/tests/' + none, 'PUT', {
  title: 'NoDeadline', dueDate: PAST,
  questions: [{ type: 'mcq', prompt: 'Pick A', options: ['A', 'B'], correct: 0, points: 1 }],
});
const mine2 = (await call(student, '/api/my-assignments')).data.assignments;
if (!mine2.find((a) => a.testId === none).closed) throw new Error('edited test should now be closed');
ok('editing a deadline into the past closes the test');

console.log('\n✅ DEADLINE-TEST: ALL CHECKS PASSED\n');
