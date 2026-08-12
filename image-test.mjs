import { registerTeacher } from './bootstrap.mjs';
// Tests uploading an image and attaching it to a question.
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
// A valid 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const student = makeJar();
const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
ok('teacher registered');

// Upload the image
const { url } = await call(teacher, '/api/upload', 'POST', { dataUrl: PNG });
if (!/^\/uploads\/[\w.]+\.png$/.test(url)) throw new Error('bad url: ' + url);
ok('image uploaded -> ' + url);

// The uploaded file is served
const imgRes = await fetch(BASE + url);
if (!imgRes.ok) throw new Error('uploaded image not served: ' + imgRes.status);
ok('uploaded image is publicly served');

// Reject a non-image upload
let rejected = false;
try { await call(teacher, '/api/upload', 'POST', { dataUrl: 'data:text/plain;base64,aGVsbG8=' }); }
catch { rejected = true; }
if (!rejected) throw new Error('non-image upload was NOT rejected');
ok('non-image upload rejected');

// Create a test with an image on the question
const { id: testId } = await call(teacher, '/api/tests', 'POST', {
  title: 'Picture Quiz',
  questions: [
    { type: 'mcq', prompt: 'What shape is shown?', options: ['Square', 'Circle'], correct: 0, points: 1, image: url },
    { type: 'short', prompt: 'Describe it.', points: 1 }, // no image
  ],
});
ok('test created with an image question');

// Teacher detail keeps the image
const detail = await call(teacher, '/api/tests/' + testId);
if (detail.questions[0].image_url !== url) throw new Error('image not stored on question');
if (detail.questions[1].image_url !== '') throw new Error('second question should have no image');
ok('image_url persisted on the right question');

// A forged image path is rejected/sanitized on save
const { id: t2 } = await call(teacher, '/api/tests', 'POST', {
  title: 'Forge', questions: [{ type: 'short', prompt: 'x', points: 1, image: '/etc/passwd' }],
});
const d2 = await call(teacher, '/api/tests/' + t2);
if (d2.questions[0].image_url !== '') throw new Error('unsafe image path was NOT sanitized');
ok('unsafe image path sanitized to empty');

// Student taking the test receives the image
const { token } = await call(teacher, '/api/students', 'POST', { name: 'S', email: `s${rand}@x.com`, phone: '9000000003' });
const { user: su } = await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [su.id] });
const { assignments } = await call(student, '/api/my-assignments');
const take = await call(student, '/api/take/' + assignments[0].assignmentId);
const imgQ = take.questions.find((q) => q.image);
if (!imgQ || imgQ.image !== url) throw new Error('student did not receive the question image');
ok('student receives the question image');

console.log('\n✅ IMAGE-TEST: ALL CHECKS PASSED\n');
