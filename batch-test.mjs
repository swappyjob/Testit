import { registerTeacher } from './bootstrap.mjs';
// Student batches: a per-org grouping label so students can be clubbed together
// and a test assigned to a whole batch in one call.
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
const Q = [{ type: 'multi', prompt: 'q', options: ['a', 'b'], correct: [0], points: 1 }];
const NEET = 'Class 11 – NEET', JEE = 'Class 12 – JEE';

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'B', email: `bt${rand}@x.com`, password: 'secret123' });

// Create + sign up three students across two batches.
async function makeStudent(name, batch) {
  const email = `${name}${rand}@x.com`.toLowerCase();
  const tok = (await call(teacher, '/api/students', 'POST', { firstName: name, lastName: 'X', email, phone: '9000000001', batch })).data.token;
  const jar = makeJar();
  await call(jar, '/api/signup/' + tok, 'POST', { password: 'pass123' });
  return email;
}
const nA = await makeStudent('Neeta', NEET);
const nB = await makeStudent('Nikhil', NEET);
const jC = await makeStudent('Jaya', JEE);

// The batch is stored and returned on the roster.
const roster = (await call(teacher, '/api/students')).data.students;
if (roster.find((s) => s.email === nA).batch !== NEET) throw new Error('the student roster should carry the batch label');
ok('a student is created with a batch, and the roster returns it');

// Distinct batches are exposed for autocomplete / assignment (sorted).
const batches = (await call(teacher, '/api/batches')).data.batches;
if (!batches.includes(NEET) || !batches.includes(JEE)) throw new Error('GET /api/batches should list every distinct batch: ' + JSON.stringify(batches));
ok('GET /api/batches lists the distinct batch labels');

// Assign a test to a WHOLE batch in one call.
const testId = (await call(teacher, '/api/tests', 'POST', { title: 'Batch test', questions: Q })).data.id;
const asg = await call(teacher, '/api/assignments', 'POST', { test_id: testId, batch: NEET });
if (asg.data.assigned !== 2) throw new Error('assigning the NEET batch should assign exactly its 2 students, got ' + asg.data.assigned);
const assignedEmails = (await call(teacher, '/api/tests/' + testId + '/assignments')).data.assigned.map((a) => a.email);
if (!assignedEmails.includes(nA) || !assignedEmails.includes(nB)) throw new Error('both NEET students should be assigned');
if (assignedEmails.includes(jC)) throw new Error('the JEE student must NOT be assigned to the NEET batch');
ok('assigning a test to a batch assigns exactly that batch’s students');

// Re-assigning the same batch is idempotent (no duplicates).
const again = await call(teacher, '/api/assignments', 'POST', { test_id: testId, batch: NEET });
if (again.data.assigned !== 0) throw new Error('re-assigning an already-assigned batch should add 0, got ' + again.data.assigned);
ok('re-assigning a batch is idempotent (no duplicate assignments)');

// Editing a student's batch moves them, and the batches list reflects it.
const jayaId = roster.find((s) => s.email === jC).id;
await call(teacher, '/api/students/' + jayaId, 'PUT', { name: 'Jaya X', firstName: 'Jaya', lastName: 'X', phone: '9000000001', batch: 'Dropper – NEET' });
const rebatch = (await call(teacher, '/api/students')).data.students.find((s) => s.email === jC).batch;
if (rebatch !== 'Dropper – NEET') throw new Error('editing a student should update their batch');
if (!(await call(teacher, '/api/batches')).data.batches.includes('Dropper – NEET')) throw new Error('the new batch should appear in /api/batches');
ok('editing a student moves them to a new batch');

// Bulk import carries the batch column.
const bulk = await call(teacher, '/api/students/bulk', 'POST', { students: [
  { name: 'Bulk One', email: `b1${rand}@x.com`, phone: '9000000002', batch: 'Class 11 – NEET' },
  { name: 'Bulk Two', email: `b2${rand}@x.com`, phone: '9000000003', batch: 'Foundation' },
] });
if (bulk.data.created.length !== 2) throw new Error('both bulk rows should be created');
const after = (await call(teacher, '/api/students')).data.students;
if (after.find((s) => s.email === `b1${rand}@x.com`).batch !== 'Class 11 – NEET') throw new Error('bulk import should store the batch');
ok('bulk import stores each row’s batch');

// Renaming a batch moves everyone in it; renaming to an existing name merges them.
const ren = await call(teacher, '/api/batches/rename', 'POST', { from: 'Foundation', to: NEET });
if (!(ren.data.updated >= 1)) throw new Error('rename should report how many students moved: ' + JSON.stringify(ren.data));
if ((await call(teacher, '/api/batches')).data.batches.includes('Foundation')) throw new Error('the old batch name should be gone after rename');
const moved = (await call(teacher, '/api/students')).data.students.find((s) => s.email === `b2${rand}@x.com`);
if (moved.batch !== NEET) throw new Error('the renamed student should now be in the merged batch, got ' + moved.batch);
ok('renaming a batch moves/merges every student in it');

console.log('\n✅ BATCH-TEST: ALL CHECKS PASSED\n');
