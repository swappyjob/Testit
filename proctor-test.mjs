// Tests proctoring: per-test flags are stored and exposed to the student,
// and violation counts are recorded on submit and shown to the teacher.
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
const Q = [{ type: 'multi', prompt: 'q', options: ['a', 'b'], correct: [0], points: 1 }];

async function takeAndSubmit(teacher, testId, name, email, violations) {
  const { token } = await call(teacher, '/api/students', 'POST', { name, email, phone: '9000000009' });
  const student = makeJar();
  const { user } = await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
  await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
  const aid = (await call(student, '/api/my-assignments')).assignments[0].assignmentId;
  const take = await call(student, '/api/take/' + aid);
  const payload = {}; take.questions.forEach((q) => { payload[q.id] = q.type === 'multi' ? '[0]' : ''; });
  const result = await call(student, '/api/submit/' + aid, 'POST', { answers: payload, violations });
  return { take, result };
}

const teacher = makeJar();
await call(teacher, '/api/register-teacher', 'POST', { name: 'P', email: `p${rand}@x.com`, password: 'secret123' });

// A proctored test with a 2-violation limit.
const { id: testId } = await call(teacher, '/api/tests', 'POST', { title: 'Proctored', proctored: true, maxViolations: 2, questions: Q });
const loaded = (await call(teacher, '/api/tests/' + testId)).test;
if (!loaded.proctored || loaded.max_violations !== 2) throw new Error('proctoring flags not stored: ' + JSON.stringify([loaded.proctored, loaded.max_violations]));
ok('proctoring flags (on, limit 2) are stored on the test');

// The student's take-view exposes the flags so the browser can enforce them.
const r1 = await takeAndSubmit(teacher, testId, 'S1', `s1_${rand}@x.com`, 3);
if (!r1.take.test.proctored || r1.take.test.max_violations !== 2) throw new Error('take-view missing proctoring flags');
ok('student take-view exposes proctored + max_violations');

// The submitted violation count is recorded and shown to the teacher.
const res = await call(teacher, '/api/tests/' + testId + '/results');
if (!res.proctored) throw new Error('results should flag the test as proctored');
const row = res.results.find((r) => r.name === 'S1');
if (!row || row.violations !== 3) throw new Error('violations not recorded in results: ' + JSON.stringify(row));
ok('violation count is recorded and shown in the results list');

const review = await call(teacher, '/api/attempts/' + row.attemptId);
if (review.attempt.violations !== 3) throw new Error('attempt review missing violation count');
ok('attempt review shows the violation count');

// A non-proctored test defaults to off and records zero violations.
const { id: plainId } = await call(teacher, '/api/tests', 'POST', { title: 'Plain', questions: Q });
const r2 = await takeAndSubmit(teacher, plainId, 'S2', `s2_${rand}@x.com`, 0);
if (r2.take.test.proctored) throw new Error('plain test should not be proctored');
const plainRes = await call(teacher, '/api/tests/' + plainId + '/results');
if (plainRes.proctored) throw new Error('plain results should not be flagged proctored');
ok('a non-proctored test stays off with zero violations');

// Editing a test can toggle proctoring on.
await call(teacher, '/api/tests/' + plainId, 'PUT', { title: 'Plain', proctored: true, maxViolations: 5, questions: Q });
if ((await call(teacher, '/api/tests/' + plainId)).test.max_violations !== 5) throw new Error('edit did not persist proctoring');
ok('editing a test can enable proctoring');

console.log('\n✅ PROCTOR-TEST: ALL CHECKS PASSED\n');
