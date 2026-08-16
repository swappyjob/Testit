import { registerTeacher } from './bootstrap.mjs';
// One student, multiple organizations: a student can be invited by a second org,
// accept with their existing login, and see mock tests from both — with per-org
// access control (disabling in one org doesn't affect the other).
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
const tf = (p) => ({ type: 'truefalse', prompt: p, correct: 'true', points: 1 });

// Two organizations (each registered teacher gets its own org).
const orgA = await registerTeacher(BASE, makeJar, call, { name: 'A', email: `a${rand}@x.com`, password: 'secret123' });
const orgB = await registerTeacher(BASE, makeJar, call, { name: 'B', email: `b${rand}@x.com`, password: 'secret123' });
const email = `rahul${rand}@x.com`;

// Org A invites the student; they sign up (new account).
const tokA = (await call(orgA, '/api/students', 'POST', { name: 'Rahul', email, phone: '9000000001' })).data.token;
const student = makeJar();
const user = (await call(student, '/api/signup/' + tokA, 'POST', { password: 'pass123' })).data.user;
ok('student signs up in Org A');

// Org B invites the SAME email — allowed (no cross-org 409).
const invB = await call(orgB, '/api/students', 'POST', { name: 'Rahul', email, phone: '9000000001' }, false);
if (invB.status !== 200) throw new Error('a second org should be able to invite an existing student, got ' + invB.status);
const tokB = invB.data.token;
ok('a second organization can invite the same student (no cross-org 409)');

// The invite is flagged as belonging to an existing account.
const info = (await call(makeJar(), '/api/signup/' + tokB)).data;
if (!info.existingAccount) throw new Error('signup info should flag existingAccount for a known email');
ok('the invite is flagged “already has an account”');

// An anonymous / wrong user cannot accept; the real student (logged in) can.
if ((await call(makeJar(), '/api/accept-invite/' + tokB, 'POST', undefined, false)).status !== 401)
  throw new Error('accepting requires the student to be logged in');
if ((await call(student, '/api/accept-invite/' + tokB, 'POST')).status !== 200)
  throw new Error('the logged-in student should accept the invite');
ok('the student accepts the invite and joins Org B');

// Each org assigns a mock test.
const testA = (await call(orgA, '/api/tests', 'POST', { title: 'Mock A', questions: [tf('A')] })).data.id;
const testB = (await call(orgB, '/api/tests', 'POST', { title: 'Mock B', questions: [tf('B')] })).data.id;
await call(orgA, '/api/assignments', 'POST', { test_id: testA, student_ids: [user.id] });
await call(orgB, '/api/assignments', 'POST', { test_id: testB, student_ids: [user.id] });

// The student sees BOTH orgs' tests, each labelled with its organization.
let mine = (await call(student, '/api/my-assignments')).data.assignments;
if (mine.length !== 2) throw new Error('student should see tests from both orgs, got ' + mine.length);
if (mine.map((a) => a.title).sort().join(',') !== 'Mock A,Mock B') throw new Error('should see both orgs’ tests');
if (!mine.every((a) => a.orgName)) throw new Error('each test should be labelled with its organization');
ok('student sees mock tests from BOTH organizations, each labelled by org');

// The org switcher lists both active organizations.
if ((await call(student, '/api/my-orgs')).data.orgs.length !== 2) throw new Error('my-orgs should list both organizations');
ok('my-orgs lists both organizations (for the switcher / login picker)');

// Disabling in Org A hides only Org A's test; Org B remains.
await call(orgA, '/api/students/' + user.id, 'PATCH', { disabled: true });
mine = (await call(student, '/api/my-assignments')).data.assignments;
if (mine.length !== 1 || mine[0].title !== 'Mock B') throw new Error('disabling in Org A should hide only Org A’s test');
if ((await call(student, '/api/my-orgs')).data.orgs.length !== 1) throw new Error('a disabled org should drop out of my-orgs');
ok('disabling the student in Org A hides only Org A’s test; Org B’s remains');

// The student is still active in Org B (per-org isolation).
const bRow = (await call(orgB, '/api/students')).data.students.find((s) => s.email === email);
if (!bRow || bRow.disabled) throw new Error('student should still be active in Org B');
ok('the student is still active in Org B (per-org isolation)');

// A duplicate invite within the same org is rejected.
if ((await call(orgB, '/api/students', 'POST', { name: 'Rahul', email, phone: '9000000001' }, false)).status !== 409)
  throw new Error('a duplicate invite within the same org should be 409');
ok('a duplicate invite within the same org is rejected (409)');

// A student cannot accept an invite addressed to someone else's email.
const tokOther = (await call(orgA, '/api/students', 'POST', { name: 'Other', email: `other${rand}@x.com`, phone: '9000000002' })).data.token;
if ((await call(student, '/api/accept-invite/' + tokOther, 'POST', undefined, false)).status !== 403)
  throw new Error('accepting an invite for a different email should be 403');
ok('a student cannot accept an invite meant for a different email (403)');

console.log('\n✅ MULTIORG-TEST: ALL CHECKS PASSED\n');
