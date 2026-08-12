import { registerTeacher } from './bootstrap.mjs';
// Tests the new "edit a test" feature end-to-end.
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
async function call(jar, path, method = 'GET', body) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res);
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || 'error'}`);
  return data;
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);
const student = makeJar();

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
const { id: testId } = await call(teacher, '/api/tests', 'POST', {
  title: 'Original Title',
  questions: [
    { type: 'mcq', prompt: '2+2?', options: ['3', '4', '5'], correct: 1, points: 1 },
    { type: 'short', prompt: 'Explain.', points: 2 },
  ],
});
ok('created test');

// Student submits it
const { token } = await call(teacher, '/api/students', 'POST', { name: 'S', email: `s${rand}@x.com`, phone: '9000000002' });
const { user: su } = await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [su.id] });
const { assignments } = await call(student, '/api/my-assignments');
const aid = assignments[0].assignmentId;
const take = await call(student, '/api/take/' + aid);
const mcqId = take.questions.find((q) => q.type === 'mcq').id;
await call(student, '/api/submit/' + aid, 'POST', { answers: { [mcqId]: '1' } });
ok('student submitted');

// submitted_count should now be 1
let list = (await call(teacher, '/api/tests')).tests.find((t) => t.id === testId);
if (list.submitted_count !== 1) throw new Error('expected submitted_count 1, got ' + list.submitted_count);
ok('submitted_count reflects 1 submission');

// Capture the student's attempt before editing, to prove it survives.
const attemptId = (await call(teacher, '/api/tests/' + testId + '/results')).results[0].attemptId;

// EDIT: change title, change mcq choices/correct, add a true/false, drop short
const upd = await call(teacher, '/api/tests/' + testId, 'PUT', {
  title: 'Edited Title',
  description: 'now with changes',
  questions: [
    { type: 'mcq', prompt: 'Capital of Japan?', options: ['Tokyo', 'Osaka'], correct: 0, points: 3 },
    { type: 'truefalse', prompt: 'Water is wet.', correct: 'true', points: 1 },
  ],
});
if (upd.keptAttempts !== 1) throw new Error('expected keptAttempts 1, got ' + upd.keptAttempts);
ok('edited test; existing submission preserved (not cleared)');

// The student's past submission is still there
list = (await call(teacher, '/api/tests')).tests.find((t) => t.id === testId);
if (list.submitted_count !== 1) throw new Error('expected submitted_count still 1, got ' + list.submitted_count);
ok('submitted_count still 1 after edit');

// The preserved attempt still shows the ORIGINAL questions the student saw
const { items } = await call(teacher, '/api/attempts/' + attemptId);
if (!items.some((it) => it.prompt === '2+2?')) throw new Error('original question lost from past attempt');
ok('past attempt still shows the original questions & score');

// The active (current) version has the new questions
const detail = await call(teacher, '/api/tests/' + testId);
if (detail.test.title !== 'Edited Title') throw new Error('title not updated');
if (detail.questions.length !== 2) throw new Error('expected 2 active questions, got ' + detail.questions.length);
if (detail.questions[0].prompt !== 'Capital of Japan?') throw new Error('q1 not updated');
if (detail.questions[0].correct_answer !== '0') throw new Error('mcq correct not updated');
ok('current version has the new questions & answers');

// The student who already submitted cannot retake (their result stays)
let retakeBlocked = false;
try { await call(student, '/api/take/' + aid); } catch { retakeBlocked = true; }
if (!retakeBlocked) throw new Error('already-submitted student should not be able to retake');
ok('already-submitted student cannot retake');

// A fresh student assigned now gets the NEW version
const student2 = makeJar();
const { token: token2 } = await call(teacher, '/api/students', 'POST', { name: 'S2', email: `s2_${rand}@x.com`, phone: '9000000001' });
const { user: su2 } = await call(student2, '/api/signup/' + token2, 'POST', { password: 'pass123' });
await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [su2.id] });
const mine2 = await call(student2, '/api/my-assignments');
const take2 = await call(student2, '/api/take/' + mine2.assignments[0].assignmentId);
if (take2.questions.length !== 2 || take2.questions[0].prompt !== 'Capital of Japan?')
  throw new Error('new student did not get the edited version');
ok('a new student gets the edited version');

// Non-owner cannot edit
const other = await registerTeacher(BASE, makeJar, call, { name: 'O', email: `o${rand}@x.com`, password: 'secret123' });
let blocked = false;
try { await call(other, '/api/tests/' + testId, 'PUT', { title: 'hack', questions: [{ type: 'short', prompt: 'x', points: 1 }] }); }
catch { blocked = true; }
if (!blocked) throw new Error('another teacher was able to edit the test!');
ok('another teacher cannot edit another teachers test');

console.log('\n✅ EDIT-TEST: ALL CHECKS PASSED\n');
