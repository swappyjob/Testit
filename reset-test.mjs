// Tests password reset: admin-generated links, the reset flow, and permissions.
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
const tokenOf = (resetPath) => new URLSearchParams(resetPath.split('?')[1]).get('token');
const rand = Math.floor(Math.random() * 1e6);

// Act as a root teacher.
const teacher = makeJar();
const tEmail = `rt${rand}@x.com`;
const reg = await call(teacher, '/api/register-teacher', 'POST', { name: 'RT', email: tEmail, password: 'secret123' });
if (!reg.data.user.isRoot) execSync(`"${process.execPath}" "${path.join(__dirname, 'make-root.mjs')}" ${tEmail}`, { stdio: 'ignore' });
const me = (await call(teacher, '/api/me')).data.user;
if (!me.isRoot) throw new Error('could not obtain a root teacher');
ok('acting as a root teacher');

// Create + sign up a student.
const stEmail = `st${rand}@x.com`;
const stok = (await call(teacher, '/api/students', 'POST', { name: 'Stu', email: stEmail, phone: '9000000001' })).data.token;
const student = makeJar();
const su = (await call(student, '/api/signup/' + stok, 'POST', { password: 'oldpass1' })).data.user;
if ((await call(student, '/api/my-assignments')).status !== 200) throw new Error('student should be logged in after signup');
ok('student created and logged in');

// Teacher generates a reset link for the student.
const rp = (await call(teacher, '/api/students/' + su.id + '/reset-link', 'POST')).data.resetPath;
const tok = tokenOf(rp);
ok('teacher generated a student reset link');

// The token validates with the right email/role (no auth needed).
const info = (await call(makeJar(), '/api/reset/' + tok)).data;
if (info.email !== stEmail || info.role !== 'student') throw new Error('reset token info wrong');
ok('reset token validates with correct email/role');

// Reset the password.
if ((await call(makeJar(), '/api/reset/' + tok, 'POST', { password: 'newpass1' })).status !== 200)
  throw new Error('reset should succeed');
ok('password reset succeeded');

// The student's previous session is now invalidated.
if ((await call(student, '/api/my-assignments', 'GET', undefined, false)).status !== 401)
  throw new Error('old session should be revoked after reset');
ok('old session invalidated after reset');

// Old password fails, new one works.
if ((await call(makeJar(), '/api/login', 'POST', { email: stEmail, password: 'oldpass1' }, false)).status !== 401)
  throw new Error('old password should fail');
if ((await call(makeJar(), '/api/login', 'POST', { email: stEmail, password: 'newpass1' }, false)).status !== 200)
  throw new Error('new password should work');
ok('old password rejected, new password works');

// The token is single-use.
if ((await call(makeJar(), '/api/reset/' + tok, 'POST', { password: 'another1' }, false)).status !== 410)
  throw new Error('used token should be 410');
ok('used token cannot be reused');

// forgot-password responds generically for both existing and unknown emails.
if ((await call(makeJar(), '/api/forgot-password', 'POST', { email: stEmail }, false)).status !== 200)
  throw new Error('forgot-password (known) should be 200');
if ((await call(makeJar(), '/api/forgot-password', 'POST', { email: `nobody${rand}@x.com` }, false)).status !== 200)
  throw new Error('forgot-password (unknown) should be 200');
ok('forgot-password responds generically (no account enumeration)');

// A short new password is rejected (fresh token).
const rp2 = (await call(teacher, '/api/students/' + su.id + '/reset-link', 'POST')).data.resetPath;
if ((await call(makeJar(), '/api/reset/' + tokenOf(rp2), 'POST', { password: '123' }, false)).status !== 400)
  throw new Error('short password should be 400');
ok('short new password rejected');

// Permissions: another (normal) teacher cannot reset this student, nor reset teachers.
const other = makeJar();
const oEmail = `ot${rand}@x.com`;
await call(other, '/api/register-teacher', 'POST', { name: 'OT', email: oEmail, password: 'secret123' });
if ((await call(other, '/api/students/' + su.id + '/reset-link', 'POST', undefined, false)).status !== 404)
  throw new Error('non-owning teacher should get 404');
// "other" is a root teacher of a different org, so it cannot reset a teacher in this org.
if ((await call(other, '/api/teachers/' + me.id + '/reset-link', 'POST', undefined, false)).status !== 404)
  throw new Error('cross-org teacher reset should get 404');
ok('reset-link permissions enforced (owner-only students, same-org teachers)');

// Root can generate a reset link for a teacher in their own org.
const colleague = (await call(teacher, '/api/teachers', 'POST', { name: 'Colleague', email: `col${rand}@x.com`, phone: '9000000009', isRoot: false })).data;
const colUser = (await call(makeJar(), '/api/signup/' + tokenOf(colleague.signupPath), 'POST', { password: 'pass123' })).data.user;
if (!(await call(teacher, '/api/teachers/' + colUser.id + '/reset-link', 'POST')).data.resetPath)
  throw new Error('root should be able to reset a same-org teacher');
ok('root can generate a reset link for a teacher in their org');

console.log('\n✅ RESET-TEST: ALL CHECKS PASSED\n');
