import { registerTeacher } from './bootstrap.mjs';
// Admin-configurable pricing plans: create, edit, delete (with in-use guard),
// and permission checks.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
const plansOf = async (a) => (await call(a, '/api/plans')).data.plans;

const adminEmail = `padmin${rand}@x.com`;
execSync(`"${process.execPath}" "${path.join(__dirname, 'make-admin.mjs')}" PAdmin ${adminEmail} adminpass1`, { stdio: 'ignore' });
const admin = makeJar();
await call(admin, '/api/login', 'POST', { email: adminEmail, password: 'adminpass1' });

// A teacher cannot manage plans.
const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `pt${rand}@x.com`, password: 'secret123' });
if ((await call(teacher, '/api/plans', 'POST', { name: 'Hack', priceMonthly: 1, maxStudents: 5 }, false)).status === 200)
  throw new Error('a teacher must not be able to create plans');
ok('plan management is admin-only (teacher blocked)');

// Create a plan.
const created = await call(admin, '/api/plans', 'POST', { name: `Silver${rand}`, priceMonthly: 5000, maxStudents: 50, sortOrder: 9 });
if (created.status !== 200 || !created.data.id) throw new Error('plan create should return an id');
const planId = created.data.id;
let list = await plansOf(admin);
let mine = list.find((p) => p.id === planId);
if (!mine || mine.max_students !== 50 || mine.price_monthly !== 5000 || mine.org_count !== 0) throw new Error('created plan wrong: ' + JSON.stringify(mine));
ok('admin creates a plan (name, price, cap, order) and it appears with org_count 0');

// Validation.
if ((await call(admin, '/api/plans', 'POST', { name: '', priceMonthly: 1, maxStudents: 5 }, false)).status !== 400) throw new Error('empty name should 400');
if ((await call(admin, '/api/plans', 'POST', { name: `X${rand}`, priceMonthly: 1, maxStudents: 0 }, false)).status !== 400) throw new Error('zero cap (not unlimited) should 400');
if ((await call(admin, '/api/plans', 'POST', { name: `Silver${rand}`, priceMonthly: 1, maxStudents: 5 }, false)).status !== 409) throw new Error('duplicate name should 409');
ok('validation: empty name / zero cap → 400; duplicate name → 409');

// Edit the plan.
await call(admin, '/api/plans/' + planId, 'PUT', { name: `Gold${rand}`, priceMonthly: 8000, maxStudents: 120, sortOrder: 9 });
mine = (await plansOf(admin)).find((p) => p.id === planId);
if (mine.name !== `Gold${rand}` || mine.price_monthly !== 8000 || mine.max_students !== 120) throw new Error('edit not applied: ' + JSON.stringify(mine));
ok('admin edits a plan (rename, reprice, change cap)');

// An unlimited/custom plan stores a NULL cap.
const custom = await call(admin, '/api/plans', 'POST', { name: `Custom${rand}`, priceMonthly: 0, unlimited: true, sortOrder: 20 });
const customPlan = (await plansOf(admin)).find((p) => p.id === custom.data.id);
if (customPlan.max_students !== null) throw new Error('unlimited plan should have null cap');
ok('an "unlimited" plan is stored with no student cap (custom)');

// In-use guard: assign the plan to an org, then deletion is blocked.
const org = await call(admin, '/api/orgs', 'POST', { name: `Org${rand}` });
const orgId = org.data.id || org.data.org?.id || (await call(admin, '/api/orgs')).data.orgs.find((o) => o.name === `Org${rand}`).id;
await call(admin, '/api/orgs/' + orgId + '/plan', 'PUT', { planId });
if ((await plansOf(admin)).find((p) => p.id === planId).org_count !== 1) throw new Error('org_count should be 1 after assignment');
if ((await call(admin, '/api/plans/' + planId, 'DELETE', undefined, false)).status !== 409) throw new Error('deleting an in-use plan should be blocked (409)');
ok('a plan in use by an organization cannot be deleted (409), and org_count reflects usage');

// Reassign the org, then deletion succeeds.
const other = (await plansOf(admin)).find((p) => p.id !== planId && p.id !== custom.data.id);
await call(admin, '/api/orgs/' + orgId + '/plan', 'PUT', { planId: other.id });
if ((await call(admin, '/api/plans/' + planId, 'DELETE')).status !== 200) throw new Error('deleting an unused plan should succeed');
if ((await plansOf(admin)).find((p) => p.id === planId)) throw new Error('deleted plan should be gone');
ok('once its organizations are reassigned, the plan can be deleted');

console.log('\n✅ PLANS-TEST: ALL CHECKS PASSED\n');
