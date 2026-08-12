import { registerTeacher } from './bootstrap.mjs';
// Tests that a student can resume an in-progress test: answers + position are
// auto-saved on the server and restored on reopening, until submitted.
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

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
const { id: testId } = (await call(teacher, '/api/tests', 'POST', {
  title: 'Resumable', questions: [
    { type: 'truefalse', prompt: 'Q1', correct: 'true', points: 1 },
    { type: 'truefalse', prompt: 'Q2', correct: 'false', points: 1 },
  ],
})).data;
const { token } = (await call(teacher, '/api/students', 'POST', { name: 'S', email: `s_${rand}@x.com`, phone: '9000000009' })).data;
const student = makeJar();
const { user } = (await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' })).data;
await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
const aid = (await call(student, '/api/my-assignments')).data.assignments[0].assignmentId;

// First open: nothing saved yet, position 0.
const take1 = (await call(student, '/api/take/' + aid)).data;
if (Object.keys(take1.savedAnswers || {}).length !== 0 || take1.currentIndex !== 0) throw new Error('fresh take should have no saved progress');
const q1 = take1.questions[0].id;
ok('opening a test starts with no saved progress');

// Now the dashboard shows it as in-progress ("Resume").
if (!(await call(student, '/api/my-assignments')).data.assignments[0].started) throw new Error('assignment should be marked started after opening');
ok('assignment is flagged in-progress after opening');

// Auto-save partial answers + position.
await call(student, '/api/take/' + aid + '/progress', 'POST', { answers: { [q1]: 'true' }, currentIndex: 1 });
ok('progress (answers + position) auto-saves');

// Reopen (simulate reconnect): saved answers + position come back.
const take2 = (await call(student, '/api/take/' + aid)).data;
if (take2.savedAnswers[q1] !== 'true' || take2.currentIndex !== 1) throw new Error('resume did not restore saved answers/position');
ok('reopening restores the saved answers and position');

// Submit; afterwards progress is a no-op and the test can't be reopened.
const q2 = take2.questions[1].id;
const result = (await call(student, '/api/submit/' + aid, 'POST', { answers: { [q1]: 'true', [q2]: 'false' } })).data;
if (result.autoScore !== 2) throw new Error('submit should score 2, got ' + result.autoScore);
if ((await call(student, '/api/take/' + aid + '/progress', 'POST', { answers: {}, currentIndex: 0 })).data.ok !== false)
  throw new Error('progress after submit should be a no-op');
if ((await call(student, '/api/take/' + aid, 'GET', undefined, false)).status !== 409)
  throw new Error('a submitted test cannot be reopened');
ok('after submit, progress stops and the test is locked');

console.log('\n✅ RESUME-TEST: ALL CHECKS PASSED\n');
