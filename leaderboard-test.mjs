// Tests the per-test toppers board: top students ranked by score (ties share a rank).
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

async function studentSubmit(teacher, testId, name, email, answersByPrompt) {
  const { token } = (await call(teacher, '/api/students', 'POST', { name, email, phone: '9000000009' })).data;
  const s = makeJar();
  const { user } = (await call(s, '/api/signup/' + token, 'POST', { password: 'pass123' })).data;
  await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
  const aid = (await call(s, '/api/my-assignments')).data.assignments[0].assignmentId;
  const take = await call(s, '/api/take/' + aid);
  const byPrompt = {}; take.data.questions.forEach((q) => { byPrompt[q.prompt] = q.id; });
  const payload = {}; for (const [p, v] of Object.entries(answersByPrompt)) payload[byPrompt[p]] = v;
  await call(s, '/api/submit/' + aid, 'POST', { answers: payload });
  return s;
}

const teacher = makeJar();
await call(teacher, '/api/register-teacher', 'POST', { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
const { id: testId } = (await call(teacher, '/api/tests', 'POST', {
  title: 'Ranked', questions: [
    { type: 'truefalse', prompt: 'A', correct: 'true', points: 1 },
    { type: 'truefalse', prompt: 'B', correct: 'false', points: 1 },
  ],
})).data;

// Empty board before anyone submits.
if ((await call(teacher, '/api/tests/' + testId + '/leaderboard')).data.leaderboard.length !== 0) throw new Error('leaderboard should start empty');
ok('leaderboard is empty before any submissions');

await studentSubmit(teacher, testId, 'Top', `top_${rand}@x.com`, { A: 'true', B: 'false' });   // 2/2
await studentSubmit(teacher, testId, 'Mid1', `m1_${rand}@x.com`, { A: 'true', B: 'true' });     // 1/2
const stu = await studentSubmit(teacher, testId, 'Mid2', `m2_${rand}@x.com`, { A: 'false', B: 'false' }); // 1/2

const lb = (await call(teacher, '/api/tests/' + testId + '/leaderboard')).data.leaderboard;
if (lb.length !== 3) throw new Error('expected 3 entries, got ' + lb.length);
if (lb[0].name !== 'Top' || lb[0].score !== 2 || lb[0].rank !== 1) throw new Error('top scorer should rank 1 with 2');
if (lb[1].score !== 1 || lb[1].rank !== 2 || lb[2].score !== 1 || lb[2].rank !== 2) throw new Error('tied 1-scorers should both be rank 2');
ok('leaderboard ranks by score, highest first, with ties sharing a rank');

// Students can't view the leaderboard.
if ((await call(stu, '/api/tests/' + testId + '/leaderboard', 'GET', undefined, false)).status !== 403)
  throw new Error('a student should not access the leaderboard');
ok('the leaderboard is teacher-only (403 for students)');

console.log('\n✅ LEADERBOARD-TEST: ALL CHECKS PASSED\n');
