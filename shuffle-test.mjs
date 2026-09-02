import { registerTeacher } from './bootstrap.mjs';
// Per-student question-order shuffling: each student gets a random order (within
// sections), the order is frozen across reloads, and — critically — grading is
// unaffected because answers are keyed by question id.
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
  return data;
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);
const sectionsContiguous = (qs) => { const seen = new Set(); let last = null; for (const q of qs) { if (q.section !== last) { if (seen.has(q.section)) return false; seen.add(q.section); last = q.section; } } return true; };

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `sh${rand}@x.com`, password: 'secret123' });

// A shuffled test: 6 MCQs across two sections, each worth 2 (total 12).
const Qs = [
  { type: 'mcq', section: 'Physics', prompt: 'P1', options: ['w', 'x'], correct: 0, points: 2 },
  { type: 'mcq', section: 'Physics', prompt: 'P2', options: ['w', 'x'], correct: 1, points: 2 },
  { type: 'mcq', section: 'Physics', prompt: 'P3', options: ['w', 'x'], correct: 0, points: 2 },
  { type: 'mcq', section: 'Chemistry', prompt: 'C1', options: ['w', 'x'], correct: 1, points: 2 },
  { type: 'mcq', section: 'Chemistry', prompt: 'C2', options: ['w', 'x'], correct: 0, points: 2 },
  { type: 'mcq', section: 'Chemistry', prompt: 'C3', options: ['w', 'x'], correct: 1, points: 2 },
];
const correctByPrompt = Object.fromEntries(Qs.map((q) => [q.prompt, q.correct]));
const { id: testId } = await call(teacher, '/api/tests', 'POST', { title: 'Shuffled Mock', shuffleQuestions: true, questions: Qs });
ok('a test can be created with question shuffling enabled');

// Helper: sign up a student and assign the test.
async function newStudent(tag) {
  const email = `${tag}${rand}@x.com`;
  const { token } = await call(teacher, '/api/students', 'POST', { name: tag, email, phone: '9000000001' });
  const jar = makeJar();
  const { user } = await call(jar, '/api/signup/' + token, 'POST', { password: 'pass123' });
  await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
  const aid = (await call(jar, '/api/my-assignments')).assignments.find((a) => a.testId === testId).assignmentId;
  return { jar, aid };
}

const s1 = await newStudent('stuA');
const take1 = await call(s1.jar, '/api/take/' + s1.aid);
const served1 = take1.questions.map((q) => q.prompt);
// It's a permutation of exactly the six questions.
if ([...served1].sort().join() !== Qs.map((q) => q.prompt).sort().join()) throw new Error('the shuffled test must serve exactly the same questions: ' + served1);
ok('a shuffled test serves every question exactly once (a permutation)');

// Sections stay grouped (Physics questions together, Chemistry together).
if (!sectionsContiguous(take1.questions)) throw new Error('shuffling must keep each section contiguous, got ' + take1.questions.map((q) => q.section));
ok('questions are shuffled WITHIN sections (sections stay grouped)');

// The order is frozen: a reload returns the same order.
const take1b = await call(s1.jar, '/api/take/' + s1.aid);
if (take1b.questions.map((q) => q.id).join() !== take1.questions.map((q) => q.id).join()) throw new Error('the order must be stable across reloads');
ok('the question order is frozen for a student across reloads');

// GRADING IS UNAFFECTED: answer every question correctly in the shuffled order.
const answers1 = {}; take1.questions.forEach((q) => { answers1[q.id] = String(correctByPrompt[q.prompt]); });
const sub1 = await call(s1.jar, '/api/submit/' + s1.aid, 'POST', { answers: answers1 });
if (sub1.autoScore !== 12 || sub1.maxScore !== 12) throw new Error(`correct answers in shuffled order must score full marks, got ${sub1.autoScore}/${sub1.maxScore}`);
ok('grading is correct despite the shuffle (full marks for all-correct)');

// A second student takes their own (independently shuffled) order and also grades right.
const s2 = await newStudent('stuB');
const take2 = await call(s2.jar, '/api/take/' + s2.aid);
const answers2 = {}; take2.questions.forEach((q) => { answers2[q.id] = String(correctByPrompt[q.prompt]); });
const sub2 = await call(s2.jar, '/api/submit/' + s2.aid, 'POST', { answers: answers2 });
if (sub2.autoScore !== 12) throw new Error('a second student in their own order should also score full marks');
ok('a second student is graded correctly on their own shuffled order');

// Control: a test WITHOUT shuffling serves questions in creation order.
const { id: plainId } = await call(teacher, '/api/tests', 'POST', { title: 'Plain Mock', questions: Qs });
const s3 = await newStudent2(plainId, 'stuC');
const plainOrder = (await call(s3.jar, '/api/take/' + s3.aid)).questions.map((q) => q.prompt);
if (plainOrder.join() !== Qs.map((q) => q.prompt).join()) throw new Error('a non-shuffled test should keep creation order, got ' + plainOrder);
ok('a test without shuffling keeps the original question order');

async function newStudent2(tid, tag) {
  const email = `${tag}${rand}@x.com`;
  const { token } = await call(teacher, '/api/students', 'POST', { name: tag, email, phone: '9000000001' });
  const jar = makeJar();
  const { user } = await call(jar, '/api/signup/' + token, 'POST', { password: 'pass123' });
  await call(teacher, '/api/assignments', 'POST', { test_id: tid, student_ids: [user.id] });
  const aid = (await call(jar, '/api/my-assignments')).assignments.find((a) => a.testId === tid).assignmentId;
  return { jar, aid };
}

console.log('\n✅ SHUFFLE-TEST: ALL CHECKS PASSED\n');
