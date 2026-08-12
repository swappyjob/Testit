import { registerTeacher } from './bootstrap.mjs';
// Tests the root-admin module: organizations, root teachers, and org isolation.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
async function call(jar, path_, method = 'GET', body, expectOk = true) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path_, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res);
  let data = {}; try { data = await res.json(); } catch {}
  if (expectOk && !res.ok) throw new Error(`${method} ${path_} -> ${res.status}: ${data.error || 'error'}`);
  return { status: res.status, data };
}
const ok = (l) => console.log('  ✓ ' + l);
const tokenOf = (p) => new URLSearchParams(p.split('?')[1]).get('token');
const rand = Math.floor(Math.random() * 1e6);

// Create the admin via the bootstrap script, then log in.
const adminEmail = `admin${rand}@x.com`;
execSync(`"${process.execPath}" "${path.join(__dirname, 'make-admin.mjs')}" Admin ${adminEmail} adminpass1`, { stdio: 'ignore' });
const admin = makeJar();
const adminUser = (await call(admin, '/api/login', 'POST', { email: adminEmail, password: 'adminpass1' })).data.user;
if (adminUser.role !== 'admin') throw new Error('admin login role wrong');
ok('root admin created and logged in');

// A normal teacher cannot use admin endpoints.
const rando = await registerTeacher(BASE, makeJar, call, { name: 'R', email: `r${rand}@x.com`, password: 'secret123' });
if ((await call(rando, '/api/orgs', 'GET', undefined, false)).status !== 403) throw new Error('teacher should be 403 on /api/orgs');
if ((await call(rando, '/api/admin/root-teachers', 'POST', { orgId: 1, name: 'x', email: `z${rand}@x.com`, phone: '9' }, false)).status !== 403)
  throw new Error('teacher should be 403 creating root teachers');
ok('non-admin is blocked from admin endpoints (403)');

// Org creation is admin-only: neither an anonymous visitor nor a plain teacher
// can self-register an organization.
if ((await call(makeJar(), '/api/register-teacher', 'POST', { name: 'Sneaky', email: `sneak${rand}@x.com`, password: 'secret123' }, false)).status !== 401)
  throw new Error('anonymous org creation should be blocked (401)');
if ((await call(rando, '/api/register-teacher', 'POST', { name: 'Sneaky', email: `sneak2_${rand}@x.com`, password: 'secret123' }, false)).status !== 403)
  throw new Error('a plain teacher must not create organizations (403)');
ok('org creation is admin-only — no public self-signup (anon 401, teacher 403)');

// --- An admin can create other admins ---
if ((await call(rando, '/api/admins', 'GET', undefined, false)).status !== 403) throw new Error('teacher should be 403 on GET /api/admins');
if ((await call(rando, '/api/admins', 'POST', { name: 'X', email: `nx${rand}@x.com`, password: 'secret123' }, false)).status !== 403)
  throw new Error('teacher should be 403 creating admins');
ok('non-admin cannot list or create admins (403)');

const adminsBefore = (await call(admin, '/api/admins')).data.admins;
if (!adminsBefore.find((a) => a.email === adminEmail && a.isSelf)) throw new Error('admin list should include self');
const newAdminEmail = `admin2_${rand}@x.com`;
if ((await call(admin, '/api/admins', 'POST', { name: 'Second Admin', email: newAdminEmail, password: 'admin2pass' })).status !== 200)
  throw new Error('admin should be able to create another admin');
ok('an admin can create another admin');

const admin2 = makeJar();
const a2 = (await call(admin2, '/api/login', 'POST', { email: newAdminEmail, password: 'admin2pass' })).data.user;
if (a2.role !== 'admin') throw new Error('new admin login role wrong');
if ((await call(admin2, '/api/admins')).status !== 200) throw new Error('new admin should reach admin endpoints');
ok('the new admin can log in and use admin endpoints');

if ((await call(admin, '/api/admins', 'POST', { name: 'Dup', email: newAdminEmail, password: 'another1' }, false)).status !== 409)
  throw new Error('duplicate admin email should be 409');
