// Tests resumable test-creation drafts: create, list, update, resume, scope, delete.
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

const t1 = makeJar();
await call(t1, '/api/register-teacher', 'POST', { name: 'D1', email: `d1_${rand}@x.com`, password: 'secret123' });
const t2 = makeJar();
await call(t2, '/api/register-teacher', 'POST', { name: 'D2', email: `d2_${rand}@x.com`, password: 'secret123' });

// Create a draft.
const id = (await call(t1, '/api/drafts', 'POST', { title: 'WIP quiz', data: JSON.stringify({ title: 'WIP quiz', page: 2 }) })).data.id;
if (!id) throw new Error('draft create returned no id');
ok('teacher creates a draft');

// It appears in the list.
if (!(await call(t1, '/api/drafts')).data.drafts.some((d) => d.id === id && d.title === 'WIP quiz')) throw new Error('draft not listed');
ok('draft appears in the drafts list');

// Update (auto-save) and read it back.
await call(t1, '/api/drafts/' + id, 'PUT', { title: 'WIP quiz v2', data: JSON.stringify({ title: 'WIP quiz v2', page: 3 }) });
const got = (await call(t1, '/api/drafts/' + id)).data;
if (got.title !== 'WIP quiz v2' || JSON.parse(got.data).page !== 3) throw new Error('draft update did not persist');
ok('draft auto-save updates persist and reload');

// Another teacher cannot see or change it.
if ((await call(t2, '/api/drafts/' + id, 'GET', undefined, false)).status !== 404) throw new Error('other teacher should not read the draft');
if ((await call(t2, '/api/drafts/' + id, 'PUT', { title: 'hax', data: '{}' }, false)).status !== 404) throw new Error('other teacher should not update the draft');
if ((await call(t2, '/api/drafts')).data.drafts.some((d) => d.id === id)) throw new Error('draft leaked into other teacher list');
ok('drafts are private to their owner (404 for others)');

// Publishing: create the real test, then delete the draft.
const testId = (await call(t1, '/api/tests', 'POST', { title: 'WIP quiz v2', questions: [{ type: 'truefalse', prompt: 'q', correct: 'true', points: 1 }] })).data.id;
await call(t1, '/api/drafts/' + id, 'DELETE');
if ((await call(t1, '/api/drafts')).data.drafts.some((d) => d.id === id)) throw new Error('draft should be gone after publish/delete');
if (!(await call(t1, '/api/tests')).data.tests.some((t) => t.id === testId)) throw new Error('published test should exist');
ok('publishing creates the test and clears the draft');

console.log('\n✅ DRAFT-TEST: ALL CHECKS PASSED\n');
