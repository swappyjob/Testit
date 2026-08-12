import { registerTeacher } from './bootstrap.mjs';
// Tests root-teacher management: inviting teachers (root/normal), phone, permissions.
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
const rand = Math.floor(Math.random() * 1e6);

const email = `root${rand}@x.com`;
const root = await registerTeacher(BASE, makeJar, call, { name: 'Root', email, password: 'secret123' });
const me = (await call(root, '/api/me')).data.user;
if (!me.isRoot) throw new Error('could not obtain a root teacher for the test');
ok('acting as a root teacher');

// Phone is required
let np = await call(root, '/api/teachers', 'POST', { name: 'NP', email: `np${rand}@x.com`, isRoot: false }, false);
if (np.status !== 400) throw new Error('teacher without phone should be 400, got ' + np.status);
ok('phone is required when adding a teacher');

// Root invites a normal teacher and another root teacher (with phones)
const t1 = (await call(root, '/api/teachers', 'POST', { name: 'Normal Teacher', email: `nt${rand}@x.com`, phone: '+91 90000 00001', isRoot: false })).data;
const t2 = (await call(root, '/api/teachers', 'POST', { name: 'Boss Teacher', email: `bt${rand}@x.com`, phone: '9000000002', isRoot: true })).data;
ok('root invited a normal teacher and a root teacher');

// Listing shows self + pending invites with correct roles AND phones
const teachers = (await call(root, '/api/teachers')).data.teachers;
if (!teachers.find((t) => t.isSelf && t.isRoot)) throw new Error('self should be listed as root');
const nt = teachers.find((t) => t.email === `nt${rand}@x.com`);
const bt = teachers.find((t) => t.email === `bt${rand}@x.com`);
if (!nt || nt.isRoot || nt.signedUp || nt.phone !== '+91 90000 00001') throw new Error('normal invite listed wrong');
if (!bt || !bt.isRoot || bt.phone !== '9000000002') throw new Error('root invite listed wrong');
ok('teacher list shows roles and mobile numbers');

// Normal teacher signs up -> keeps the phone, can make tests, cannot manage teachers
const normal = makeJar();
const nu = (await call(normal, '/api/signup/' + t1.token, 'POST', { password: 'pass123' })).data.user;
if (nu.role !== 'teacher' || nu.isRoot) throw new Error('normal signup role wrong');
const afterSignup = (await call(root, '/api/teachers')).data.teachers.find((t) => t.email === `nt${rand}@x.com`);
if (!afterSignup.signedUp || afterSignup.phone !== '+91 90000 00001') throw new Error('phone lost after teacher signup');
ok('invited teacher signs up and keeps their phone');

const made = await call(normal, '/api/tests', 'POST', { title: 'T', questions: [{ type: 'mcq', prompt: 'q', options: ['a', 'b'], correct: 0, points: 1 }] });
if (made.status !== 200) throw new Error('normal teacher should be able to create tests');
// A normal teacher CAN view the roster, but cannot manage it.
const normalView = await call(normal, '/api/teachers');
if (normalView.status !== 200 || normalView.data.canManage) throw new Error('normal teacher should view roster without manage rights');
if ((await call(normal, '/api/teachers', 'POST', { name: 'X', email: `x${rand}@x.com`, phone: '9', isRoot: false }, false)).status !== 403)
  throw new Error('normal teacher adding a teacher should be 403');
ok('normal teacher can view the roster but cannot add teachers (403)');

// Students are shared across the organization: a student created by the root
// is visible to (and manageable by) another teacher in the same org.
const os = (await call(root, '/api/students', 'POST', { name: 'OrgStudent', email: `os${rand}@x.com`, phone: '9000000005' })).data;
const seen = (await call(normal, '/api/students')).data.students.find((s) => s.email === `os${rand}@x.com`);
if (!seen) throw new Error('a teacher should see students created by others in the same org');
// The normal teacher can edit that shared student (same org).
if ((await call(normal, '/api/students/' + seen.id, 'PUT', { name: 'OrgStudent Edited', phone: '9000000006' })).status !== 200)
  throw new Error('a same-org teacher should be able to edit the shared student');
ok('students are shared across the organization (any teacher can see and manage them)');

// Root-invited teacher signs up as root and can manage teachers
const boss = makeJar();
const bu = (await call(boss, '/api/signup/' + t2.token, 'POST', { password: 'pass123' })).data.user;
if (bu.role !== 'teacher' || !bu.isRoot) throw new Error('root signup should be a root teacher');
const bossAdd = await call(boss, '/api/teachers', 'POST', { name: 'Another', email: `an${rand}@x.com`, phone: '9000000003', isRoot: false });
if (bossAdd.status !== 200) throw new Error('root teacher should be able to add teachers');
ok('invited root teacher can manage teachers too');

// Duplicate email rejected
let r = await call(root, '/api/teachers', 'POST', { name: 'Dup', email: `nt${rand}@x.com`, phone: '9000000004' }, false);
if (r.status !== 409) throw new Error('duplicate email should be 409');
ok('duplicate email rejected');

