// Tests that an expired organization subscription puts teachers into read-only:
// all create/edit/delete are blocked (403), reads still work.
import pg from 'pg';

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
const Q = [{ type: 'multi', prompt: 'q', options: ['a', 'b'], correct: [0], points: 1 }];

const root = makeJar();
await call(root, '/api/register-teacher', 'POST', { name: 'Sub', email: `sub${rand}@x.com`, password: 'secret123' });
const me = (await call(root, '/api/me')).data.user;
const orgId = me.orgId;
if (me.subscriptionExpired) throw new Error('a new org should not be expired');
ok('new organization starts with an active (non-expired) subscription');

// While active, writes succeed.
const created = await call(root, '/api/tests', 'POST', { title: 'Active', questions: Q });
if (created.status !== 200) throw new Error('active org should be able to create a test');
const testId = created.data.id;
ok('active subscription: teacher can create a test');

// Expire the organization directly in the test database.
const client = new pg.Client({
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'testit_test',
});
await client.connect();
await client.query("UPDATE organizations SET subscription_expires_at = '2020-01-01' WHERE id = $1", [orgId]);
await client.end();

// The expiry flag now surfaces on /api/me.
if (!(await call(root, '/api/me')).data.user.subscriptionExpired) throw new Error('/api/me should report subscriptionExpired');
ok('expiry surfaces on /api/me as subscriptionExpired');

// Every create/edit/delete is now blocked with 403.
if ((await call(root, '/api/tests', 'POST', { title: 'Blocked', questions: Q }, false)).status !== 403)
  throw new Error('creating a test should be blocked');
ok('expired: creating a test is blocked (403)');

if ((await call(root, '/api/tests/' + testId, 'PUT', { title: 'Edited', questions: Q }, false)).status !== 403)
  throw new Error('editing a test should be blocked');
ok('expired: editing a test is blocked (403)');

if ((await call(root, '/api/tests/' + testId, 'DELETE', undefined, false)).status !== 403)
  throw new Error('deleting a test should be blocked');
ok('expired: deleting a test is blocked (403)');

if ((await call(root, '/api/students', 'POST', { name: 'X', email: `x${rand}@x.com`, phone: '9' }, false)).status !== 403)
  throw new Error('creating a student should be blocked');
ok('expired: creating a student is blocked (403)');

if ((await call(root, '/api/teachers', 'POST', { name: 'T', email: `t${rand}@x.com`, phone: '9', isRoot: false }, false)).status !== 403)
  throw new Error('creating a teacher should be blocked');
ok('expired: creating a teacher is blocked (403)');

// Reads still work — the account is read-only, not locked out.
if ((await call(root, '/api/tests')).data.tests.length < 1) throw new Error('reading tests should still work');
if ((await call(root, '/api/students')).status !== 200) throw new Error('reading students should still work');
ok('expired: reading tests and students still works (read-only)');

console.log('\n✅ SUBSCRIPTION-TEST: ALL CHECKS PASSED\n');
