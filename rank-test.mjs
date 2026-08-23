import { registerTeacher } from './bootstrap.mjs';
// Live rank + percentile across everyone who has submitted a test.
//   rank       — competition ranking (ties share a rank)
//   percentile — NTA-style: 100 × (submissions at or below you) / total
// Recomputed on every request, so it shifts as more students finish.
const BASE = process.env.TEST_BASE || 'http://localhost:3000';
function makeJar() {
  const jar = {};
  return {
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => { for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [p] = c.split(';'); const i = p.indexOf('='); jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); } },
  };
}
async function call(jar, p, method = 'GET', body, expectOk = true) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res); let data = {}; try { data = await res.json(); } catch {}
  if (expectOk && !res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${data.error || 'error'}`);
  return { status: res.status, data };
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'Rank Coach', email: `rank${rand}@x.com`, password: 'secret123' });
// 3 true/false questions, each correct = 'true', 1 mark. Score = # answered true.
const { id: testId } = (await call(teacher, '/api/tests', 'POST', {
  title: 'Ranked Mock', questions: [
    { type: 'truefalse', prompt: 'Q1', correct: 'true', points: 1 },
    { type: 'truefalse', prompt: 'Q2', correct: 'true', points: 1 },
    { type: 'truefalse', prompt: 'Q3', correct: 'true', points: 1 },
  ],
})).data;

async function enrol(email) {
  const { token } = (await call(teacher, '/api/students', 'POST', { name: email, email, phone: '9000000001' })).data;
  const jar = makeJar();
  const { user } = (await call(jar, '/api/signup/' + token, 'POST', { password: 'pass123' })).data;
  await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
  const aid = (await call(jar, '/api/my-assignments')).data.assignments.find((a) => a.testId === testId).assignmentId;
  return { jar, aid };
}
// Submit answering the first `correct` questions 'true' (right) and the rest 'false' (wrong).
async function submit(s, score) {
  const qs = (await call(s.jar, '/api/take/' + s.aid)).data.questions;
  const answers = {}; qs.forEach((q, i) => { answers[q.id] = i < score ? 'true' : 'false'; });
  await call(s.jar, '/api/submit/' + s.aid, 'POST', { answers });
}
const rankOf = async (s) => (await call(s.jar, '/api/my-assignments/' + s.aid + '/rank')).data;

const A = await enrol(`a${rand}@x.com`); // will score 3
const B = await enrol(`b${rand}@x.com`); // will score 2
const C = await enrol(`c${rand}@x.com`); // will score 1
const D = await enrol(`d${rand}@x.com`); // will score 2 (ties with B)

// Before submitting, the rank endpoint refuses.
if ((await call(A.jar, '/api/my-assignments/' + A.aid + '/rank', 'GET', undefined, false)).status !== 409)
  throw new Error('rank should be unavailable before submitting');
ok('rank/percentile is unavailable until the student submits');

// A submits first: sole taker → rank 1, 100 percentile.
await submit(A, 3);
let ra = await rankOf(A);
if (ra.rank !== 1 || ra.total !== 1 || ra.percentile !== 100) throw new Error('lone submitter should be rank 1/1 at 100 percentile: ' + JSON.stringify(ra));
ok('first submitter is rank 1 of 1 at 100 percentile');

// B submits (score 2): now 2 takers. B is behind A.
await submit(B, 2);
let rb = await rankOf(B);
if (rb.rank !== 2 || rb.total !== 2 || rb.percentile !== 50) throw new Error('B should be rank 2/2 at 50 percentile: ' + JSON.stringify(rb));
ok('as a second student finishes, ranks/percentiles reflect the new field (rank 2/2, 50 %ile)');

// C (score 1) and D (score 2) finish → 4 takers, scores 3,2,2,1.
await submit(C, 1);
await submit(D, 2);

ra = await rankOf(A); rb = await rankOf(B);
const rc = await rankOf(C); const rd = await rankOf(D);
if (ra.rank !== 1 || ra.percentile !== 100) throw new Error('A wrong after all finished: ' + JSON.stringify(ra));
if (rb.rank !== 2 || rb.percentile !== 75) throw new Error('B wrong after all finished: ' + JSON.stringify(rb));
if (rd.rank !== 2 || rd.percentile !== 75) throw new Error('D should tie B at rank 2 / 75: ' + JSON.stringify(rd));
if (rc.rank !== 4 || rc.percentile !== 25) throw new Error('C should be rank 4 / 25 percentile: ' + JSON.stringify(rc));
if (rb.total !== 4) throw new Error('total takers should be 4');
ok('final standings: A rank1/100, B & D tie at rank2/75, C rank4/25 (ties share a rank)');

// B's percentile moved (50 → 75) purely because more students finished — proves
// the numbers are recomputed live, never cached.
if (rb.percentile !== 75) throw new Error('B percentile should have risen to 75 as others finished');
ok("B's percentile updated live as classmates finished (50 → 75)");

// The dashboard list carries the same live rank/percentile per submitted test.
const mine = (await call(B.jar, '/api/my-assignments')).data.assignments.find((a) => a.testId === testId);
if (mine.rank !== 2 || mine.percentile !== 75 || mine.totalTakers !== 4) throw new Error('my-assignments rank fields wrong: ' + JSON.stringify(mine));
ok('the my-assignments list exposes the same live rank/percentile/totalTakers');

console.log('\n✅ RANK-TEST: ALL CHECKS PASSED\n');
