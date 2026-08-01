// Tests the new "edit a test" feature end-to-end.
const BASE = 'http://localhost:3000';
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
const teacher = makeJar(), student = makeJar();

await call(teacher, '/api/register-teacher', 'POST', { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
const { id: testId } = await call(teacher, '/api/tests', 'POST', {
  title: 'Original Title',
  questions: [
    { type: 'mcq', prompt: '2+2?', options: ['3', '4', '5'], correct: 1, points: 1 },
    { type: 'short', prompt: 'Explain.', points: 2 },
  ],
});
ok('created test');

// Student submits it
const { token } = await call(teacher, '/api/students', 'POST', { name: 'S', email: `s${rand}@x.com` });
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

// EDIT: change title, change mcq choices/correct, add a true/false, drop short
const upd = await call(teacher, '/api/tests/' + testId, 'PUT', {
  title: 'Edited Title',
  description: 'now with changes',
  questions: [
    { type: 'mcq', prompt: 'Capital of Japan?', options: ['Tokyo', 'Osaka'], correct: 0, points: 3 },
    { type: 'truefalse', prompt: 'Water is wet.', correct: 'true', points: 1 },
  ],
});
if (upd.clearedAttempts !== 1) throw new Error('expected clearedAttempts 1, got ' + upd.clearedAttempts);
ok('edited test; 1 old submission cleared');

// Verify new content
const detail = await call(teacher, '/api/tests/' + testId);
if (detail.test.title !== 'Edited Title') throw new Error('title not updated');
if (detail.questions.length !== 2) throw new Error('expected 2 questions');
if (detail.questions[0].prompt !== 'Capital of Japan?') throw new Error('q1 not updated');
if (detail.questions[0].correct_answer !== '0') throw new Error('mcq correct not updated');
if (detail.questions[1].type !== 'truefalse') throw new Error('q2 type wrong');
ok('updated questions & answers persisted correctly');

// submitted_count back to 0, and student can take it again
list = (await call(teacher, '/api/tests')).tests.find((t) => t.id === testId);
if (list.submitted_count !== 0) throw new Error('expected submitted_count 0 after edit');
const retake = await call(student, '/api/take/' + aid);
if (retake.test.title !== 'Edited Title') throw new Error('student sees old title');
ok('student can retake the edited test');

// Non-owner cannot edit
const other = makeJar();
await call(other, '/api/register-teacher', 'POST', { name: 'O', email: `o${rand}@x.com`, password: 'secret123' });
let blocked = false;
try { await call(other, '/api/tests/' + testId, 'PUT', { title: 'hack', questions: [{ type: 'short', prompt: 'x', points: 1 }] }); }
catch { blocked = true; }
if (!blocked) throw new Error('another teacher was able to edit the test!');
ok('another teacher cannot edit another teachers test');

console.log('\n✅ EDIT-TEST: ALL CHECKS PASSED\n');
