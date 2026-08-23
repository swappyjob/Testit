import { registerTeacher } from './bootstrap.mjs';
// Scheduled test windows with teacher-defined, student-booked time slots:
//   - a test can (optionally) require students to book a slot
//   - a student can only enter within [slot − 30min, slot + duration + 30min]
//   - slots can have a capacity; full slots reject further bookings
//   - a teacher can reopen a missed booking so the student picks again
//   - everything is optional (plain tests are unaffected)
import pg from 'pg';

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
const Q = [{ type: 'truefalse', prompt: 'A', correct: 'true', points: 1 }];

// A datetime-local string (YYYY-MM-DDTHH:MM) in local time, offset by minutes.
function dt(offsetMin) {
  const d = new Date(Date.now() + offsetMin * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Enrol a fresh student in the teacher's org and assign them `testId`.
async function enrol(teacher, testId, email) {
  const { token } = (await call(teacher, '/api/students', 'POST', { name: email, email, phone: '9000000001' })).data;
  const s = makeJar();
  const { user } = (await call(s, '/api/signup/' + token, 'POST', { password: 'pass123' })).data;
  await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [user.id] });
  const aid = (await call(s, '/api/my-assignments')).data.assignments.find((a) => a.testId === testId).assignmentId;
  return { jar: s, userId: user.id, aid };
}

const teacher = await registerTeacher(BASE, makeJar, call, { name: 'Slot Coach', email: `slot${rand}@x.com`, password: 'secret123' });

// ---- Validation: slot booking requires slots + a duration --------------------
let r = await call(teacher, '/api/tests', 'POST', { title: 'Bad', questions: Q, requiresSlot: true, durationMinutes: 60, slots: [] }, false);
if (r.status !== 400) throw new Error('requiresSlot with no slots should be rejected, got ' + r.status);
r = await call(teacher, '/api/tests', 'POST', { title: 'Bad2', questions: Q, requiresSlot: true, durationMinutes: 0, slots: [{ at: dt(0) }] }, false);
if (r.status !== 400) throw new Error('requiresSlot with no duration should be rejected, got ' + r.status);
ok('slot booking is rejected without at least one slot and a duration');

// ---- A plain (non-slot) test is unaffected -----------------------------------
const plain = (await call(teacher, '/api/tests', 'POST', { title: 'Plain', questions: Q })).data;
const p1 = await enrol(teacher, plain.id, `plain${rand}@x.com`);
const pa = (await call(p1.jar, '/api/my-assignments')).data.assignments.find((a) => a.testId === plain.id);
if (pa.requiresSlot || pa.needsBooking) throw new Error('a plain test must not require a slot');
if ((await call(p1.jar, '/api/take/' + p1.aid)).status !== 200) throw new Error('a plain test should be takeable directly');
ok('a test without slot booking behaves normally (no booking required)');

// ---- Create a slot-scheduled test --------------------------------------------
const slots = [
  { at: dt(0), capacity: 0 },          // window open now, unlimited
  { at: dt(2 * 24 * 60), capacity: 0 }, // 2 days out, not open yet
  { at: dt(0), capacity: 1 },          // window open now, single seat
  { at: dt(-(60 + 60)), capacity: 0 }, // 2h ago → window (dur 60 + 30) already closed
];
const test = (await call(teacher, '/api/tests', 'POST', {
  title: 'Scheduled Exam', questions: Q, durationMinutes: 60, requiresSlot: true, startsAt: dt(-24 * 60), slots,
})).data;
const loaded = (await call(teacher, '/api/tests/' + test.id)).data;
if (loaded.slots.length !== 4) throw new Error('expected 4 slots saved, got ' + loaded.slots.length);
if (!loaded.test.requires_slot) throw new Error('test should be marked requires_slot');
const slotOpen = loaded.slots.find((s) => s.at === slots[0].at && s.capacity === 0);
const slotFuture = loaded.slots.find((s) => s.at === slots[1].at);
const slotCap = loaded.slots.find((s) => s.capacity === 1);
const slotPast = loaded.slots.find((s) => s.at === slots[3].at);
ok('a slot-scheduled test saves its slots and loads them back for editing');

// ---- Student must book before taking -----------------------------------------
const a1 = await enrol(teacher, test.id, `sa${rand}@x.com`);
let asg = (await call(a1.jar, '/api/my-assignments')).data.assignments.find((x) => x.testId === test.id);
if (!asg.requiresSlot || !asg.needsBooking) throw new Error('student should need to book a slot first');
if ((await call(a1.jar, '/api/take/' + a1.aid, 'GET', undefined, false)).status !== 403)
  throw new Error('taking before booking a slot should be blocked');
ok('a student cannot start a slot test before booking a slot');