if ((await call(admin, '/api/admins', 'POST', { name: 'Short', email: `sp${rand}@x.com`, password: '123' }, false)).status !== 400)
  throw new Error('short admin password should be 400');
ok('duplicate email (409) and short password (400) rejected');

// Admin creates two organizations.
const orgA = (await call(admin, '/api/orgs', 'POST', { name: `Org A ${rand}` })).data;
const orgB = (await call(admin, '/api/orgs', 'POST', { name: `Org B ${rand}` })).data;
ok('admin created two organizations');

// Admin adds a root teacher to each org; they sign up into the right org.
const rtA = (await call(admin, '/api/admin/root-teachers', 'POST', { orgId: orgA.id, name: 'RootA', email: `rta${rand}@x.com`, phone: '9000000001' })).data;
const rtB = (await call(admin, '/api/admin/root-teachers', 'POST', { orgId: orgB.id, name: 'RootB', email: `rtb${rand}@x.com`, phone: '9000000002' })).data;
const rootA = makeJar();
const uA = (await call(rootA, '/api/signup/' + tokenOf(rtA.signupPath), 'POST', { password: 'pass123' })).data.user;
const rootB = makeJar();
const uB = (await call(rootB, '/api/signup/' + tokenOf(rtB.signupPath), 'POST', { password: 'pass123' })).data.user;
if (!uA.isRoot || uA.role !== 'teacher' || !uA.orgId) throw new Error('root teacher A wrong');
if (uA.orgId === uB.orgId) throw new Error('root teachers should be in different orgs');
ok('admin-created root teachers sign up into their organizations');

// --- Admin can generate a password-reset link for any teacher ---
if ((await call(rando, '/api/admin/teachers/' + uA.id + '/reset-link', 'POST', undefined, false)).status !== 403)
  throw new Error('non-admin should be 403 generating a teacher reset link');
if ((await call(admin, '/api/admin/teachers/99999999/reset-link', 'POST', undefined, false)).status !== 404)
  throw new Error('unknown teacher should be 404');
const link = (await call(admin, '/api/admin/teachers/' + uA.id + '/reset-link', 'POST')).data;
const resetToken = tokenOf(link.resetPath);
if (!resetToken) throw new Error('admin reset link missing a token');
// The generated token is valid and points at the right teacher (non-destructive check).
const chk = (await call(makeJar(), '/api/reset/' + resetToken)).data;
if (chk.email !== `rta${rand}@x.com` || chk.role !== 'teacher') throw new Error('admin reset token is not valid for the teacher');
ok('admin generates a valid password-reset link for a teacher (403/404 guarded)');

// Root A adds a teacher + student in Org A (student signs up so it counts).
await call(rootA, '/api/teachers', 'POST', { name: 'TA', email: `ta${rand}@x.com`, phone: '9000000003', isRoot: false });
const sa = (await call(rootA, '/api/students', 'POST', { name: 'SA', email: `sa${rand}@x.com`, phone: '9000000004' })).data;
await call(makeJar(), '/api/signup/' + tokenOf(sa.signupPath), 'POST', { password: 'pass123' });
ok('root teacher A manages their own org (adds a teacher and a student)');

// Org isolation: Root A's roster shows only Org A teachers (not Org B's root).
const rosterA = (await call(rootA, '/api/teachers')).data.teachers;
if (rosterA.some((t) => t.email === `rtb${rand}@x.com`)) throw new Error('Org A roster leaked an Org B teacher');
if (!rosterA.some((t) => t.email === `ta${rand}@x.com`)) throw new Error('Org A roster missing its own teacher');
ok('teacher roster is scoped to the organization');

// Root A cannot disable or reset a teacher in Org B.
if ((await call(rootA, '/api/teachers/' + uB.id, 'PATCH', { disabled: true }, false)).status !== 404)
  throw new Error('cross-org disable should be 404');
if ((await call(rootA, '/api/teachers/' + uB.id + '/reset-link', 'POST', undefined, false)).status !== 404)
  throw new Error('cross-org reset should be 404');
