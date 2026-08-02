// Tests the negative-marking feature end-to-end.
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

async function makeStudentAndTake(teacher, testId, name, email, answers) {
  const { token } = await call(teacher, '/api/students', 'POST', { name, email, phone: '9000000009' });
  const student = makeJar();
  const { user } = await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
  await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
  const { assignments } = await call(student, '/api/my-assignments');
  const aid = assignments[0].assignmentId;
  const take = await call(student, '/api/take/' + aid);
  const byPrompt = {};
  take.questions.forEach((q) => { byPrompt[q.prompt] = q; });
  const payload = {};
  for (const [prompt, val] of Object.entries(answers)) payload[byPrompt[prompt].id] = val;
  return { take, result: await call(student, '/api/submit/' + aid, 'POST', { answers: payload }) };
}

const teacher = makeJar();
await call(teacher, '/api/register-teacher', 'POST', { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });

// Test WITH negative marking: penalty 2 per wrong answer.
const { id: testId } = await call(teacher, '/api/tests', 'POST', {
  title: 'Neg Quiz', negativeMarking: true, penalty: 2,
  questions: [
    { type: 'mcq', prompt: 'A', options: ['x', 'y'], correct: 0, points: 4 },        // correct -> +4
    { type: 'mcq', prompt: 'B', options: ['x', 'y'], correct: 0, points: 4 },        // wrong   -> -2
    { type: 'truefalse', prompt: 'C', correct: 'true', points: 4 },                  // blank   -> 0
  ],
});
ok('created test with negative marking (penalty 2)');

// Student answers: A correct, B wrong, C blank => 4 - 2 + 0 = 2 (max 12)
const r1 = await makeStudentAndTake(teacher, testId, 'S1', `s1_${rand}@x.com`, { A: '0', B: '1', C: '' });
if (r1.take.test.negative_marking !== 1) throw new Error('take should expose negative_marking');
if (r1.take.test.penalty !== 2) throw new Error('take should expose penalty 2');
if (r1.result.autoScore !== 2) throw new Error('expected score 2, got ' + r1.result.autoScore);
if (r1.result.maxScore !== 12) throw new Error('expected maxScore 12, got ' + r1.result.maxScore);
ok('correct(+4) + wrong(-2) + blank(0) = 2 / 12');

// Student answers all wrong: -2 -2 -2 = -6 (negative totals are allowed)
const r2 = await makeStudentAndTake(teacher, testId, 'S2', `s2_${rand}@x.com`, { A: '1', B: '1', C: 'false' });
if (r2.result.autoScore !== -6) throw new Error('expected -6, got ' + r2.result.autoScore);
ok('all wrong = -6 (negative total shown, not floored)');

// Teacher results reflect the negative scores
const { results } = await call(teacher, '/api/tests/' + testId + '/results');
const s2 = results.find((r) => r.name === 'S2');
if (s2.score !== -6) throw new Error('teacher view: expected -6 for S2, got ' + s2.score);
ok('teacher results show the negative score');

// Control: SAME answers but NO negative marking -> wrong answers cost nothing
const { id: testId2 } = await call(teacher, '/api/tests', 'POST', {
  title: 'Plain Quiz', negativeMarking: false,
  questions: [
    { type: 'mcq', prompt: 'A', options: ['x', 'y'], correct: 0, points: 4 },
    { type: 'mcq', prompt: 'B', options: ['x', 'y'], correct: 0, points: 4 },
    { type: 'truefalse', prompt: 'C', correct: 'true', points: 4 },
  ],
});
const r3 = await makeStudentAndTake(teacher, testId2, 'S3', `s3_${rand}@x.com`, { A: '0', B: '1', C: '' });
if (r3.take.test.negative_marking !== 0) throw new Error('control should have no negative marking');
if (r3.result.autoScore !== 4) throw new Error('control: expected 4 (no penalty), got ' + r3.result.autoScore);
ok('control test: same answers score 4 (no penalty applied)');

// Editing a test can toggle negative marking on
await call(teacher, '/api/tests/' + testId2, 'PUT', {
  title: 'Plain Quiz', negativeMarking: true, penalty: 1,
  questions: [
    { type: 'mcq', prompt: 'A', options: ['x', 'y'], correct: 0, points: 4 },
    { type: 'mcq', prompt: 'B', options: ['x', 'y'], correct: 0, points: 4 },
    { type: 'truefalse', prompt: 'C', correct: 'true', points: 4 },
  ],
});
const check = (await call(teacher, '/api/tests/' + testId2)).test;
if (check.negative_marking !== 1 || check.penalty !== 1) throw new Error('edit did not enable negative marking');
ok('editing a test can enable negative marking');

console.log('\n✅ NEGMARK-TEST: ALL CHECKS PASSED\n');