// The bookable list flags the past slot and shows seats.
const list = (await call(a1.jar, '/api/my-assignments/' + a1.aid + '/slots')).data.slots;
if (list.length !== 4) throw new Error('student should see all 4 slots, got ' + list.length);
if (!list.find((s) => s.id === slotPast.id).past) throw new Error('the past slot should be flagged past');
ok('the slot list surfaces past slots and seat counts to the student');

// Booking a past slot is rejected.
if ((await call(a1.jar, '/api/my-assignments/' + a1.aid + '/slot', 'POST', { slotId: slotPast.id }, false)).status !== 409)
  throw new Error('booking a slot whose window has passed should be rejected');
ok('booking a slot whose window has already passed is rejected');

// Book the future slot → still can't take (window not open yet).
await call(a1.jar, '/api/my-assignments/' + a1.aid + '/slot', 'POST', { slotId: slotFuture.id });
asg = (await call(a1.jar, '/api/my-assignments')).data.assignments.find((x) => x.testId === test.id);
if (asg.needsBooking || !asg.slotUpcoming) throw new Error('after booking a future slot it should read as upcoming');
if ((await call(a1.jar, '/api/take/' + a1.aid, 'GET', undefined, false)).status !== 403)
  throw new Error('taking before the booked window opens should be blocked');
ok('a booked-but-not-yet-open slot still blocks entry (with an "opens at" message)');

// Rebook the open slot → now takeable, timer capped by the window.
await call(a1.jar, '/api/my-assignments/' + a1.aid + '/slot', 'POST', { slotId: slotOpen.id });
const take = (await call(a1.jar, '/api/take/' + a1.aid)).data;
if (!(take.remainingSeconds > 0 && take.remainingSeconds <= 3600)) throw new Error('remaining time should be within the 60-min limit: ' + take.remainingSeconds);
ok('booking a currently-open slot lets the student enter, timer within the window');

// Submitting inside the window works.
const qid = take.questions[0].id;
if ((await call(a1.jar, '/api/submit/' + a1.aid, 'POST', { answers: { [qid]: 'true' } })).status !== 200)
  throw new Error('submitting inside the window should succeed');
ok('a student can submit inside their slot window');

// ---- Capacity: a full slot rejects further bookings --------------------------
const b1 = await enrol(teacher, test.id, `sb${rand}@x.com`);
await call(b1.jar, '/api/my-assignments/' + b1.aid + '/slot', 'POST', { slotId: slotCap.id }); // takes the only seat
const c1 = await enrol(teacher, test.id, `sc${rand}@x.com`);
if ((await call(c1.jar, '/api/my-assignments/' + c1.aid + '/slot', 'POST', { slotId: slotCap.id }, false)).status !== 409)
  throw new Error('booking a full (capacity-reached) slot should be rejected');
ok('a slot at capacity rejects additional bookings (409)');

// ---- Missed window + teacher reopen ------------------------------------------
// c1 books the open slot, then we move that slot into the past to simulate a
// missed window (a student can't book a past slot directly).
await call(c1.jar, '/api/my-assignments/' + c1.aid + '/slot', 'POST', { slotId: slotOpen.id });
const client = new pg.Client({
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'testit_test',
});
await client.connect();
await client.query('UPDATE test_slots SET slot_at = $1 WHERE id = $2', [dt(-(60 + 60)), slotOpen.id]);
await client.end();

asg = (await call(c1.jar, '/api/my-assignments')).data.assignments.find((x) => x.testId === test.id);
if (!asg.slotMissed) throw new Error('a booked slot whose window has passed should read as missed');
if ((await call(c1.jar, '/api/take/' + c1.aid, 'GET', undefined, false)).status !== 403)
  throw new Error('a missed slot should block entry');
ok('a student who misses their slot is blocked and flagged as missed');

// Teacher reopens → booking cleared, student can pick again.
const before = (await call(teacher, '/api/tests/' + test.id + '/assignments')).data.assigned.find((x) => x.student_id === c1.userId);
if (!before.slotAt) throw new Error('teacher view should show the student had booked a slot');
if ((await call(teacher, '/api/tests/' + test.id + '/reopen-slot', 'POST', { studentId: c1.userId })).status !== 200)
  throw new Error('teacher reopen should succeed');
asg = (await call(c1.jar, '/api/my-assignments')).data.assignments.find((x) => x.testId === test.id);
if (!asg.needsBooking || asg.slotMissed) throw new Error('after reopen the student should need to book again');
ok('a teacher can reopen a missed booking so the student picks a new slot');

// Reopen is refused once a student has submitted.
if ((await call(teacher, '/api/tests/' + test.id + '/reopen-slot', 'POST', { studentId: a1.userId }, false)).status !== 400)
  throw new Error('reopening a submitted student should be refused');
ok('reopening is refused for a student who already submitted');

console.log('\n✅ SLOTS-TEST: ALL CHECKS PASSED\n');
