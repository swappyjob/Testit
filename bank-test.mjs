import { registerTeacher } from './bootstrap.mjs';
// Tests the org-wide question bank: CRUD, filters, org sharing + isolation.
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
const listIds = async (jar, qs = '') => (await call(jar, '/api/bank' + qs)).data.questions.map((x) => x.id);

const t1 = await registerTeacher(BASE, makeJar, call, { name: 'T1', email: `t1_${rand}@x.com`, password: 'secret123' });

// Create a single-choice question with a blank option (should be dropped).
const id = (await call(t1, '/api/bank', 'POST', {
  type: 'mcq', prompt: '2 + 2 = ?', options: ['3', '4', '5', ''], correct: 1, points: 2, explanation: 'It is four.', topic: 'Math', difficulty: 'Easy',
})).data.id;
const item = (await call(t1, '/api/bank')).data.questions.find((x) => x.id === id);
if (item.type !== 'mcq' || item.options.length !== 3 || item.correctAnswer !== '1' || item.points !== 2 || item.topic !== 'Math' || item.difficulty !== 'Easy')
  throw new Error('bank question not stored correctly: ' + JSON.stringify(item));
ok('a teacher creates a bank question (blank option dropped, correct remapped)');

// Filters.
if (!(await listIds(t1, '?topic=Math')).includes(id)) throw new Error('topic filter should match');
if ((await listIds(t1, '?topic=Physics')).includes(id)) throw new Error('wrong topic should not match');
if (!(await listIds(t1, '?type=mcq')).includes(id)) throw new Error('type filter should match');
if ((await listIds(t1, '?type=short')).includes(id)) throw new Error('wrong type should not match');
if (!(await listIds(t1, '?q=2 %2B 2')).includes(id)) throw new Error('text search should match');
ok('search + topic + type filters work');

// Update.
await call(t1, '/api/bank/' + id, 'PUT', { type: 'truefalse', prompt: 'Sky is blue', correct: 'true', points: 1, topic: 'GK', difficulty: 'Medium' });
const upd = (await call(t1, '/api/bank')).data.questions.find((x) => x.id === id);
if (upd.type !== 'truefalse' || upd.prompt !== 'Sky is blue' || upd.topic !== 'GK') throw new Error('update did not persist');
ok('a bank question can be edited');

// Org sharing: a teacher invited into the same org sees it.
const inv = (await call(t1, '/api/teachers', 'POST', { name: 'T1b', email: `t1b_${rand}@x.com`, phone: '9000000001', isRoot: false })).data;
const t1b = makeJar();
await call(t1b, '/api/signup/' + inv.token, 'POST', { password: 'pass123' });
if (!(await listIds(t1b)).includes(id)) throw new Error('same-org teacher should see the bank question');
ok('the bank is shared across the organization');

// Org isolation: a teacher in a different org does not see it.
const t2 = await registerTeacher(BASE, makeJar, call, { name: 'T2', email: `t2_${rand}@x.com`, password: 'secret123' });
if ((await listIds(t2)).includes(id)) throw new Error('another org should not see the bank question');
if ((await call(t2, '/api/bank/' + id, 'PUT', { type: 'short', prompt: 'x', points: 1 }, false)).status !== 404)
  throw new Error('another org editing should be 404');
ok('the bank is isolated to its own organization (404 for others)');

// Validation.
if ((await call(t1, '/api/bank', 'POST', { type: 'mcq', prompt: '', options: ['a', 'b'], correct: 0 }, false)).status !== 400)
  throw new Error('a question without text should be 400');
ok('invalid questions are rejected (400)');

// Bulk import: valid rows created, invalid rows skipped with a reason.
const bulk = await call(t1, '/api/bank/bulk', 'POST', { questions: [
  { type: 'mcq', prompt: 'CSV single: 2+2?', options: ['3', '4'], correct: 1, points: 4, topic: 'Maths' },
  { type: 'multi', prompt: 'CSV multi: which are prime?', options: ['2', '3', '4'], correct: [0, 1], points: 4 },
  { type: 'truefalse', prompt: 'CSV tf: the sky is blue', correct: 'true', points: 1 },
  { type: 'mcq', prompt: '', options: ['a', 'b'], correct: 0 },              // invalid: no text
  { type: 'mcq', prompt: 'bad correct index', options: ['a', 'b'], correct: 5 }, // invalid: index out of range
]});
if (bulk.data.created !== 3) throw new Error('bulk should create the 3 valid questions, got ' + bulk.data.created);
if (bulk.data.skipped.length !== 2) throw new Error('bulk should skip the 2 invalid rows, got ' + JSON.stringify(bulk.data.skipped));
if (!bulk.data.skipped.every((s) => s.reason)) throw new Error('every skipped row should carry a reason');
const found = (await call(t1, '/api/bank?q=' + encodeURIComponent('CSV multi'))).data.questions;
if (!found.some((q) => /CSV multi/.test(q.prompt))) throw new Error('an imported question should be retrievable from the bank');
ok('bulk CSV import creates valid questions and skips invalid ones with reasons');

// An empty import is rejected.
if ((await call(t1, '/api/bank/bulk', 'POST', { questions: [] }, false)).status !== 400)
  throw new Error('an empty import should be rejected (400)');
ok('an empty bulk import is rejected (400)');

// Delete.
await call(t1, '/api/bank/' + id, 'DELETE');
if ((await listIds(t1)).includes(id)) throw new Error('deleted question should be gone');
ok('a bank question can be deleted');

console.log('\n✅ BANK-TEST: ALL CHECKS PASSED\n');
