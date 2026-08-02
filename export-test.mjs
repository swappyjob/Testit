// Tests the students CSV export.
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
async function call(jar, path, method = 'GET', body) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res);
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || 'error'}`);
  return data;
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);
const teacher = makeJar(), student = makeJar();

await call(teacher, '/api/register-teacher', 'POST', { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
// A name with a comma to test CSV escaping.
await call(teacher, '/api/students', 'POST', { name: 'Doe, John', email: `john${rand}@x.com`, phone: '+91 90000 11111' });
const { token } = await call(teacher, '/api/students', 'POST', { name: 'Asha', email: `asha${rand}@x.com`, phone: '9000022222' });
await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
ok('created 2 students (one pending, one signed up)');

// Fetch the CSV with the teacher's cookie
const res = await fetch(BASE + '/api/students/export.csv', { headers: { cookie: teacher.header() } });
if (res.status !== 200) throw new Error('export status ' + res.status);
if (!(res.headers.get('content-type') || '').includes('text/csv')) throw new Error('wrong content-type');
if (!(res.headers.get('content-disposition') || '').includes('students.csv')) throw new Error('missing filename');
ok('CSV served with attachment headers');

const text = await res.text();
const body = text.replace(/^﻿/, '');
const lines = body.trim().split('\r\n');
if (lines[0] !== 'Name,Email,Mobile Number,Signup Status,Account Status,Added On') throw new Error('bad header: ' + lines[0]);
ok('header row correct');

if (lines.length !== 3) throw new Error('expected 3 lines (header + 2), got ' + lines.length);
ok('one row per student');

// The comma-containing name must be quoted
if (!body.includes('"Doe, John"')) throw new Error('comma in name not quoted');
ok('field with a comma is quoted correctly');

// Signed-up student shows Active; pending shows Invite pending
if (!body.includes('Asha,asha' + rand + '@x.com,9000022222,Signed up,Active')) throw new Error('signed-up row wrong');
if (!/Doe, John.*Invite pending/.test(body)) throw new Error('pending row wrong');
ok('signup and account status columns correct');

// Export is scoped to the teacher
const other = makeJar();
await call(other, '/api/register-teacher', 'POST', { name: 'O', email: `o${rand}@x.com`, password: 'secret123' });
const res2 = await fetch(BASE + '/api/students/export.csv', { headers: { cookie: other.header() } });
const body2 = (await res2.text()).replace(/^﻿/, '').trim();
if (body2.split('\r\n').length !== 1) throw new Error('other teacher should get only the header row');
ok('export scoped to the current teacher');

console.log('\n✅ EXPORT-TEST: ALL CHECKS PASSED\n');
