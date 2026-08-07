// Tests multiple-answer (checkbox) questions end-to-end:
// storage, no answer-key leak to students, all-or-nothing grading, negative marking.
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

// answers: { prompt: responseString }. For multi, responseString is a JSON
// array of selected option indices, e.g. "[0,2]".
async function takeWith(teacher, testId, name, email, answers) {
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

// A test with one multi question: correct answers are A, B, C (indices 0,1,2) of A,B,C,D.
const { id: testId } = await call(teacher, '/api/tests', 'POST', {
  title: 'Multi Quiz',
  questions: [
    { type: 'multi', prompt: 'Pick A B C', options: ['A', 'B', 'C', 'D'], correct: [0, 1, 2], points: 6 },
  ],
});
ok('created a test with a multiple-answer question');

// Stored correctly: type multi, 4 options, correct key is the sorted index set.
const loaded = await call(teacher, '/api/tests/' + testId);
const q0 = loaded.questions[0];
if (q0.type !== 'multi') throw new Error('question type should be multi');
if (JSON.stringify(q0.options) !== JSON.stringify(['A', 'B', 'C', 'D'])) throw new Error('options not stored');
if (q0.correct_answer !== '[0,1,2]') throw new Error('correct key wrong: ' + q0.correct_answer);
ok('stored with type=multi, options, and correct set "[0,1,2]"');

// The student take-view must NOT leak the answer key.
const peek = await takeWith(teacher, testId, 'Peek', `peek_${rand}@x.com`, { 'Pick A B C': '[]' });
// (submitted blank above just to reuse the helper; check the fetched question shape)
if (peek.take.questions[0].correct_answer !== undefined || peek.take.questions[0].correct !== undefined)
  throw new Error('take-view leaked the answer key');
if (peek.result.autoScore !== 0) throw new Error('blank multi should score 0');
ok('student take-view hides the answer key; blank scores 0 / 6');

// Exact match (order-independent) => full marks.
const exact = await takeWith(teacher, testId, 'Exact', `ex_${rand}@x.com`, { 'Pick A B C': '[2,0,1]' });
if (exact.result.autoScore !== 6 || exact.result.maxScore !== 6) throw new Error('exact match should be 6/6, got ' + exact.result.autoScore);
ok('selecting exactly A,B,C (any order) = full 6 / 6');

// Partial selection (missing one) => 0.
const partial = await takeWith(teacher, testId, 'Partial', `pa_${rand}@x.com`, { 'Pick A B C': '[0,1]' });
if (partial.result.autoScore !== 0) throw new Error('partial should score 0, got ' + partial.result.autoScore);
ok('partial selection (A,B) scores 0 (all-or-nothing)');

// Superset (extra wrong one) => 0.
const superset = await takeWith(teacher, testId, 'Super', `su_${rand}@x.com`, { 'Pick A B C': '[0,1,2,3]' });
if (superset.result.autoScore !== 0) throw new Error('superset should score 0, got ' + superset.result.autoScore);
ok('over-selecting (A,B,C,D) scores 0 (all-or-nothing)');

// Negative marking: a wrong multi answer costs the penalty; exact still earns full.
const { id: negId } = await call(teacher, '/api/tests', 'POST', {
  title: 'Multi Neg', negativeMarking: true, penalty: 2,
  questions: [
    { type: 'multi', prompt: 'Pick A and C', options: ['A', 'B', 'C', 'D'], correct: [0, 2], points: 4 },
  ],
});
const negWrong = await takeWith(teacher, negId, 'NW', `nw_${rand}@x.com`, { 'Pick A and C': '[0,1]' });
if (negWrong.result.autoScore !== -2) throw new Error('wrong multi with neg marking should be -2, got ' + negWrong.result.autoScore);
const negRight = await takeWith(teacher, negId, 'NR', `nr_${rand}@x.com`, { 'Pick A and C': '[2,0]' });
if (negRight.result.autoScore !== 4) throw new Error('exact multi should be +4, got ' + negRight.result.autoScore);
const negBlank = await takeWith(teacher, negId, 'NB', `nb_${rand}@x.com`, { 'Pick A and C': '[]' });
if (negBlank.result.autoScore !== 0) throw new Error('blank multi must not be penalized, got ' + negBlank.result.autoScore);
ok('negative marking: wrong=-2, exact=+4, blank=0');

// Teacher review shows the multi answer graded.
const { results } = await call(teacher, '/api/tests/' + testId + '/results');
const exRow = results.find((r) => r.name === 'Exact');
if (!exRow || exRow.score !== 6) throw new Error('teacher results should show 6 for Exact');
ok('teacher results reflect the multi-answer score');

// Editing round-trips the correct set.
await call(teacher, '/api/tests/' + testId, 'PUT', {
  title: 'Multi Quiz', questions: [
    { type: 'multi', prompt: 'Pick A B C', options: ['A', 'B', 'C', 'D'], correct: [1, 3], points: 6 },
  ],
});
const reloaded = (await call(teacher, '/api/tests/' + testId)).questions[0];
if (reloaded.correct_answer !== '[1,3]') throw new Error('edit did not persist new correct set: ' + reloaded.correct_answer);
ok('editing a multi question persists the new correct set');

console.log('\n✅ MULTI-TEST: ALL CHECKS PASSED\n');
