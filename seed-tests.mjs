// Seed 10 sample tests (10 multiple-choice questions each, 4 options) for a teacher.
//   node seed-tests.mjs [teacher-email]
import { pool } from './db.js';

const EMAIL = (process.argv[2] || 'swappyjob@gmail.com').trim().toLowerCase();
const teacher = (await pool.query("SELECT id, name FROM users WHERE email = $1 AND role = 'teacher'", [EMAIL])).rows[0];
if (!teacher) { console.log('No teacher found with email:', EMAIL); await pool.end(); process.exit(1); }

const rint = (n) => Math.floor(Math.random() * n);

// Build one arithmetic MCQ with a genuinely correct answer + 3 distractors.
function makeQuestion() {
  const ops = [['+', (a, b) => a + b], ['-', (a, b) => a - b], ['×', (a, b) => a * b]];
  const [sym, fn] = ops[rint(3)];
  let a = rint(12) + 1;
  let b = rint(12) + 1;
  if (sym === '-' && b > a) [a, b] = [b, a];
  const ans = fn(a, b);
  const opts = new Set([ans]);
  while (opts.size < 4) {
    const d = ans + (rint(9) - 4);
    if (d !== ans) opts.add(d);
  }
  const arr = [...opts];
  for (let i = arr.length - 1; i > 0; i--) { const j = rint(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return { prompt: `What is ${a} ${sym} ${b}?`, options: arr.map(String), correct: arr.indexOf(ans) };
}

for (let i = 1; i <= 10; i++) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const testId = (await client.query(
      'INSERT INTO tests (teacher_id, title, description) VALUES ($1, $2, $3) RETURNING id',
      [teacher.id, `Sample Test ${i}`, `Auto-generated sample test #${i} — 10 multiple-choice questions.`]
    )).rows[0].id;
    for (let n = 0; n < 10; n++) {
      const q = makeQuestion();
      await client.query(
        'INSERT INTO questions (test_id, type, prompt, options_json, correct_answer, points, position) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [testId, 'mcq', `Q${n + 1}. ${q.prompt}`, JSON.stringify(q.options), String(q.correct), 1, n]
      );
    }
    await client.query('COMMIT');
    console.log(`✓ Created "Sample Test ${i}" (id ${testId}) with 10 questions`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

console.log(`\nDone — 10 sample tests added for ${teacher.name} (${EMAIL}).`);
await pool.end();