ok('a root teacher cannot manage another organization’s teachers');

// Admin view lists both orgs with their teachers.
const orgs = (await call(admin, '/api/orgs')).data.orgs;
const a = orgs.find((o) => o.id === orgA.id);
const b = orgs.find((o) => o.id === orgB.id);
if (!a || !b) throw new Error('admin should see both orgs');
if (!a.teachers.some((t) => t.email === `rta${rand}@x.com`)) throw new Error('org A should list its root teacher');
if (a.studentCount !== 1) throw new Error('org A should report 1 student, got ' + a.studentCount);
ok('admin sees all organizations with their teachers and counts');

// --- Pricing plans ---
const plans = (await call(admin, '/api/plans')).data.plans;
if (plans.length < 5 || !plans.find((p) => p.name === 'Basic')) throw new Error('plans not seeded');
ok('pricing plans are available to the admin');

// New orgs default to the Free plan (15 students).
const orgC = (await call(admin, '/api/orgs', 'POST', { name: `Org C ${rand}` })).data;
const orgCrow = (await call(admin, '/api/orgs')).data.orgs.find((o) => o.id === orgC.id);
if (orgCrow.planName !== 'Free' || orgCrow.maxStudents !== 15) throw new Error('new org should default to Free');
ok('new organization defaults to the Free plan');

// Assign the Free plan (cap 15) to Org A and enforce the cap.
const freePlan = plans.find((p) => p.name === 'Free');
await call(admin, '/api/orgs/' + orgA.id + '/plan', 'PUT', { planId: freePlan.id });
const orgArow = (await call(admin, '/api/orgs')).data.orgs.find((o) => o.id === orgA.id);
if (orgArow.planName !== 'Free' || orgArow.maxStudents !== 15) throw new Error('plan assignment did not persist');
ok('admin can assign a plan to an organization');

for (let i = orgArow.studentCount; i < 15; i++) {
  const r = await call(rootA, '/api/students', 'POST', { name: 'Cap' + i, email: `cap${i}_${rand}@x.com`, phone: '9000000000' });
  if (r.status !== 200) throw new Error('should allow students up to the cap, failed at ' + i);
}
const over = await call(rootA, '/api/students', 'POST', { name: 'Over', email: `over${rand}@x.com`, phone: '9000000000' }, false);
if (over.status !== 403) throw new Error('exceeding the plan cap should be 403, got ' + over.status);
ok('student creation is blocked once the plan limit is reached (403)');

// Upgrade to Enterprise (unlimited) removes the cap.
const ent = plans.find((p) => p.name === 'Enterprise');
await call(admin, '/api/orgs/' + orgA.id + '/plan', 'PUT', { planId: ent.id });
if ((await call(rootA, '/api/students', 'POST', { name: 'Over2', email: `over2${rand}@x.com`, phone: '9000000000' })).status !== 200)
  throw new Error('unlimited plan should allow more students');
ok('upgrading to an unlimited plan removes the cap');

// Plan management is admin-only.
if ((await call(rootA, '/api/plans', 'GET', undefined, false)).status !== 403) throw new Error('non-admin listing plans should be 403');
if ((await call(rootA, '/api/orgs/' + orgA.id + '/plan', 'PUT', { planId: ent.id }, false)).status !== 403) throw new Error('non-admin assigning a plan should be 403');
ok('plan management is admin-only');

// Admin renames an organization.
if ((await call(admin, '/api/orgs/' + orgA.id, 'PUT', { name: `Org A Renamed ${rand}` })).status !== 200)
  throw new Error('rename should succeed');
if ((await call(admin, '/api/orgs/' + orgA.id, 'PUT', { name: '' }, false)).status !== 400)
  throw new Error('blank org name should be 400');
const renamed = (await call(admin, '/api/orgs')).data.orgs.find((o) => o.id === orgA.id);
if (renamed.name !== `Org A Renamed ${rand}`) throw new Error('org rename did not persist');
if ((await call(rootA, '/api/orgs/' + orgA.id, 'PUT', { name: 'Nope' }, false)).status !== 403)
  throw new Error('non-admin renaming an org should be 403');
