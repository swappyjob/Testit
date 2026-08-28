import { registerTeacher } from './bootstrap.mjs';
// Profile details: first/last name are real, backfilled fields, editable via
// PATCH /api/me, and the combined `name` stays in sync for display.

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

// A teacher registered from a single "First Last" name gets that split into
// real first/last fields (the backfill / nameParts split).
const root = await registerTeacher(BASE, makeJar, call, { name: 'Anjali Verma', email: `prof${rand}@x.com`, password: 'secret123' });
let me = (await call(root, '/api/me')).data.user;
if (me.firstName !== 'Anjali' || me.lastName !== 'Verma') throw new Error('a single name should split into first/last, got ' + JSON.stringify(me));
if (me.name !== 'Anjali Verma') throw new Error('the combined display name should be preserved');
ok('a registered teacher’s name is split into real first/last fields');

// Editing first/last via PATCH /api/me updates both the fields and the display name.
const upd = await call(root, '/api/me', 'PATCH', { firstName: 'Anjali', lastName: 'Kumar Verma' });
if (upd.status !== 200) throw new Error('PATCH /api/me should succeed');
if (upd.data.user.firstName !== 'Anjali' || upd.data.user.lastName !== 'Kumar Verma') throw new Error('the response should carry the updated names');
if (upd.data.user.name !== 'Anjali Kumar Verma') throw new Error('the combined name should be rebuilt as "first last"');
me = (await call(root, '/api/me')).data.user;
if (me.name !== 'Anjali Kumar Verma' || me.lastName !== 'Kumar Verma') throw new Error('the change should persist on /api/me');
ok('PATCH /api/me updates first/last and keeps the combined name in sync');

// A blank first name is rejected.
if ((await call(root, '/api/me', 'PATCH', { firstName: '  ', lastName: 'X' }, false)).status !== 400)
  throw new Error('an empty first name should be rejected (400)');
ok('a blank first name is rejected (400)');

// Email and role are not self-editable via this endpoint (ignored, not applied).
await call(root, '/api/me', 'PATCH', { firstName: 'Anjali', lastName: 'Verma', email: 'hacker@x.com', role: 'admin' });
me = (await call(root, '/api/me')).data.user;
if (me.email === 'hacker@x.com' || me.role !== 'teacher') throw new Error('email/role must not be self-editable via /api/me');
ok('email and role cannot be changed through the profile endpoint');

// Creating a teacher with explicit first/last stores the combined name on the invite.
const inv = (await call(root, '/api/teachers', 'POST', { firstName: 'Ravi', lastName: 'Nair', email: `t${rand}@x.com`, phone: '9000000002', isRoot: false })).data;
if (!inv.signupPath) throw new Error('creating a teacher should return a signup link');
const listed = (await call(root, '/api/teachers')).data.teachers.find((t) => t.email === `t${rand}@x.com`);
if (!listed || listed.name !== 'Ravi Nair') throw new Error('the invited teacher should carry the combined name, got ' + JSON.stringify(listed));
ok('creating a teacher with first/last stores the combined display name');

console.log('\n✅ PROFILE-TEST: ALL CHECKS PASSED\n');
