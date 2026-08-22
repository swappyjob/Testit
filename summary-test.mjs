import { registerTeacher } from './bootstrap.mjs';
// The teacher "Home" summary: counts, submissions, average score, pending
// grading, and recent tests.
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
async function call(jar, p, method = 'GET', body, expectOk = true) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res);
  let data = {}; try { data = await res.json(); } catch {}
  if (expectOk && !res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${data.error || 'error'}`);
  return { status: res.status, data };
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);

async function enrolAndSubmit(teacher, testId, email, answersByPrompt) {
  const { token } = (await call(teacher, '/api/students', 'POST', { name: email, email, phone: '9000000001' })).data;
  const s = makeJar();
  const { user } = (await call(s, '/api/signup/' + token, 'POST', { password: 'pass123' })).data;
  await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
  const aid = (await call(s, '/api/my-assignments')).data.assignments.find((a) => a.testId === testId).assignmentId;
  const qs = (await call(s, '/api/take/' + aid)).data.questions;
  const answers = {}; qs.forEach((q) => { if (answersByPrompt[q.prompt] !== undefined) answers[q.id] = answersByPrompt[q.prompt]; });
  await call(s, '/api/submit/' + aid, 'POST', { answers });
}

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'Anita Roy', email: `t${rand}@x.com`, password: 'secret123' });

// Fresh org: no tests/students, one teacher (self), nothing submitted.
let s = (await call(teacher, '/api/teacher/summary')).data;
if (s.tests !== 0 || s.students !== 0 || s.teachers !== 1) throw new Error('fresh summary counts wrong: ' + JSON.stringify(s));
if (s.submissions !== 0 || s.pendingGrading !== 0 || s.avgScorePct !== null || s.recentTests.length !== 0) throw new Error('fresh summary aggregates wrong');
ok('fresh org summary: 0 tests, 0 students, 1 teacher, no submissions, avg null');

// An auto-graded test, fully correct submission → avg 100%, no pending grading.
const { id: t1 } = (await call(teacher, '/api/tests', 'POST', {
  title: 'Quiz One', questions: [{ type: 'truefalse', prompt: 'A', correct: 'true', points: 1 }],
})).data;
await enrolAndSubmit(teacher, t1, `s1_${rand}@x.com`, { A: 'true' });
s = (await call(teacher, '/api/teacher/summary')).data;
if (s.tests !== 1 || s.students !== 1) throw new Error('after 1 test + 1 student: counts wrong: ' + JSON.stringify(s));
if (s.submissions !== 1 || s.avgScorePct !== 100 || s.pendingGrading !== 0) throw new Error('aggregates after a correct submission wrong: ' + JSON.stringify(s));
if (!s.recentTests.find((r) => r.id === t1 && r.submitted === 1)) throw new Error('recentTests should include the test with 1 submission');
ok('after a fully-correct submission: 1 submission, avg 100%, 0 pending, test listed in recent');

// A short-answer test → its submission needs grading (counts as pending).
const { id: t2 } = (await call(teacher, '/api/tests', 'POST', {
  title: 'Quiz Two', questions: [{ type: 'short', prompt: 'Explain', points: 5 }],
})).data;
await enrolAndSubmit(teacher, t2, `s2_${rand}@x.com`, { Explain: 'because' });
s = (await call(teacher, '/api/teacher/summary')).data;
if (s.tests !== 2 || s.students !== 2 || s.submissions !== 2) throw new Error('after 2nd test: counts wrong: ' + JSON.stringify(s));
if (s.pendingGrading !== 1) throw new Error('a short-answer submission should be pending grading, got ' + s.pendingGrading);
ok('a short-answer submission is counted as awaiting grading');

// Only the teacher's own tests count (another teacher's are separate).
const other = await registerTeacher(BASE, makeJar, call, { name: 'Other', email: `o${rand}@x.com`, password: 'secret123' });
if ((await call(other, '/api/teacher/summary')).data.tests !== 0) throw new Error("summary must be scoped to the teacher's own tests");
ok('summary is scoped per teacher (a new teacher sees 0 tests)');

console.log('\n✅ SUMMARY-TEST: ALL CHECKS PASSED\n');