ok('admin can rename an organization (non-admin blocked)');

// Admin can change their own password.
if ((await call(admin, '/api/change-password', 'POST', { currentPassword: 'wrong', newPassword: 'adminpass2' }, false)).status !== 403)
  throw new Error('wrong current password should be 403');
if ((await call(admin, '/api/change-password', 'POST', { currentPassword: 'adminpass1', newPassword: 'adminpass2' })).status !== 200)
  throw new Error('admin password change should succeed');
if ((await call(makeJar(), '/api/login', 'POST', { email: adminEmail, password: 'adminpass1' }, false)).status !== 401)
  throw new Error('old admin password should fail');
if ((await call(makeJar(), '/api/login', 'POST', { email: adminEmail, password: 'adminpass2' }, false)).status !== 200)
  throw new Error('new admin password should work');
ok('admin can change their own password');

// Admin can disable/enable any teacher.
if ((await call(rootB, '/api/admin/teachers/' + uA.id, 'PATCH', { disabled: true }, false)).status !== 403)
  throw new Error('non-admin should not use admin disable');
if ((await call(admin, '/api/admin/teachers/' + uA.id, 'PATCH', { disabled: true })).status !== 200)
  throw new Error('admin disable should succeed');
if ((await call(makeJar(), '/api/login', 'POST', { email: `rta${rand}@x.com`, password: 'pass123' }, false)).status !== 403)
  throw new Error('disabled teacher login should be 403');
await call(admin, '/api/admin/teachers/' + uA.id, 'PATCH', { disabled: false });
if ((await call(makeJar(), '/api/login', 'POST', { email: `rta${rand}@x.com`, password: 'pass123' }, false)).status !== 200)
  throw new Error('re-enabled teacher should log in');
ok('admin can disable and re-enable teachers (non-admin blocked)');

// Admin can edit a teacher (name, phone, role) — email is immutable.
if ((await call(admin, '/api/admin/teachers/' + uA.id, 'PUT', { name: 'RootA Renamed', phone: '9123123123', isRoot: false, email: `hack${rand}@x.com` })).status !== 200)
  throw new Error('admin edit teacher should succeed');
const editedOrgs = (await call(admin, '/api/orgs')).data.orgs.find((o) => o.id === orgA.id);
const editedT = editedOrgs.teachers.find((t) => t.id === uA.id);
if (editedT.name !== 'RootA Renamed' || editedT.phone !== '9123123123' || editedT.isRoot)
  throw new Error('teacher edit did not persist (name/phone/role)');
if (editedT.email !== `rta${rand}@x.com`) throw new Error('teacher email must not change');
if ((await call(rootB, '/api/admin/teachers/' + uA.id, 'PUT', { name: 'x', phone: '9' }, false)).status !== 403)
  throw new Error('non-admin editing a teacher should be 403');
if ((await call(admin, '/api/admin/teachers/' + uA.id, 'PUT', { name: '', phone: '9123123123' }, false)).status !== 400)
  throw new Error('blank name should be 400');
ok('admin can edit a teacher (name/phone/role); email immutable; non-admin blocked');

// Admin can search organizations by name (server-side).
const uniq = `Zephyr${rand}`;
const searchOrg = (await call(admin, '/api/orgs', 'POST', { name: `${uniq} Academy` })).data;
let found = (await call(admin, '/api/orgs?q=' + encodeURIComponent(uniq.toLowerCase()))).data.orgs;
if (found.length !== 1 || found[0].id !== searchOrg.id) throw new Error('org search should find exactly the one org');
if ((await call(admin, '/api/orgs?q=' + encodeURIComponent(`nomatch${rand}`))).data.orgs.length !== 0)
  throw new Error('no-match search should return empty');
if ((await call(admin, '/api/orgs')).data.orgs.length < 3) throw new Error('empty query should return all orgs');
ok('admin can search organizations by name (case-insensitive, server-side)');

console.log('\n✅ ADMIN-TEST: ALL CHECKS PASSED\n');
