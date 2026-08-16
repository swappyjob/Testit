import { registerTeacher } from './bootstrap.mjs';
// Tests the per-student access end date (auto-disable after the date).
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
const PAST = ymd(-1);
const FUTURE = ymd(1);

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });

async function makeStudent(label, email, accessUntil) {
  const tok = (await call(teacher, '/api/students', 'POST', { name: label, email, phone: '9000000000', accessUntil })).data.token;
  const jar = makeJar();
  const user = (await call(jar, '/api/signup/' + tok, 'POST', { password: 'pass123' })).data.user;
  return { jar, user };
}

// Student with a FUTURE end date works normally.
const futEmail = `fut${rand}@x.com`;
const fut = await makeStudent('Future', futEmail, FUTURE);
if ((await call(fut.jar, '/api/me')).data.user === null) throw new Error('future-dated student should be active');
if ((await call(makeJar(), '/api/login', 'POST', { email: futEmail, password: 'pass123' }, false)).status !== 200)
  throw new Error('future-dated student should log in');
ok('student with a future end date can log in and use the app');

// Student with a PAST end date: access is per-organization now, so they stay
// logged in but that org's tests are hidden.
const expEmail = `exp${rand}@x.com`;
const exp = await makeStudent('Expired', expEmail, PAST);
if ((await call(exp.jar, '/api/me')).data.user === null)
  throw new Error('expired student should still be logged in (per-org access)');
if ((await call(makeJar(), '/api/login', 'POST', { email: expEmail, password: 'pass123' }, false)).status !== 200)
  throw new Error('expired student should still be able to log in');
const { id: expTestId } = (await call(teacher, '/api/tests', 'POST', { title: 'ExpT', questions: [{ type: 'truefalse', prompt: 'A', correct: 'true', points: 1 }] })).data;
await call(teacher, '/api/assignments', 'POST', { test_id: expTestId, student_ids: [exp.user.id] });
if ((await call(exp.jar, '/api/my-assignments')).data.assignments.length !== 0)
  throw new Error("an expired student should not see the org's tests");
ok('student past their end date stays logged in, but the org’s tests are hidden');

// Student with no end date works.
const noEmail = `no${rand}@x.com`;
await makeStudent('NoDate', noEmail, '');
if ((await call(makeJar(), '/api/login', 'POST', { email: noEmail, password: 'pass123' }, false)).status !== 200)
  throw new Error('student without an end date should log in');
ok('student with no end date is unaffected');

// The teacher list reflects the dates and expiry.
const students = (await call(teacher, '/api/students')).data.students;
const e = students.find((s) => s.email === expEmail);
const f = students.find((s) => s.email === futEmail);
if (!e || e.accessUntil !== PAST || !e.expired) throw new Error('expired student not flagged in list');
if (!f || f.accessUntil !== FUTURE || f.expired) throw new Error('future student wrongly flagged');
ok('teacher list shows access dates and the expired flag');

// An invalid date is ignored (treated as no expiry).
const badEmail = `bad${rand}@x.com`;
await call(teacher, '/api/students', 'POST', { name: 'Bad', email: badEmail, phone: '9000000000', accessUntil: 'not-a-date' });
const bad = (await call(teacher, '/api/students')).data.students.find((s) => s.email === badEmail);
if (bad.accessUntil !== '' || bad.expired) throw new Error('invalid date should become no-expiry');
ok('invalid date is ignored (no expiry)');

console.log('\n✅ ACCESS-TEST: ALL CHECKS PASSED\n');
