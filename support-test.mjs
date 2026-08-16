import { registerTeacher } from './bootstrap.mjs';
// Support tickets: a teacher raises a ticket, a support agent works it through a
// threaded conversation and status changes, with proper permission boundaries.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TEST_BASE || 'http://localhost:3000';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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

// A support agent (bootstrapped like the admin in admin-test).
const supEmail = `sup${rand}@x.com`;
execSync(`"${process.execPath}" "${path.join(__dirname, 'make-support.mjs')}" Support ${supEmail} suppass1`, { stdio: 'ignore' });
const support = makeJar();
const supUser = (await call(support, '/api/login', 'POST', { email: supEmail, password: 'suppass1' })).data.user;
if (supUser.role !== 'support') throw new Error('support login role should be support');
ok('support agent created and logged in');

// A teacher raises a ticket — with a screenshot attached.
const teacher = await registerTeacher(BASE, makeJar, call, { name: 'Ms Rao', email: `t${rand}@x.com`, password: 'secret123' });
const shot = (await call(teacher, '/api/ticket-upload', 'POST', { dataUrl: PNG })).data.url;
if (!/^\/uploads\/[\w.-]+\.png$/.test(shot)) throw new Error('ticket screenshot should upload to /uploads');
const { id: ticketId } = (await call(teacher, '/api/tickets', 'POST',
  { subject: 'Cannot add an image to a question', category: 'Test builder', priority: 'high', message: 'The upload button does nothing.', image: shot })).data;
if (!ticketId) throw new Error('ticket should be created');
ok('teacher raises a support ticket with a screenshot');

// The screenshot is stored on the first message and visible to support.
const firstMsg = (await call(teacher, '/api/tickets/' + ticketId)).data.messages[0];
if (firstMsg.image !== shot) throw new Error('the screenshot should be attached to the ticket');
ok('the attached screenshot is saved on the ticket');

// Teacher sees it in their list (status open, one message = the description).
let mine = (await call(teacher, '/api/tickets')).data.tickets;
if (mine.length !== 1 || mine[0].status !== 'open' || mine[0].subject !== 'Cannot add an image to a question') throw new Error('teacher should see their open ticket');
if ((await call(teacher, '/api/tickets/' + ticketId)).data.messages.length !== 1) throw new Error('ticket should start with the description message');
ok('teacher sees their ticket (open, with the description)');

// Support sees it in the queue with an open count.
const queue = (await call(support, '/api/support/tickets')).data;
if (!queue.tickets.find((t) => t.id === ticketId)) throw new Error('support should see the ticket in the queue');
if (queue.counts.open < 1) throw new Error('open count should include the new ticket');
const detail = (await call(support, '/api/support/tickets/' + ticketId)).data;
if (detail.ticket.teacherEmail !== `t${rand}@x.com`) throw new Error('support detail should show who raised it');
ok('support sees the ticket in the queue with the teacher’s details');

// Support replies → ticket moves to in_progress.
await call(support, '/api/support/tickets/' + ticketId + '/messages', 'POST', { body: 'Which browser are you using?' });
if ((await call(support, '/api/support/tickets/' + ticketId)).data.ticket.status !== 'in_progress') throw new Error('a support reply should move the ticket to in_progress');
ok('a support reply moves the ticket to in_progress');

// Teacher sees the support reply and the new status.
const afterReply = (await call(teacher, '/api/tickets/' + ticketId)).data;
if (afterReply.ticket.status !== 'in_progress') throw new Error('teacher should see in_progress');
if (!afterReply.messages.some((m) => m.authorRole === 'support')) throw new Error('teacher should see the support reply');
ok('teacher sees the support reply and the updated status');

// Support marks it resolved; a teacher reply reopens it.
await call(support, '/api/support/tickets/' + ticketId, 'PATCH', { status: 'resolved' });
await call(teacher, '/api/tickets/' + ticketId + '/messages', 'POST', { body: 'Still broken on Chrome.' });
if ((await call(support, '/api/support/tickets/' + ticketId)).data.ticket.status !== 'open') throw new Error('a teacher reply to a resolved ticket should reopen it');
ok('a teacher reply to a resolved ticket reopens it');

// Support closes it; the teacher can no longer reply.
await call(support, '/api/support/tickets/' + ticketId, 'PATCH', { status: 'closed' });
if ((await call(teacher, '/api/tickets/' + ticketId + '/messages', 'POST', { body: 'hello?' }, false)).status !== 409)
  throw new Error('replying to a closed ticket should be 409');
ok('a closed ticket cannot be replied to (409)');

// Permission boundaries.
const other = await registerTeacher(BASE, makeJar, call, { name: 'Other', email: `o${rand}@x.com`, password: 'secret123' });
if ((await call(other, '/api/tickets/' + ticketId, 'GET', undefined, false)).status !== 404) throw new Error("a teacher must not see another teacher's ticket");
if ((await call(other, '/api/support/tickets', 'GET', undefined, false)).status !== 403) throw new Error('a teacher must not access the support queue');
if ((await call(makeJar(), '/api/support/tickets', 'GET', undefined, false)).status !== 401) throw new Error('anonymous must not access the support queue');
ok('permissions enforced (own tickets only; support queue is support-only)');

console.log('\n✅ SUPPORT-TEST: ALL CHECKS PASSED\n');
