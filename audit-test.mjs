// Tests org-wide audit logging: test create/edit/delete/assign, student add/disable,
// teacher invite — all visible to every teacher in the org, with search + org isolation.
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
const logs = (jar, q) => call(jar, '/api/audit' + (q ? '?q=' + encodeURIComponent(q) : '')).then((r) => r.data.logs);
const has = (arr, action, pred = () => true) => arr.some((l) => l.action === action && pred(l));

// --- Org A: root teacher does a bunch of actions ---
const root = makeJar();
await call(root, '/api/register-teacher', 'POST', { name: 'RootA', email: `root${rand}@a.com`, password: 'secret123' });

// Empty to start.
if ((await logs(root)).length !== 0) throw new Error('audit log should start empty for a new org');
ok('audit log starts empty for a new organization');

// Create a test.
const { id: testId } = (await call(root, '/api/tests', 'POST', {
  title: `Quiz ${rand}`, questions: [{ type: 'truefalse', prompt: 'A', correct: 'true', points: 1 }],
})).data;
let L = await logs(root);
if (!has(L, 'test.create', (l) => l.entityLabel === `Quiz ${rand}`)) throw new Error('missing test.create log');
if (L[0].actor !== 'RootA') throw new Error('log should record the actor name');
ok('creating a test is logged with actor + label');

// Edit the test (rename + add a question in a new "Physics" section).
await call(root, '/api/tests/' + testId, 'PUT', {
  title: `Quiz ${rand} v2`,
  questions: [
    { type: 'truefalse', prompt: 'A', correct: 'true', points: 1 },
    { type: 'truefalse', prompt: 'B', correct: 'false', points: 1, section: 'Physics' },
  ],
});
L = await logs(root);
if (!has(L, 'test.update', (l) => /Renamed to "Quiz .* v2"/.test(l.details) && /Added Physics section/.test(l.details) && /Added 1 question/.test(l.details)))
  throw new Error('test.update should spell out the rename, the new section, and the added question — got: ' + (L.find((x) => x.action === 'test.update') || {}).details);
ok('editing a test spells out what changed (rename, "Added Physics section", "Added 1 question")');

// Add a student and assign the test.
const { token } = (await call(root, '/api/students', 'POST', { name: 'Stu', email: `stu${rand}@a.com`, phone: '9000000001' })).data;
const stu = makeJar();
const { user } = (await call(stu, '/api/signup/' + token, 'POST', { password: 'pass123' })).data;
await call(root, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
L = await logs(root);
if (!has(L, 'student.create', (l) => l.entityLabel === 'Stu')) throw new Error('missing student.create log');
if (!has(L, 'test.assign', (l) => /Assigned to Stu/.test(l.details))) throw new Error('test.assign should name the student — got: ' + (L.find((x) => x.action === 'test.assign') || {}).details);
ok('adding a student and assigning a test are both logged (assign names the student)');

// Disable the student.
await call(root, '/api/students/' + user.id, 'PATCH', { disabled: true });
if (!has(await logs(root), 'student.disable', (l) => l.entityLabel === 'Stu')) throw new Error('missing student.disable log');
ok('disabling a student is logged');

// Invite a second teacher (also in org A).
await call(root, '/api/teachers', 'POST', { name: 'TeachB', email: `teachb${rand}@a.com`, phone: '9000000002' });
if (!has(await logs(root), 'teacher.create', (l) => l.entityLabel === 'TeachB')) throw new Error('missing teacher.create log');
ok('inviting a teacher is logged');

// Delete the test.
await call(root, '/api/tests/' + testId, 'DELETE');
if (!has(await logs(root), 'test.delete', (l) => /Quiz/.test(l.entityLabel))) throw new Error('missing test.delete log');
ok('deleting a test is logged');

// Search narrows results.
const searched = await logs(root, 'Stu');
if (searched.length === 0 || !searched.every((l) => /Stu/i.test(l.actor + l.entityLabel + l.details + l.action))) throw new Error('search should filter to matching rows');
ok('search filters the audit log');

// --- Org isolation: a teacher in another org sees none of org A's activity ---
const rootB = makeJar();
await call(rootB, '/api/register-teacher', 'POST', { name: 'RootB', email: `root${rand}@b.com`, password: 'secret123' });
const bLogs = await logs(rootB);
if (bLogs.some((l) => /@a\.com/.test(l.details) || /Quiz/.test(l.entityLabel))) throw new Error("org B must not see org A's audit entries");
ok("audit logs are org-scoped (org B can't see org A)");

// Students can't read the audit log at all. (Re-enable + re-login first: the
// earlier disable deleted this student's session, which would 401 rather than 403.)
await call(root, '/api/students/' + user.id, 'PATCH', { disabled: false });
const stu2 = makeJar();
await call(stu2, '/api/login', 'POST', { email: `stu${rand}@a.com`, password: 'pass123' });
if ((await call(stu2, '/api/audit', 'GET', undefined, false)).status !== 403) throw new Error('students must not access the audit log');
ok('the audit log is teacher-only (403 for students)');

console.log('\n✅ AUDIT-TEST: ALL CHECKS PASSED\n');
