// Tests the student's post-submission review: they can see all questions, their
// answers, and the correct answers only after submitting — and only their own.
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

async function makeStudent(teacher, name, email) {
  const { token } = (await call(teacher, '/api/students', 'POST', { name, email, phone: '9000000009' })).data;
  const jar = makeJar();
  const { user } = (await call(jar, '/api/signup/' + token, 'POST', { password: 'pass123' })).data;
  return { jar, user };
}

const teacher = makeJar();
await call(teacher, '/api/register-teacher', 'POST', { name: 'R', email: `r${rand}@x.com`, password: 'secret123' });
const { id: testId } = (await call(teacher, '/api/tests', 'POST', {
  title: 'Reviewable', questions: [
    { type: 'multi', prompt: 'Pick A', options: ['A', 'B'], correct: [0], points: 1, explanation: 'A is the right choice because it is first.' },
    { type: 'truefalse', prompt: 'Sky is green', correct: 'false', points: 1 },
    { type: 'short', prompt: 'Say hi', points: 1 },
  ],
})).data;

const s1 = await makeStudent(teacher, 'S1', `s1_${rand}@x.com`);
await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [s1.user.id] });
const aid = (await call(s1.jar, '/api/my-assignments')).data.assignments[0].assignmentId;

// Before submitting, review is not allowed.
if ((await call(s1.jar, '/api/my-review/' + aid, 'GET', undefined, false)).status !== 403)
  throw new Error('review before submit should be 403');
ok('review is blocked until the student submits (403)');

// Take and submit: multi correct, true/false wrong, short answered.
const take = await call(s1.jar, '/api/take/' + aid);
const byPrompt = {}; take.data.questions.forEach((q) => { byPrompt[q.prompt] = q; });
const payload = {
  [byPrompt['Pick A'].id]: '[0]',
  [byPrompt['Sky is green'].id]: 'true', // wrong (correct is false)
  [byPrompt['Say hi'].id]: 'hello',
};
await call(s1.jar, '/api/submit/' + aid, 'POST', { answers: payload });

// Now the student can review everything.
const rev = (await call(s1.jar, '/api/my-review/' + aid)).data;
if (rev.items.length !== 3) throw new Error('review should return all 3 questions');
const multi = rev.items.find((i) => i.prompt === 'Pick A');
if (multi.response !== '[0]' || multi.correctAnswer !== '[0]' || multi.isCorrect !== 1) throw new Error('multi review wrong');
if (multi.explanation !== 'A is the right choice because it is first.') throw new Error('explanation not returned in review');
const tf = rev.items.find((i) => i.prompt === 'Sky is green');
if (tf.response !== 'true' || tf.correctAnswer !== 'false' || tf.isCorrect !== 0) throw new Error('true/false review wrong');
const short = rev.items.find((i) => i.prompt === 'Say hi');
if (short.response !== 'hello' || short.isCorrect !== null) throw new Error('short review should be ungraded');
if (rev.score !== 1 || rev.maxScore !== 3 || !rev.needsGrading) throw new Error('review score summary wrong');
ok('after submit, review shows questions, the student answers and correct answers');

// A different student cannot review someone else's attempt.
const s2 = await makeStudent(teacher, 'S2', `s2_${rand}@x.com`);
if ((await call(s2.jar, '/api/my-review/' + aid, 'GET', undefined, false)).status !== 404)
  throw new Error('another student should not access this review');
ok('a student cannot review another student\'s attempt (404)');

console.log('\n✅ STUDENT-REVIEW-TEST: ALL CHECKS PASSED\n');
