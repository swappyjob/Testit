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
const rando = makeJar();
await call(rando, '/api/register-teacher', 'POST', { name: 'R', email: `r${rand}@x.com`, password: 'secret123' });
if ((await call(rando, '/api/orgs', 'GET', undefined, false)).status !== 403) throw new Error('teacher should be 403 on /api/orgs');
if ((await call(rando, '/api/admin/root-teachers', 'POST', { orgId: 1, name: 'x', email: `z${rand}@x.com`, phone: '9' }, false)).status !== 403)
  throw new Error('teacher should be 403 creating root teachers');
ok('non-admin is blocked from admin endpoints (403)');

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

console.log('\n✅ ADMIN-TEST: ALL CHECKS PASSED\n');
