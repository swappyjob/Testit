import { registerTeacher } from './bootstrap.mjs';
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

const root = await registerTeacher(BASE, makeJar, call, { name: 'Sub', email: `sub${rand}@x.com`, password: 'secret123' });
const me = (await call(root, '/api/me')).data.user;
const orgId = me.orgId;
if (me.subscriptionExpired) throw new Error('a new org should not be expired');
ok('new organization starts with an active (non-expired) subscription');

// A newly registered organization defaults to the Free plan (15-student cap).
const orgPlan = (await call(root, '/api/my-org/plan')).data;
if (!orgPlan.plan || orgPlan.plan.name !== 'Free') throw new Error('a new org should default to the Free plan, got: ' + JSON.stringify(orgPlan.plan));
if (orgPlan.plan.max_students !== 15) throw new Error('the Free plan should cap at 15 students, got: ' + orgPlan.plan.max_students);
ok('new organization defaults to the Free plan (15-student cap)');

// Unlimited/custom plans are not self-serve — a root teacher can't subscribe to one.
const unlimited = orgPlan.plans.find((p) => p.max_students === null);
if (unlimited) {
  const r = await call(root, '/api/my-org/plan', 'POST', { planId: unlimited.id }, false);
  if (r.status !== 403) throw new Error('subscribing to a custom/unlimited plan should be blocked (403), got ' + r.status);
  ok('a custom/unlimited plan cannot be self-subscribed (403 — contact required)');
}

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

// A root teacher can renew even while expired, which lifts read-only.
const badPeriod = await call(root, '/api/my-org/renew', 'POST', { period: 'weekly' }, false);
if (badPeriod.status !== 400) throw new Error('an invalid billing period should be rejected (400)');
const renew = await call(root, '/api/my-org/renew', 'POST', { period: 'monthly' });
if (renew.status !== 200 || !renew.data.expiresAt) throw new Error('renew should return the new expiry date');
const today = new Date().toISOString().slice(0, 10);
if (!(renew.data.expiresAt > today)) throw new Error('renewed expiry should be in the future: ' + renew.data.expiresAt);
ok('a root teacher renews the subscription (invalid period rejected; valid one extends the expiry)');

if ((await call(root, '/api/me')).data.user.subscriptionExpired) throw new Error('after renewal the org should no longer be expired');
if ((await call(root, '/api/tests', 'POST', { title: 'Post-renew', questions: Q })).status !== 200)
  throw new Error('after renewal, creating a test should work again');
ok('after renewal the organization is active again and writes are restored');

// Annual renewal lands roughly a year out (≈ 335+ days).
const yr = (await call(root, '/api/my-org/renew', 'POST', { period: 'yearly' })).data;
const daysOut = Math.round((new Date(yr.expiresAt).getTime() - Date.now()) / 86400000);
if (daysOut < 300) throw new Error('annual renewal should extend ~1 year, got ' + daysOut + ' days');
ok('billing periods extend the subscription by the right length (annual ≈ 1 year)');

// Subscribing to a plan (renew with planId) switches the tier AND sets the term.
const basic = orgPlan.plans.find((p) => p.name === 'Basic');
const sub = await call(root, '/api/my-org/renew', 'POST', { period: 'quarterly', planId: basic.id });
if (sub.status !== 200 || sub.data.planName !== 'Basic' || !sub.data.switched) throw new Error('subscribe-with-plan should switch the tier and report it: ' + JSON.stringify(sub.data));
if ((await call(root, '/api/my-org/plan')).data.plan.name !== 'Basic') throw new Error('the org should now be on the Basic plan');
ok('subscribing with a plan switches the tier and sets the chosen billing period in one step');

// A non-root teacher cannot renew.
const nonRoot = makeJar();
const inv = (await call(root, '/api/teachers', 'POST', { name: 'NR', email: `nr${rand}@x.com`, phone: '9000000001', isRoot: false })).data;
await call(nonRoot, '/api/signup/' + new URLSearchParams(inv.signupPath.split('?')[1]).get('token'), 'POST', { password: 'pass123' });
if ((await call(nonRoot, '/api/my-org/renew', 'POST', { period: 'monthly' }, false)).status !== 403)
  throw new Error('a non-root teacher must not be able to renew');
ok('only a root teacher can renew (non-root blocked)');

console.log('\n✅ SUBSCRIPTION-TEST: ALL CHECKS PASSED\n');
