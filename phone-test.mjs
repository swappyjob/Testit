// Tests that a student's phone number is required, stored, and carried to signup.
const BASE = 'http://localhost:3000';
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

// Missing phone is rejected
let rejected = false;
try { await call(teacher, '/api/students', 'POST', { name: 'NoPhone', email: `np${rand}@x.com` }); }
catch { rejected = true; }
if (!rejected) throw new Error('student without phone was accepted');
ok('phone is required when creating a student');

// Invalid phone is rejected
let badRejected = false;
try { await call(teacher, '/api/students', 'POST', { name: 'Bad', email: `bad${rand}@x.com`, phone: 'abc' }); }
catch { badRejected = true; }
if (!badRejected) throw new Error('invalid phone was accepted');
ok('invalid phone rejected');

// Valid creation stores the phone
const phone = '+91 98765 43210';
const { token } = await call(teacher, '/api/students', 'POST', { name: 'Asha', email: `asha${rand}@x.com`, phone });
const { students } = await call(teacher, '/api/students');
const created = students.find((s) => s.email === `asha${rand}@x.com`);
if (!created || created.phone !== phone) throw new Error('phone not stored on the invite');
ok('phone stored and listed for the teacher');

// After signup, the phone stays on the record
await call(student, '/api/signup/' + token, 'POST', { password: 'pass123' });
const after = (await call(teacher, '/api/students')).students.find((s) => s.email === `asha${rand}@x.com`);
if (after.phone !== phone || !after.signedUp) throw new Error('phone lost after signup');
ok('phone retained after the student signs up');

console.log('\n✅ PHONE-TEST: ALL CHECKS PASSED\n');
