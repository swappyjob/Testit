// Tests per-question sections end-to-end: storage/round-trip, exposure to
// students while taking, and exposure in the teacher's attempt review.
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

const teacher = makeJar();
await call(teacher, '/api/register-teacher', 'POST', { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });

// A test whose questions belong to different sections (one left unsectioned).
const { id: testId } = await call(teacher, '/api/tests', 'POST', {
  title: 'Sectioned Quiz',
  questions: [
    { type: 'multi', prompt: '2 + 2 = ?', options: ['3', '4', '5'], correct: [1], points: 1, section: 'Quantitative Aptitude' },
    { type: 'truefalse', prompt: 'Force = mass x acceleration', correct: 'true', points: 1, section: 'Physics' },
    { type: 'multi', prompt: 'H2O is water', options: ['Yes', 'No'], correct: [0], points: 1, section: 'Chemistry' },
    { type: 'short', prompt: 'Any thoughts?', points: 1 }, // no section
  ],
});
ok('created a test with questions in three sections');

// Stored + round-tripped on the test detail.
const loaded = await call(teacher, '/api/tests/' + testId);
const secByPrompt = Object.fromEntries(loaded.questions.map((q) => [q.prompt, q.section]));
if (secByPrompt['2 + 2 = ?'] !== 'Quantitative Aptitude') throw new Error('QA section not stored');
if (secByPrompt['Force = mass x acceleration'] !== 'Physics') throw new Error('Physics section not stored');
if (secByPrompt['H2O is water'] !== 'Chemistry') throw new Error('Chemistry section not stored');
if (secByPrompt['Any thoughts?'] !== '') throw new Error('unsectioned question should have empty section');
ok('sections are stored and returned on the test detail');

// A student sees each question's section while taking.
const { token } = await call(teacher, '/api/students', 'POST', { name: 'S', email: `s_${rand}@x.com`, phone: '9000000009' });
const student = makeJar();
const { user } = await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
const aid = (await call(student, '/api/my-assignments')).assignments[0].assignmentId;
const take = await call(student, '/api/take/' + aid);
const takeSec = Object.fromEntries(take.questions.map((q) => [q.prompt, q.section]));
if (takeSec['Force = mass x acceleration'] !== 'Physics') throw new Error('take-view missing section');
if (!('section' in take.questions[0])) throw new Error('take questions should include a section field');
ok('student take-view exposes each question section');

// Submit, then the teacher review shows the section per answer.
const payload = {};
take.questions.forEach((q) => { payload[q.id] = q.type === 'multi' ? '[1]' : q.type === 'truefalse' ? 'true' : ''; });
await call(student, '/api/submit/' + aid, 'POST', { answers: payload });
const { results } = await call(teacher, '/api/tests/' + testId + '/results');
const attemptId = results[0].attemptId;
const review = await call(teacher, '/api/attempts/' + attemptId);
const revSec = Object.fromEntries(review.items.map((it) => [it.prompt, it.section]));
if (revSec['2 + 2 = ?'] !== 'Quantitative Aptitude') throw new Error('review missing section');
ok('teacher attempt review exposes the section per question');

// Editing sections round-trips.
await call(teacher, '/api/tests/' + testId, 'PUT', {
  title: 'Sectioned Quiz', questions: [
    { type: 'truefalse', prompt: 'Force = mass x acceleration', correct: 'true', points: 1, section: 'Mechanics' },
  ],
});
const reloaded = await call(teacher, '/api/tests/' + testId);
if (reloaded.questions[0].section !== 'Mechanics') throw new Error('edited section did not persist');
ok('editing a question section persists');

console.log('\n✅ SECTION-TEST: ALL CHECKS PASSED\n');
