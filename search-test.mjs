import { registerTeacher } from './bootstrap.mjs';
// Tests server-side search of students by name and email.
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
const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });
const mk = (name, email) => call(teacher, '/api/students', 'POST', { name, email, phone: '9000000000' });
await mk('Alice Johnson', `alice${rand}@school.com`);
await mk('Bob Smith', `bob${rand}@school.com`);
await mk('Charlie Brown', `charlie${rand}@other.com`);
ok('created 3 students');

const names = (r) => r.students.map((s) => s.name).sort();

// name match (case-insensitive, partial)
let r = await call(teacher, '/api/students?q=' + encodeURIComponent('ALICE'));
if (JSON.stringify(names(r)) !== JSON.stringify(['Alice Johnson'])) throw new Error('name search failed: ' + names(r));
ok('case-insensitive partial name match');

// email match
r = await call(teacher, '/api/students?q=' + encodeURIComponent('bob' + rand + '@school'));
if (JSON.stringify(names(r)) !== JSON.stringify(['Bob Smith'])) throw new Error('email search failed: ' + names(r));
ok('email search match');

// shared substring matches multiple
r = await call(teacher, '/api/students?q=' + encodeURIComponent('school.com'));
if (names(r).length !== 2) throw new Error('expected 2 for school.com, got ' + names(r).length);
ok('substring matches multiple students');

// no match
r = await call(teacher, '/api/students?q=' + encodeURIComponent('zzzznope'));
if (r.students.length !== 0) throw new Error('expected 0 results');
ok('no-match returns empty');

// empty query returns all
r = await call(teacher, '/api/students');
if (r.students.length !== 3) throw new Error('expected all 3, got ' + r.students.length);
ok('empty query returns all students');

// wildcard is treated literally (not "match everything")
r = await call(teacher, '/api/students?q=' + encodeURIComponent('%'));
if (r.students.length !== 0) throw new Error('literal % should match none, got ' + r.students.length);
ok('LIKE wildcard is escaped (literal match)');

// search is scoped to the teacher's own students
const other = await registerTeacher(BASE, makeJar, call, { name: 'O', email: `o${rand}@x.com`, password: 'secret123' });
r = await call(other, '/api/students?q=' + encodeURIComponent('Alice'));
if (r.students.length !== 0) throw new Error('another teacher saw someone else’s students');
ok('search only returns the current teacher’s students');

console.log('\n✅ SEARCH-TEST: ALL CHECKS PASSED\n');
