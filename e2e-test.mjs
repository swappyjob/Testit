import { registerTeacher } from './bootstrap.mjs';
// Quick end-to-end test of the whole flow. Run while the server is up.
const BASE = process.env.TEST_BASE || 'http://localhost:3000';

function makeJar() {
  const jar = {};
  return {
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => {
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of sc) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
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
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || 'error'}`);
  return data;
}

const ok = (label) => console.log('  ✓ ' + label);
const rand = Math.floor(Math.random() * 1e6);

const student = makeJar();

// 1. Admin creates the teacher's organization, then the teacher logs in
const teacher = await registerTeacher(BASE, makeJar, call, {
  name: 'Ms Sharma', email: `teacher${rand}@example.com`, password: 'secret123',
});
ok('teacher registered & logged in');

// 2. Teacher creates a test with all 3 question types
const { id: testId } = await call(teacher, '/api/tests', 'POST', {
  title: 'Sample Quiz', description: 'A quick check',
  questions: [
    { type: 'mcq', prompt: 'Capital of France?', options: ['Paris', 'Rome', 'Berlin'], correct: 0, points: 2 },
    { type: 'truefalse', prompt: 'The sky is green.', correct: 'false', points: 1 },
    { type: 'short', prompt: 'Explain gravity in one line.', points: 3 },
  ],
});
ok('test created (id ' + testId + ')');

// 3. Teacher creates a student -> signup link
const { token } = await call(teacher, '/api/students', 'POST', {
  name: 'Rahul', email: `student${rand}@example.com`, phone: '+91 90000 00001',
});
ok('student created, signup token issued');

// 4. Student completes signup
const { user: studentUser } = await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
ok('student signed up & logged in (id ' + studentUser.id + ')');

// 5. Teacher assigns the test to the student
const { assigned } = await call(teacher, '/api/assignments', 'POST', {
  test_id: testId, student_ids: [studentUser.id],
});
if (assigned !== 1) throw new Error('expected 1 assignment, got ' + assigned);
ok('test assigned to student');

// 6. Student loads assignments + the test (should NOT expose correct answers)
const { assignments } = await call(student, '/api/my-assignments');
const assignmentId = assignments[0].assignmentId;
const take = await call(student, '/api/take/' + assignmentId);
if (JSON.stringify(take).includes('correct_answer')) throw new Error('correct answers leaked to student!');
ok('student fetched test without answer leakage');

// 7. Student submits: correct MCQ, correct T/F, a written short answer
const qByType = {};
take.questions.forEach((q) => { qByType[q.type] = q; });
const submit = await call(student, '/api/submit/' + assignmentId, 'POST', {
  answers: {
    [qByType.mcq.id]: '0',        // Paris (correct) -> 2 pts
    [qByType.truefalse.id]: 'false', // correct -> 1 pt
    [qByType.short.id]: 'Mass attracts mass.',
  },
});
if (submit.autoScore !== 3) throw new Error('expected autoScore 3, got ' + submit.autoScore);
if (submit.maxScore !== 6) throw new Error('expected maxScore 6, got ' + submit.maxScore);
if (!submit.needsGrading) throw new Error('expected needsGrading true');
ok(`student submitted: auto ${submit.autoScore}/${submit.maxScore}, needs grading`);

// 8. Re-submit should be blocked
let blocked = false;
try { await call(student, '/api/submit/' + assignmentId, 'POST', { answers: {} }); }
catch { blocked = true; }
if (!blocked) throw new Error('re-submission was NOT blocked');
ok('re-submission correctly blocked');

// 9. Teacher views results and grades the short answer
const { results } = await call(teacher, '/api/tests/' + testId + '/results');
const attemptId = results[0].attemptId;
if (!results[0].needsGrading) throw new Error('result should need grading');
const { items } = await call(teacher, '/api/attempts/' + attemptId);
const shortItem = items.find((i) => i.type === 'short');
await call(teacher, '/api/attempts/' + attemptId + '/grade', 'POST', {
  grades: { [shortItem.answerId]: 3 },
});
ok('teacher graded short answer (+3)');

// 10. Final score should be 6/6, no longer needs grading
const after = await call(teacher, '/api/tests/' + testId + '/results');
if (after[0]) {}
if (after.results[0].score !== 6) throw new Error('expected final score 6, got ' + after.results[0].score);
if (after.results[0].needsGrading) throw new Error('should no longer need grading');
ok('final score 6/6, grading complete');

console.log('\n✅ ALL END-TO-END CHECKS PASSED\n');
