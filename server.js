import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- Password helpers (scrypt, built into Node — no dependency) --------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  // timing-safe compare
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const randomToken = () => crypto.randomBytes(24).toString('hex');

// node:sqlite has no .transaction() helper (unlike better-sqlite3), so wrap manually.
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- Cookie / session helpers ------------------------------------------------
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

// Attach req.user (or null) based on the session cookie.
app.use((req, res, next) => {
  const sid = parseCookies(req).sid;
  req.user = null;
  if (sid) {
    const row = db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    ).get(sid);
    if (row) req.user = row;
  }
  next();
});

function requireAuth(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in.' });
    if (role && req.user.role !== role)
      return res.status(403).json({ error: `Only ${role}s can do that.` });
    next();
  };
}

function startSession(res, userId) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 });
}

const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, email: u.email });

// ============================================================================
// AUTH
// ============================================================================
app.post('/api/register-teacher', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are all required.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'An account with that email already exists.' });

  const info = db.prepare(
    'INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)'
  ).run('teacher', name, email, hashPassword(password));
  startSession(res, Number(info.lastInsertRowid));
  res.json({ user: { id: Number(info.lastInsertRowid), role: 'teacher', name, email } });
});

app.post('/api/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password.' });
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

// ============================================================================
// STUDENTS + SIGNUP LINKS  (teacher creates students)
// ============================================================================
app.post('/api/students', requireAuth('teacher'), (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  if (!name || !email) return res.status(400).json({ error: 'Student name and email are required.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'A user with that email already exists.' });
  const openToken = db.prepare('SELECT id FROM signup_tokens WHERE email = ? AND used = 0').get(email);
  if (openToken) return res.status(409).json({ error: 'A pending invite for that email already exists.' });

  const token = randomToken();
  db.prepare(
    'INSERT INTO signup_tokens (token, name, email, teacher_id) VALUES (?, ?, ?, ?)'
  ).run(token, name, email, req.user.id);
  res.json({ token, signupPath: `/signup.html?token=${token}` });
});

// List this teacher's students + pending invites.
app.get('/api/students', requireAuth('teacher'), (req, res) => {
  const invites = db.prepare(
    `SELECT t.name, t.email, t.token, t.used, t.student_id
       FROM signup_tokens t WHERE t.teacher_id = ? ORDER BY t.created_at DESC`
  ).all(req.user.id);
  const students = invites.map((i) => ({
    name: i.name,
    email: i.email,
    signedUp: !!i.used,
    studentId: i.student_id,
    signupPath: i.used ? null : `/signup.html?token=${i.token}`,
  }));
  res.json({ students });
});

// Validate a signup token (used by the signup page to pre-fill name/email).
app.get('/api/signup/:token', (req, res) => {
  const t = db.prepare('SELECT * FROM signup_tokens WHERE token = ?').get(req.params.token);
  if (!t) return res.status(404).json({ error: 'This signup link is invalid.' });
  if (t.used) return res.status(410).json({ error: 'This signup link has already been used.' });
  res.json({ name: t.name, email: t.email });
});

// Complete signup: student sets a password.
app.post('/api/signup/:token', (req, res) => {
  const t = db.prepare('SELECT * FROM signup_tokens WHERE token = ?').get(req.params.token);
  if (!t) return res.status(404).json({ error: 'This signup link is invalid.' });
  if (t.used) return res.status(410).json({ error: 'This signup link has already been used.' });
  const password = req.body.password || '';
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(t.email))
    return res.status(409).json({ error: 'An account with that email already exists.' });

  const info = db.prepare(
    'INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)'
  ).run('student', t.name, t.email, hashPassword(password));
  const studentId = Number(info.lastInsertRowid);
  db.prepare('UPDATE signup_tokens SET used = 1, student_id = ? WHERE id = ?').run(studentId, t.id);
  startSession(res, studentId);
  res.json({ user: { id: studentId, role: 'student', name: t.name, email: t.email } });
});

// ============================================================================
// TESTS  (teacher creates + manages)
// ============================================================================
// Returns an error string if the questions are invalid, otherwise null.
function validateQuestions(questions) {
  if (questions.length === 0) return 'Add at least one question.';
  for (const [i, q] of questions.entries()) {
    if (!q.prompt || !q.prompt.trim()) return `Question ${i + 1} is missing its text.`;
    if (!['mcq', 'truefalse', 'short'].includes(q.type)) return `Question ${i + 1} has an invalid type.`;
    if (q.type === 'mcq') {
      const opts = Array.isArray(q.options) ? q.options.filter((o) => o.trim() !== '') : [];
      if (opts.length < 2) return `Question ${i + 1} needs at least two choices.`;
      const ci = Number(q.correct);
      if (!Number.isInteger(ci) || ci < 0 || ci >= opts.length)
        return `Question ${i + 1} needs a correct choice selected.`;
    }
    if (q.type === 'truefalse' && !['true', 'false'].includes(String(q.correct)))
      return `Question ${i + 1} needs a correct answer (True/False).`;
  }
  return null;
}

// Insert the given questions for a test (assumes the test has no questions yet).
function writeQuestions(testId, questions) {
  const insertQ = db.prepare(
    `INSERT INTO questions (test_id, type, prompt, options_json, correct_answer, points, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  questions.forEach((q, idx) => {
    let options = '[]';
    let correct = '';
    if (q.type === 'mcq') {
      options = JSON.stringify(q.options.filter((o) => o.trim() !== ''));
      correct = String(q.correct);
    } else if (q.type === 'truefalse') {
      correct = String(q.correct);
    }
    const points = Number(q.points) > 0 ? Number(q.points) : 1;
    insertQ.run(testId, q.type, q.prompt.trim(), options, correct, points, idx);
  });
}

// Normalize the negative-marking settings from a request body.
function readMarking(body) {
  const on = body.negativeMarking ? 1 : 0;
  let penalty = Math.round(Number(body.penalty));
  if (!Number.isFinite(penalty) || penalty < 1) penalty = 1;
  return { negative_marking: on, penalty: on ? penalty : 0 };
}

app.post('/api/tests', requireAuth('teacher'), (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!title) return res.status(400).json({ error: 'Test title is required.' });
  const invalid = validateQuestions(questions);
  if (invalid) return res.status(400).json({ error: invalid });
  const { negative_marking, penalty } = readMarking(req.body);

  const testId = transaction(() => {
    const newId = Number(db.prepare(
      'INSERT INTO tests (teacher_id, title, description, negative_marking, penalty) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, title, description, negative_marking, penalty).lastInsertRowid);
    writeQuestions(newId, questions);
    return newId;
  });
  res.json({ id: testId });
});

// Update an existing test. Replaces its questions, so any existing student
// submissions for this test are cleared (their old answers no longer apply).
app.put('/api/tests/:id', requireAuth('teacher'), (req, res) => {
  const test = db.prepare('SELECT * FROM tests WHERE id = ? AND teacher_id = ?').get(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!title) return res.status(400).json({ error: 'Test title is required.' });
  const invalid = validateQuestions(questions);
  if (invalid) return res.status(400).json({ error: invalid });
  const { negative_marking, penalty } = readMarking(req.body);

  const clearedAttempts = transaction(() => {
    // Removing attempts also cascade-deletes their answers; assignments are kept.
    const cleared = db.prepare('DELETE FROM attempts WHERE test_id = ?').run(test.id).changes;
    db.prepare('DELETE FROM questions WHERE test_id = ?').run(test.id);
    db.prepare('UPDATE tests SET title = ?, description = ?, negative_marking = ?, penalty = ? WHERE id = ?')
      .run(title, description, negative_marking, penalty, test.id);
    writeQuestions(test.id, questions);
    return cleared;
  });
  res.json({ id: test.id, clearedAttempts });
});

app.get('/api/tests', requireAuth('teacher'), (req, res) => {
  const tests = db.prepare(
    `SELECT t.id, t.title, t.description, t.negative_marking, t.penalty, t.created_at,
            (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id) AS question_count,
            (SELECT COUNT(*) FROM assignments a WHERE a.test_id = t.id) AS assigned_count,
            (SELECT COUNT(*) FROM attempts at WHERE at.test_id = t.id AND at.submitted_at IS NOT NULL) AS submitted_count
       FROM tests t WHERE t.teacher_id = ? ORDER BY t.created_at DESC`
  ).all(req.user.id);
  res.json({ tests });
});

app.get('/api/tests/:id', requireAuth('teacher'), (req, res) => {
  const test = db.prepare('SELECT * FROM tests WHERE id = ? AND teacher_id = ?').get(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const questions = db.prepare('SELECT * FROM questions WHERE test_id = ? ORDER BY position').all(test.id)
    .map((q) => ({ ...q, options: JSON.parse(q.options_json) }));
  res.json({ test, questions });
});

app.delete('/api/tests/:id', requireAuth('teacher'), (req, res) => {
  const test = db.prepare('SELECT * FROM tests WHERE id = ? AND teacher_id = ?').get(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  db.prepare('DELETE FROM tests WHERE id = ?').run(test.id);
  res.json({ ok: true });
});

// ============================================================================
// ASSIGNMENTS  (teacher assigns a test to students)
// ============================================================================
app.post('/api/assignments', requireAuth('teacher'), (req, res) => {
  const testId = Number(req.body.test_id);
  const studentIds = Array.isArray(req.body.student_ids) ? req.body.student_ids.map(Number) : [];
  const test = db.prepare('SELECT * FROM tests WHERE id = ? AND teacher_id = ?').get(testId, req.user.id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  if (studentIds.length === 0) return res.status(400).json({ error: 'Select at least one student.' });

  const insert = db.prepare(
    `INSERT OR IGNORE INTO assignments (test_id, student_id, teacher_id) VALUES (?, ?, ?)`
  );
  let added = 0;
  transaction(() => {
    for (const sid of studentIds) {
      const student = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(sid);
      if (student) added += insert.run(testId, sid, req.user.id).changes;
    }
  });
  res.json({ assigned: added });
});

// Who is already assigned to a given test (teacher view).
app.get('/api/tests/:id/assignments', requireAuth('teacher'), (req, res) => {
  const rows = db.prepare(
    `SELECT a.student_id, u.name, u.email,
            EXISTS(SELECT 1 FROM attempts at WHERE at.assignment_id = a.id AND at.submitted_at IS NOT NULL) AS submitted
       FROM assignments a JOIN users u ON u.id = a.student_id
      WHERE a.test_id = ?`
  ).all(req.params.id);
  res.json({ assigned: rows });
});

// ============================================================================
// STUDENT: my assigned tests + taking them
// ============================================================================
app.get('/api/my-assignments', requireAuth('student'), (req, res) => {
  const rows = db.prepare(
    `SELECT a.id AS assignment_id, t.id AS test_id, t.title, t.description,
            (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id) AS question_count,
            at.id AS attempt_id, at.submitted_at, at.auto_score, at.manual_score,
            at.max_score, at.needs_grading
       FROM assignments a
       JOIN tests t ON t.id = a.test_id
       LEFT JOIN attempts at ON at.assignment_id = a.id
      WHERE a.student_id = ?
      ORDER BY a.created_at DESC`
  ).all(req.user.id);
  const assignments = rows.map((r) => ({
    assignmentId: r.assignment_id,
    testId: r.test_id,
    title: r.title,
    description: r.description,
    questionCount: r.question_count,
    submitted: !!r.submitted_at,
    needsGrading: !!r.needs_grading,
    score: r.submitted_at ? r.auto_score + r.manual_score : null,
    maxScore: r.max_score,
  }));
  res.json({ assignments });
});

// Fetch a test to take — WITHOUT correct answers.
app.get('/api/take/:assignmentId', requireAuth('student'), (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND student_id = ?')
    .get(req.params.assignmentId, req.user.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  const existing = db.prepare('SELECT * FROM attempts WHERE assignment_id = ?').get(a.id);
  if (existing && existing.submitted_at)
    return res.status(409).json({ error: 'You have already submitted this test.' });

  const test = db.prepare('SELECT id, title, description, negative_marking, penalty FROM tests WHERE id = ?').get(a.test_id);
  const questions = db.prepare('SELECT id, type, prompt, options_json, points FROM questions WHERE test_id = ? ORDER BY position')
    .all(a.test_id)
    .map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, points: q.points, options: JSON.parse(q.options_json) }));
  res.json({ test, questions });
});

// Submit answers — auto-grade mcq/truefalse, flag short answers for the teacher.
app.post('/api/submit/:assignmentId', requireAuth('student'), (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND student_id = ?')
    .get(req.params.assignmentId, req.user.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  const existing = db.prepare('SELECT * FROM attempts WHERE assignment_id = ?').get(a.id);
  if (existing && existing.submitted_at)
    return res.status(409).json({ error: 'You have already submitted this test.' });

  const test = db.prepare('SELECT negative_marking, penalty FROM tests WHERE id = ?').get(a.test_id);
  const questions = db.prepare('SELECT * FROM questions WHERE test_id = ? ORDER BY position').all(a.test_id);
  const responses = req.body.answers || {}; // { questionId: response }

  let autoScore = 0;
  let maxScore = 0;
  let needsGrading = 0;
  const graded = [];
  for (const q of questions) {
    maxScore += q.points;
    const resp = responses[q.id] != null ? String(responses[q.id]) : '';
    let isCorrect = null;
    let awarded = 0;
    if (q.type === 'mcq' || q.type === 'truefalse') {
      const answered = resp !== '';
      isCorrect = answered && resp === q.correct_answer ? 1 : 0;
      if (isCorrect) awarded = q.points;
      // Deduct marks only for a WRONG (not blank) answer when negative marking is on.
      else if (answered && test.negative_marking) awarded = -test.penalty;
      autoScore += awarded;
    } else {
      needsGrading = 1; // short answer — teacher grades later
    }
    graded.push({ questionId: q.id, response: resp, isCorrect, awarded });
  }

  transaction(() => {
    const attemptId = Number(db.prepare(
      `INSERT INTO attempts (assignment_id, test_id, student_id, submitted_at, auto_score, manual_score, max_score, needs_grading)
       VALUES (?, ?, ?, datetime('now'), ?, 0, ?, ?)`
    ).run(a.id, a.test_id, req.user.id, autoScore, maxScore, needsGrading).lastInsertRowid);
    const insA = db.prepare(
      'INSERT INTO answers (attempt_id, question_id, response, is_correct, points_awarded) VALUES (?, ?, ?, ?, ?)'
    );
    for (const g of graded) insA.run(attemptId, g.questionId, g.response, g.isCorrect, g.awarded);
  });
  res.json({ autoScore, maxScore, needsGrading: !!needsGrading });
});

// ============================================================================
// RESULTS + GRADING  (teacher)
// ============================================================================
app.get('/api/tests/:id/results', requireAuth('teacher'), (req, res) => {
  const test = db.prepare('SELECT * FROM tests WHERE id = ? AND teacher_id = ?').get(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const rows = db.prepare(
    `SELECT at.id AS attempt_id, u.name, u.email, at.submitted_at,
            at.auto_score, at.manual_score, at.max_score, at.needs_grading
       FROM attempts at JOIN users u ON u.id = at.student_id
      WHERE at.test_id = ? AND at.submitted_at IS NOT NULL
      ORDER BY at.submitted_at DESC`
  ).all(test.id);
  res.json({
    results: rows.map((r) => ({
      attemptId: r.attempt_id,
      name: r.name,
      email: r.email,
      submittedAt: r.submitted_at,
      score: r.auto_score + r.manual_score,
      maxScore: r.max_score,
      needsGrading: !!r.needs_grading,
    })),
  });
});

// Full detail of one attempt (for grading / review).
app.get('/api/attempts/:attemptId', requireAuth('teacher'), (req, res) => {
  const attempt = db.prepare(
    `SELECT at.*, u.name, u.email FROM attempts at
       JOIN users u ON u.id = at.student_id
       JOIN tests t ON t.id = at.test_id
      WHERE at.id = ? AND t.teacher_id = ?`
  ).get(req.params.attemptId, req.user.id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
  const items = db.prepare(
    `SELECT ans.id AS answer_id, ans.response, ans.is_correct, ans.points_awarded,
            q.id AS question_id, q.type, q.prompt, q.options_json, q.correct_answer, q.points
       FROM answers ans JOIN questions q ON q.id = ans.question_id
      WHERE ans.attempt_id = ? ORDER BY q.position`
  ).all(attempt.id).map((r) => ({
    answerId: r.answer_id,
    response: r.response,
    isCorrect: r.is_correct,
    pointsAwarded: r.points_awarded,
    questionId: r.question_id,
    type: r.type,
    prompt: r.prompt,
    options: JSON.parse(r.options_json),
    correctAnswer: r.correct_answer,
    points: r.points,
  }));
  res.json({
    attempt: {
      id: attempt.id,
      name: attempt.name,
      email: attempt.email,
      submittedAt: attempt.submitted_at,
      autoScore: attempt.auto_score,
      manualScore: attempt.manual_score,
      maxScore: attempt.max_score,
      needsGrading: !!attempt.needs_grading,
    },
    items,
  });
});

// Teacher grades short answers: { grades: { answerId: points } }
app.post('/api/attempts/:attemptId/grade', requireAuth('teacher'), (req, res) => {
  const attempt = db.prepare(
    `SELECT at.* FROM attempts at JOIN tests t ON t.id = at.test_id
      WHERE at.id = ? AND t.teacher_id = ?`
  ).get(req.params.attemptId, req.user.id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
  const grades = req.body.grades || {};

  transaction(() => {
    for (const [answerId, pts] of Object.entries(grades)) {
      const ans = db.prepare(
        `SELECT ans.*, q.points AS max_points, q.type FROM answers ans
           JOIN questions q ON q.id = ans.question_id
          WHERE ans.id = ? AND ans.attempt_id = ?`
      ).get(Number(answerId), attempt.id);
      if (!ans || ans.type !== 'short') continue;
      let p = Number(pts);
      if (!Number.isFinite(p) || p < 0) p = 0;
      if (p > ans.max_points) p = ans.max_points;
      db.prepare('UPDATE answers SET points_awarded = ?, is_correct = ? WHERE id = ?')
        .run(p, p > 0 ? 1 : 0, ans.id);
    }
    const manual = db.prepare(
      `SELECT COALESCE(SUM(ans.points_awarded), 0) AS s FROM answers ans
         JOIN questions q ON q.id = ans.question_id
        WHERE ans.attempt_id = ? AND q.type = 'short'`
    ).get(attempt.id).s;
    const ungraded = db.prepare(
      `SELECT COUNT(*) AS c FROM answers ans JOIN questions q ON q.id = ans.question_id
        WHERE ans.attempt_id = ? AND q.type = 'short' AND ans.is_correct IS NULL`
    ).get(attempt.id).c;
    db.prepare('UPDATE attempts SET manual_score = ?, needs_grading = ? WHERE id = ?')
      .run(manual, ungraded > 0 ? 1 : 0, attempt.id);
  });
  res.json({ ok: true });
});

// --- Static files ------------------------------------------------------------
// no-cache so the browser always revalidates and never shows a stale page.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.listen(PORT, () => {
  console.log(`\n  Online Test Platform running at:  http://localhost:${PORT}\n`);
});
