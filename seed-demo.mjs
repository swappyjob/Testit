// Seeds a polished, realistic demo organization so sales demos aren't an empty
// screen. Everything goes through the normal HTTP API (no direct DB writes), so
// it only ADDS one isolated org and cannot corrupt existing data.
//
//   node seed-demo.mjs                      # seeds http://localhost:3000
//   node seed-demo.mjs https://your-live-url
//
// Safe to point at production. If the demo teacher already exists it exits
// without changing anything (so you can't accidentally double-seed).
import zlib from 'node:zlib';

const BASE = (process.argv[2] || process.env.DEMO_BASE || 'http://localhost:3000').replace(/\/$/, '');

// ---- Demo identity (surfaced at the end so you can log in and present) ----
const ORG_TEACHER = { name: 'Dr. Anjali Verma', email: 'demo.teacher@brightfuture.in', password: 'demo1234' };
const STUDENT_PASSWORD = 'student123';

// ---------------------------------------------------------------------------
// Tiny cookie-jar HTTP client (same pattern as the test suite).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Generate a benzene-ring PNG (hexagon + inner aromatic circle) with zero
// dependencies, so the chemistry question shows a real drawn diagram.
// ---------------------------------------------------------------------------
function benzenePngDataUrl(size = 260) {
  const W = size, H = size;
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = 255; px[i * 4 + 1] = 255; px[i * 4 + 2] = 255; px[i * 4 + 3] = 255; }
  const dot = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = (Y * W + X) * 4; px[i] = 17; px[i + 1] = 24; px[i + 2] = 39; px[i + 3] = 255;
    }
  };
  const line = (x0, y0, x1, y1) => {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      dot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  };
  const cx = W / 2, cy = H / 2, r = W * 0.33;
  const pts = [];
  for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * (Math.PI / 3); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  for (let k = 0; k < 6; k++) { const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % 6]; line(x0, y0, x1, y1); }
  const ir = r * 0.55;
  for (let t = 0; t < 720; t++) { const a = (t / 720) * 2 * Math.PI; dot(Math.round(cx + ir * Math.cos(a)), Math.round(cy + ir * Math.sin(a))); }

  // Encode as an 8-bit RGBA PNG.
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) { raw[y * (1 + W * 4)] = 0; px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4); }
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
  const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([t, data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

// ---------------------------------------------------------------------------
// Demo content
// ---------------------------------------------------------------------------
const STUDENTS = [
  'Aarav Sharma', 'Diya Patel', 'Kabir Singh', 'Ananya Reddy', 'Rohan Gupta',
  'Ishita Nair', 'Vivaan Iyer', 'Sara Khan', 'Aditya Rao', 'Meera Joshi',
];
const emailFor = (name) => name.toLowerCase().replace(/[^a-z]+/g, '.') + '@student.brightfuture.in';

const log = (m) => console.log(m);

async function run() {
  log(`\nSeeding demo org at ${BASE} ...\n`);

  // 1) Root teacher + organization. Abort cleanly if already seeded.
  const teacher = makeJar();
  const reg = await call(teacher, '/api/register-teacher', 'POST', ORG_TEACHER, false);
  if (reg.status === 409) {
    log('⚠  A demo teacher with that email already exists — nothing was changed.');
    log(`   Log in at ${BASE}/teacher-login as ${ORG_TEACHER.email}`);
    log('   To re-seed, delete that organization first (or change the email at the top of this script).\n');
    process.exit(1);
  }
  if (reg.status !== 200) throw new Error('register failed: ' + JSON.stringify(reg.data));
  log(`✓ Created organization + root teacher (${ORG_TEACHER.name})`);

  // 2) Put the org on the Pro plan so it isn't capped (10 students > Free's 5).
  const plans = (await call(teacher, '/api/my-org/plan')).data.plans;
  const pro = plans.find((p) => p.name === 'Pro') || plans.find((p) => p.max_students == null) || plans[plans.length - 1];
  await call(teacher, '/api/my-org/plan', 'POST', { planId: pro.id });
  log(`✓ Subscribed the org to the ${pro.name} plan`);

  // 3) Upload the benzene-ring diagram.
  const { url: benzene } = (await call(teacher, '/api/upload', 'POST', { dataUrl: benzenePngDataUrl() })).data;
  log('✓ Uploaded a benzene-ring diagram');

  // 4) Main test — 3 sections, every question type, LaTeX throughout.
  const mainQuestions = [
    { section: 'Physics', type: 'mcq', points: 4,
      prompt: 'A particle starts from rest and accelerates uniformly. Its velocity is $v = u + at$. If $u = 0$, $a = 2\\,\\text{m/s}^2$ and $t = 5\\,\\text{s}$, find $v$.',
      options: ['$5\\,\\text{m/s}$', '$10\\,\\text{m/s}$', '$20\\,\\text{m/s}$', '$25\\,\\text{m/s}$'], correct: 1,
      explanation: '$v = 0 + 2 \\times 5 = 10\\,\\text{m/s}$.' },
    { section: 'Physics', type: 'truefalse', points: 2, correct: 'true',
      prompt: 'The kinetic energy of a body is given by $KE = \\tfrac{1}{2}mv^2$.',
      explanation: 'True — kinetic energy is $\\tfrac{1}{2}mv^2$.' },
    { section: 'Chemistry', type: 'mcq', points: 4, image: benzene,
      prompt: 'Identify the aromatic compound represented by the diagram.',
      options: ['Benzene ($C_6H_6$)', 'Cyclohexane ($C_6H_{12}$)', 'Hexene', 'Toluene'], correct: 0,
      explanation: 'The hexagonal ring with a delocalised electron cloud (the inner circle) is benzene, $C_6H_6$.' },
    { section: 'Chemistry', type: 'multi', points: 4, correct: [0, 2, 3],
      prompt: 'Which of the following are noble gases? (select all that apply)',
      options: ['Helium', 'Nitrogen', 'Argon', 'Neon'],
      explanation: 'Helium, Argon and Neon are noble gases; Nitrogen is not.' },
    { section: 'Chemistry', type: 'mcq', points: 3,
      prompt: 'Complete the reaction: $2H_2 + O_2 \\rightarrow \\;?$',
      options: ['$2H_2O$', '$H_2O$', '$H_2O_2$', '$2H_2O_2$'], correct: 0,
      explanation: 'Balancing gives $2H_2 + O_2 \\rightarrow 2H_2O$.' },
    { section: 'Mathematics', type: 'mcq', points: 4,
      prompt: 'Evaluate $\\int_{0}^{1} x^2\\,dx$.',
      options: ['$\\tfrac{1}{2}$', '$\\tfrac{1}{3}$', '$1$', '$\\tfrac{2}{3}$'], correct: 1,
      explanation: '$\\int_{0}^{1} x^2\\,dx = \\left[\\tfrac{x^3}{3}\\right]_0^1 = \\tfrac{1}{3}$.' },
    { section: 'Mathematics', type: 'mcq', points: 4,
      prompt: 'Solve $x^2 - 5x + 6 = 0$.',
      options: ['$x = 2,\\,3$', '$x = 1,\\,6$', '$x = -2,\\,-3$', '$x = 0,\\,5$'], correct: 0,
      explanation: '$x^2 - 5x + 6 = (x-2)(x-3) = 0 \\Rightarrow x = 2,\\,3$.' },
    { section: 'Mathematics', type: 'mcq', points: 2,
      prompt: 'The derivative of $\\sin(x)$ is:',
      options: ['$\\cos(x)$', '$-\\cos(x)$', '$\\sin(x)$', '$-\\sin(x)$'], correct: 0,
      explanation: '$\\tfrac{d}{dx}\\sin x = \\cos x$.' },
  ];
  const { id: mainId } = (await call(teacher, '/api/tests', 'POST', {
    title: 'NEET Mock Test 1 — Physics, Chemistry & Maths',
    description: 'Full-length practice test covering Physics, Chemistry and Mathematics. All the best!',
    durationMinutes: 30,
    questions: mainQuestions,
  })).data;
  log(`✓ Created "NEET Mock Test 1" (${mainQuestions.length} questions, 3 sections)`);

  // Answer keys: correct + a wrong alternative per question, keyed by order.
  const key = mainQuestions.map((q) => {
    if (q.type === 'mcq') return { correct: String(q.correct), wrong: String(q.correct === 0 ? 1 : 0) };
    if (q.type === 'truefalse') return { correct: q.correct, wrong: q.correct === 'true' ? 'false' : 'true' };
    if (q.type === 'multi') return { correct: JSON.stringify(q.correct), wrong: '[1]' };
    return { correct: '', wrong: '' };
  });
  // Which question indices each student gets wrong (drives a realistic spread + ties).
  const wrongByStudent = [
    [],            // Aarav  -> 27 (topper)
    [4],           // Diya   -> 24
    [1, 7],        // Kabir  -> 23
    [3],           // Ananya -> 23 (tie)
    [0, 4],        // Rohan  -> 20
    [3, 6],        // Ishita -> 19
    [0, 3, 4],     // Vivaan -> 16
    [1, 3, 6, 7],  // Sara   -> 15
    [0, 2, 4, 6],  // Aditya -> 12
    [0, 1, 3, 5, 7], // Meera -> 12 (tie)
  ];

  // 5) A lighter second test so "My Tests" isn't a single row.
  const rapidQuestions = [
    { section: 'Chemistry', type: 'mcq', points: 2, correct: 0,
      prompt: 'What is the pH of a neutral solution at $25^\\circ\\text{C}$?',
      options: ['$7$', '$0$', '$14$', '$1$'], explanation: 'A neutral solution has $\\text{pH} = 7$.' },
    { section: 'Chemistry', type: 'mcq', points: 2, correct: 1,
      prompt: 'The chemical formula of table salt is:',
      options: ['$KCl$', '$NaCl$', '$CaCl_2$', '$NaOH$'], explanation: 'Table salt is sodium chloride, $NaCl$.' },
    { section: 'Chemistry', type: 'mcq', points: 2, correct: 2,
      prompt: 'Which gas is released when a metal reacts with an acid?',
      options: ['Oxygen', 'Chlorine', 'Hydrogen', 'Nitrogen'], explanation: 'Metals displace hydrogen from acids.' },
  ];
  const { id: rapidId } = (await call(teacher, '/api/tests', 'POST', {
    title: 'Chemistry Rapid Quiz', description: 'Quick 3-question warm-up.', durationMinutes: 10,
    questions: rapidQuestions,
  })).data;
  log('✓ Created "Chemistry Rapid Quiz" (3 questions)');
  const rapidKey = rapidQuestions.map((q) => ({ correct: String(q.correct), wrong: String(q.correct === 0 ? 1 : 0) }));
  const rapidWrong = [[], [1], [0, 2], [2], []]; // first 5 students

  // 6) Enrol students, sign them up, assign + submit both tests.
  const studentUsers = [];
  for (let i = 0; i < STUDENTS.length; i++) {
    const name = STUDENTS[i];
    const { token } = (await call(teacher, '/api/students', 'POST',
      { name, email: emailFor(name), phone: '90000000' + String(i + 10) })).data;
    const sJar = makeJar();
    const { user } = (await call(sJar, '/api/signup/' + token, 'POST', { password: STUDENT_PASSWORD })).data;
    studentUsers.push({ name, jar: sJar, id: user.id });
  }
  log(`✓ Enrolled ${STUDENTS.length} students (signed up, password "${STUDENT_PASSWORD}")`);

  async function submitFor(stu, testId, kk, wrongSet) {
    await call(teacher, '/api/assignments', 'POST', { test_id: testId, student_ids: [stu.id] });
    const mine = (await call(stu.jar, '/api/my-assignments')).data.assignments;
    const aid = (mine.find((a) => a.testId === testId) || mine[0]).assignmentId;
    const take = await call(stu.jar, '/api/take/' + aid);
    const qs = take.data.questions;
    const answers = {};
    qs.forEach((q, qi) => { answers[q.id] = wrongSet.includes(qi) ? kk[qi].wrong : kk[qi].correct; });
    await call(stu.jar, '/api/submit/' + aid, 'POST', { answers });
  }

  for (let i = 0; i < studentUsers.length; i++) await submitFor(studentUsers[i], mainId, key, wrongByStudent[i]);
  log('✓ All 10 students submitted the NEET Mock Test (auto-graded → populated leaderboard)');
  for (let i = 0; i < 5; i++) await submitFor(studentUsers[i], rapidId, rapidKey, rapidWrong[i]);
  log('✓ 5 students submitted the Chemistry Rapid Quiz');

  // 7) Seed the shared Question Bank so that tab looks alive.
  const bank = [
    { type: 'mcq', topic: 'Physics', difficulty: 'Medium', points: 4,
      prompt: "Newton's second law is best expressed as:",
      options: ['$F = ma$', '$F = mv$', '$E = mc^2$', '$p = mv$'], correct: 0 },
    { type: 'mcq', topic: 'Mathematics', difficulty: 'Easy', points: 2,
      prompt: 'What is $\\tfrac{d}{dx}(x^2)$?',
      options: ['$2x$', '$x$', '$x^2$', '$2$'], correct: 0 },
    { type: 'truefalse', topic: 'Chemistry', difficulty: 'Easy', points: 2, correct: 'true',
      prompt: 'Water is a polar molecule.' },
    { type: 'multi', topic: 'Chemistry', difficulty: 'Hard', points: 4, correct: [0, 2],
      prompt: 'Which of these are diatomic gases at room temperature?',
      options: ['$O_2$', '$Ne$', '$N_2$', '$He$'] },
  ];
  try {
    for (const b of bank) await call(teacher, '/api/bank', 'POST', b);
    log(`✓ Added ${bank.length} questions to the shared Question Bank`);
  } catch { log('•  Skipped Question Bank (this deploy may not have that feature yet)'); }

  // 8) A second teacher, so the Teachers tab + audit log show multiple staff.
  try {
    await call(teacher, '/api/teachers', 'POST',
      { name: 'Mr. Rakesh Menon', email: 'rakesh.menon@brightfuture.in', phone: '9812345678', isRoot: false });
    log('✓ Invited a second teacher (Mr. Rakesh Menon)');
  } catch { log('•  Skipped second-teacher invite'); }

  log('\n────────────────────────────────────────────────────────');
  log('✅ Demo organization seeded successfully!');
  log('────────────────────────────────────────────────────────');
  log(`Site:     ${BASE}/teacher-login`);
  log(`Teacher:  ${ORG_TEACHER.email}   password: ${ORG_TEACHER.password}`);
  log(`Student:  ${emailFor(STUDENTS[0])}   password: ${STUDENT_PASSWORD}`);
  log('Tip: open the NEET Mock Test → Toppers to show the leaderboard,');
  log('     and the Audit Logs tab to show the activity trail.\n');
}

run().catch((e) => { console.error('\n❌ Seeding failed:', e.message, '\n'); process.exit(1); });