// --- Organization subscription (teacher-facing pricing) ---
const sub = (await call(root, '/api/my-org/plan')).data;
if (!Array.isArray(sub.plans) || sub.plans.length < 5) throw new Error('teacher should see all available plans');
if (typeof sub.studentCount !== 'number') throw new Error('subscription should report student usage');
ok('root teacher can view available plans and current usage');

const freeP = sub.plans.find((p) => p.name === 'Free');
const basicP = sub.plans.find((p) => p.name === 'Basic');

// Root subscribes the org to Basic and it persists.
if ((await call(root, '/api/my-org/plan', 'POST', { planId: basicP.id })).status !== 200)
  throw new Error('root teacher should be able to subscribe to a plan');
if ((await call(root, '/api/my-org/plan')).data.plan.name !== 'Basic') throw new Error('subscription did not persist');
ok('root teacher can subscribe to a different plan');

// Fill the org past the Free cap, then a downgrade to Free is blocked.
for (let i = 0; i < 15; i++)
  await call(root, '/api/students', 'POST', { name: 'F' + i, email: `f${i}_${rand}@x.com`, phone: '9000000009' });
const badDown = await call(root, '/api/my-org/plan', 'POST', { planId: freeP.id }, false);
if (badDown.status !== 400) throw new Error('downgrade below current usage should be blocked (400)');
ok('cannot downgrade to a plan smaller than the current student count');

// A normal teacher can view the plan but cannot change it.
if ((await call(normal, '/api/my-org/plan')).status !== 200) throw new Error('normal teacher should view the plan');
if ((await call(normal, '/api/my-org/plan', 'POST', { planId: basicP.id }, false)).status !== 403)
  throw new Error('normal teacher changing the plan should be 403');
ok('normal teacher can view but not change the subscription');

// --- Root edits teachers and pending invites (except email) ---
const ntId = (await call(root, '/api/teachers')).data.teachers.find((t) => t.email === `nt${rand}@x.com`).id;
if ((await call(root, '/api/teachers/' + ntId, 'PUT', { name: 'Normal Edited', phone: '9111111111', isRoot: false })).status !== 200)
  throw new Error('root should edit a signed-up teacher');
const editedT = (await call(root, '/api/teachers')).data.teachers.find((t) => t.email === `nt${rand}@x.com`);
if (editedT.name !== 'Normal Edited' || editedT.phone !== '9111111111') throw new Error('signed-up teacher edit did not persist');
ok('root edits a signed-up teacher (name/phone)');

const invite = (await call(root, '/api/teachers')).data.teachers.find((t) => t.email === `an${rand}@x.com`);
const invToken = new URLSearchParams(invite.signupPath.split('?')[1]).get('token');
if ((await call(root, '/api/teacher-invites/' + invToken, 'PUT', { name: 'Invite Edited', phone: '9222222222', isRoot: true })).status !== 200)
  throw new Error('root should edit a pending invite');
const invAfter = (await call(root, '/api/teachers')).data.teachers.find((t) => t.email === `an${rand}@x.com`);
if (invAfter.name !== 'Invite Edited' || !invAfter.isRoot) throw new Error('pending invite edit did not persist');
ok('root edits a pending teacher invite (name/phone/role)');

if ((await call(normal, '/api/teachers/' + ntId, 'PUT', { name: 'X', phone: '9000000000', isRoot: false }, false)).status !== 403)
  throw new Error('a normal teacher editing a teacher should be 403');
ok('a normal teacher cannot edit teachers (403)');

// --- Disabling teachers (root only) ---
const normalId = (await call(root, '/api/teachers')).data.teachers.find((t) => t.email === `nt${rand}@x.com`).id;

// A non-root teacher cannot disable anyone.
if ((await call(normal, '/api/teachers/' + normalId, 'PATCH', { disabled: true }, false)).status !== 403)
  throw new Error('non-root disabling a teacher should be 403');
ok('non-root teacher cannot disable teachers (403)');

// Root cannot disable their own account.
if ((await call(root, '/api/teachers/' + me.id, 'PATCH', { disabled: true }, false)).status !== 400)
  throw new Error('root disabling self should be 400');
ok('root cannot disable their own account');

// Root disables the normal teacher -> logged out + cannot log in.
if ((await call(root, '/api/teachers/' + normalId, 'PATCH', { disabled: true })).status !== 200)
  throw new Error('root should disable a teacher');
if ((await call(normal, '/api/me')).data.user !== null) throw new Error('disabled teacher session should be revoked');
if ((await call(makeJar(), '/api/login', 'POST', { email: `nt${rand}@x.com`, password: 'pass123' }, false)).status !== 403)
  throw new Error('disabled teacher login should be 403');
ok('root disabled a teacher: session revoked and login blocked');

// Re-enable -> can log in again.
await call(root, '/api/teachers/' + normalId, 'PATCH', { disabled: false });
if ((await call(makeJar(), '/api/login', 'POST', { email: `nt${rand}@x.com`, password: 'pass123' }, false)).status !== 200)
  throw new Error('re-enabled teacher should log in');
ok('re-enabled teacher can log in again');

console.log('\n✅ TEACHERS-TEST: ALL CHECKS PASSED\n');
