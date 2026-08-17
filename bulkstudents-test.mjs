import { registerTeacher } from './bootstrap.mjs';
// Bulk student import: valid rows create invites; bad rows are skipped with
// reasons; duplicates and the plan cap are respected.
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
async function call(jar, p, method = 'GET', body, expectOk = true) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res);
  let data = {}; try { data = await res.json(); } catch {}
  if (expectOk && !res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${data.error || 'error'}`);
  return { status: res.status, data };
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);
const reasons = (r) => r.skipped.map((s) => s.reason);

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });

// A mixed batch: 3 valid, plus a bad email, a missing phone, and a duplicate row.
const batch = [
  { name: 'Alice', email: `alice${rand}@x.com`, phone: '9000000001' },
  { name: 'Bob', email: `bob${rand}@x.com`, phone: '9000000002', accessUntil: '2026-12-31' },
  { name: 'Cara', email: `cara${rand}@x.com`, phone: '9000000003' },
  { name: 'BadEmail', email: 'not-an-email', phone: '9000000004' },
  { name: 'NoPhone', email: `nophone${rand}@x.com`, phone: '' },
  { name: 'Alice again', email: `alice${rand}@x.com`, phone: '9000000009' }, // duplicate in file
];
let r = (await call(teacher, '/api/students/bulk', 'POST', { students: batch })).data;
if (r.created.length !== 3) throw new Error('should create the 3 valid students, got ' + r.created.length);
if (r.skipped.length !== 3) throw new Error('should skip 3 rows, got ' + r.skipped.length);
if (!r.created.every((c) => /^\/signup\?token=/.test(c.signupPath))) throw new Error('each created student should get a signup link');
if (!reasons(r).some((x) => /email/i.test(x)) || !reasons(r).some((x) => /phone/i.test(x)) || !reasons(r).some((x) => /Duplicate/i.test(x)))
  throw new Error('skip reasons should cover email, phone and duplicate: ' + JSON.stringify(reasons(r)));
ok('valid rows are created (with signup links); bad email / missing phone / in-file duplicate are skipped with reasons');

// They now appear in the students list as pending invites.
const list = (await call(teacher, '/api/students')).data.students;
if (!list.find((s) => s.email === `alice${rand}@x.com` && !s.signedUp)) throw new Error('imported students should appear as pending invites');
ok('imported students show up in the roster as pending invites');

// Re-importing an existing student is skipped as already-in-org.
r = (await call(teacher, '/api/students/bulk', 'POST', { students: [{ name: 'Alice', email: `alice${rand}@x.com`, phone: '9000000001' }] })).data;
if (r.created.length !== 0 || !/already/i.test(r.skipped[0].reason)) throw new Error('re-importing an existing student should be skipped');
ok('re-importing an existing org student is skipped (already in your organization)');

// Plan cap: the org is on Free (15). With 3 used, importing 15 more fits only 12.
const many = Array.from({ length: 15 }, (_, i) => ({ name: 'S' + i, email: `bulk${i}_${rand}@x.com`, phone: '90000000' + (i + 10) }));
r = (await call(teacher, '/api/students/bulk', 'POST', { students: many })).data;
if (r.created.length !== 12) throw new Error('should create only up to the plan cap (12 more), got ' + r.created.length);
if (!reasons(r).every((x) => /Plan limit/i.test(x)) || r.skipped.length !== 3) throw new Error('overflow rows should be skipped for the plan limit');
ok('the plan student cap is enforced during import (overflow skipped)');

// Empty import is rejected.
if ((await call(teacher, '/api/students/bulk', 'POST', { students: [] }, false)).status !== 400) throw new Error('empty import should be 400');
ok('an empty import is rejected (400)');

console.log('\n✅ BULKSTUDENTS-TEST: ALL CHECKS PASSED\n');
