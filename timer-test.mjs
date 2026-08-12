import { registerTeacher } from './bootstrap.mjs';
// Tests the per-test timer: server-anchored start, resume, and single attempt.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

const tEmail = `rt${rand}@x.com`;
const teacher = await registerTeacher(BASE, makeJar, call, { name: 'RT', email: tEmail, password: 'secret123' });
if (!(await call(teacher, '/api/me')).data.user.isRoot) throw new Error('need root teacher');

const MCQ = { type: 'mcq', prompt: 'Pick A', options: ['A', 'B'], correct: 0, points: 1 };

// Timed test (30 minutes)
const timedId = (await call(teacher, '/api/tests', 'POST', { title: 'Timed', durationMinutes: 30, questions: [MCQ] })).data.id;
// Untimed test
const plainId = (await call(teacher, '/api/tests', 'POST', { title: 'Plain', questions: [MCQ] })).data.id;
ok('created a timed (30 min) and an untimed test');

// Student
const stok = (await call(teacher, '/api/students', 'POST', { name: 'S', email: `s${rand}@x.com`, phone: '9000000001' })).data.token;
const student = makeJar();
const su = (await call(student, '/api/signup/' + stok, 'POST', { password: 'pass123' })).data.user;
for (const id of [timedId, plainId]) await call(teacher, '/api/assignments', 'POST', { test_id: id, student_ids: [su.id] });
const mine = (await call(student, '/api/my-assignments')).data.assignments;
const aid = (testId) => mine.find((a) => a.testId === testId).assignmentId;

// Open the timed test -> timer info present, clock ~30 min
const t1 = (await call(student, '/api/take/' + aid(timedId))).data;
if (t1.durationMinutes !== 30) throw new Error('durationMinutes should be 30');
if (!(t1.remainingSeconds > 1790 && t1.remainingSeconds <= 1800)) throw new Error('remaining ~1800, got ' + t1.remainingSeconds);
ok('timed test returns a ~30:00 server-anchored countdown');

// Starting the test does not yet count as a submission
if ((await call(teacher, '/api/tests/' + timedId + '/results')).data.results.length !== 0)
  throw new Error('opening a timed test should not create a submitted attempt');
ok('opening the test creates an in-progress attempt (not submitted)');

// Reopen -> same clock keeps running (does not reset)
const t2 = (await call(student, '/api/take/' + aid(timedId))).data;
if (t2.remainingSeconds > t1.remainingSeconds) throw new Error('reopening must not reset the timer');
ok('reopening resumes the same countdown (no reset)');

// Submit -> finalizes the SAME attempt (no duplicate), shows as submitted
if ((await call(student, '/api/submit/' + aid(timedId), 'POST', { answers: {} })).status !== 200)
  throw new Error('submit should succeed');
const results = (await call(teacher, '/api/tests/' + timedId + '/results')).data.results;
if (results.length !== 1) throw new Error('expected exactly 1 submitted attempt, got ' + results.length);
ok('submitting finalizes the in-progress attempt (single attempt)');

// Cannot retake after submitting
if ((await call(student, '/api/take/' + aid(timedId), 'GET', undefined, false)).status !== 409)
  throw new Error('should not be able to retake after submit');
ok('cannot retake a submitted timed test');

// Untimed test has no timer
const p = (await call(student, '/api/take/' + aid(plainId))).data;
if (p.durationMinutes !== 0 || p.remainingSeconds !== null) throw new Error('untimed test should have no timer');
if ((await call(student, '/api/submit/' + aid(plainId), 'POST', { answers: {} })).status !== 200)
  throw new Error('untimed submit should work');
ok('untimed test has no timer and submits normally');

console.log('\n✅ TIMER-TEST: ALL CHECKS PASSED\n');
