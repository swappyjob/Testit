import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Larger limit so base64-encoded question images fit in the JSON body.
app.use(express.json({ limit: '8mb' }));

// Folder where uploaded question images are stored and served from.
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.disabled = 0`
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

const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, email: u.email, isRoot: !!u.is_root });

// Root teachers can manage other teachers.
function requireRoot(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.user.role !== 'teacher' || !req.user.is_root)
    return res.status(403).json({ error: 'Only root teachers can do that.' });
  next();
}

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

  // Bootstrap: while no root teacher exists yet, the next teacher to register
  // becomes the root teacher (who can then invite others).
  const rootExists = db.prepare("SELECT 1 FROM users WHERE role = 'teacher' AND is_root = 1 LIMIT 1").get();
  const isRoot = rootExists ? 0 : 1;
  const info = db.prepare(
    'INSERT INTO users (role, name, email, password_hash, is_root) VALUES (?, ?, ?, ?, ?)'
  ).run('teacher', name, email, hashPassword(password), isRoot);
  startSession(res, Number(info.lastInsertRowid));
  res.json({ user: { id: Number(info.lastInsertRowid), role: 'teacher', name, email, isRoot: !!isRoot } });
});

app.post('/api/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password.' });
  if (user.disabled)
    return res.status(403).json({ error: 'Your account has been disabled. Please contact your teacher.' });
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

// Change your own password (any logged-in user).
app.post('/api/change-password', requireAuth(), (req, res) => {
  const currentPassword = req.body.currentPassword || '';
  const newPassword = req.body.newPassword || '';
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(currentPassword, user.password_hash))
    return res.status(403).json({ error: 'Your current password is incorrect.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  // Log out everywhere else — keep only the current session valid.
  const sid = parseCookies(req).sid;
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, sid);
  res.json({ ok: true });
});

// ============================================================================
// STUDENTS + SIGNUP LINKS  (teacher creates students)
// ============================================================================
app.post('/api/students', requireAuth('teacher'), (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim();
  if (!name || !email) return res.status(400).json({ error: 'Student name and email are required.' });
  if (!phone) return res.status(400).json({ error: 'Student phone number is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone))
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'A user with that email already exists.' });
  const openToken = db.prepare('SELECT id FROM signup_tokens WHERE email = ? AND used = 0').get(email);
  if (openToken) return res.status(409).json({ error: 'A pending invite for that email already exists.' });

  const token = randomToken();
  db.prepare(
    'INSERT INTO signup_tokens (token, name, email, phone, teacher_id) VALUES (?, ?, ?, ?, ?)'
  ).run(token, name, email, phone, req.user.id);
  res.json({ token, signupPath: `/signup.html?token=${token}` });
});

// List this teacher's students + pending invites.
app.get('/api/students', requireAuth('teacher'), (req, res) => {
  const q = (req.query.q || '').trim();
  const base =
    `SELECT t.name, t.email, t.phone, t.token, t.used, t.student_id, u.disabled
       FROM signup_tokens t
       LEFT JOIN users u ON u.id = t.student_id
      WHERE t.teacher_id = ? AND t.invite_role = 'student'`;
  let invites;
  if (q) {
    // Escape LIKE wildcards so the user's text is matched literally.
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    invites = db.prepare(
      `${base} AND (t.name LIKE ? ESCAPE '\\' OR t.email LIKE ? ESCAPE '\\') ORDER BY t.created_at DESC`
    ).all(req.user.id, like, like);
  } else {
    invites = db.prepare(`${base} ORDER BY t.created_at DESC`).all(req.user.id);
  }
  const students = invites.map((i) => ({
    name: i.name,
    email: i.email,
    phone: i.phone,
    signedUp: !!i.used,
    studentId: i.student_id,
    disabled: !!i.disabled,
    signupPath: i.used ? null : `/signup.html?token=${i.token}`,
  }));
  res.json({ students });
});

// Download all of this teacher's students as a CSV file.
app.get('/api/students/export.csv', requireAuth('teacher'), (req, res) => {
  const rows = db.prepare(
    `SELECT t.name, t.email, t.phone, t.used, u.disabled, t.created_at
       FROM signup_tokens t
       LEFT JOIN users u ON u.id = t.student_id
      WHERE t.teacher_id = ? AND t.invite_role = 'student' ORDER BY t.created_at DESC`
  ).all(req.user.id);

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Name', 'Email', 'Mobile Number', 'Signup Status', 'Account Status', 'Added On'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const signup = r.used ? 'Signed up' : 'Invite pending';
    const account = !r.used ? '' : (r.disabled ? 'Disabled' : 'Active');
    lines.push([r.name, r.email, r.phone, signup, account, r.created_at].map(esc).join(','));
  }
  // Leading BOM so Excel opens UTF-8 (e.g. "+91…" / names) correctly.
  const csv = '﻿' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
  res.send(csv);
});

// Enable/disable a student. A disabled student cannot log in, and any active
// session is revoked immediately.
app.patch('/api/students/:id', requireAuth('teacher'), (req, res) => {
  const studentId = Number(req.params.id);
  // Only allow toggling students this teacher created.
  const owned = db.prepare(
    'SELECT 1 FROM signup_tokens WHERE teacher_id = ? AND student_id = ?'
  ).get(req.user.id, studentId);
  if (!owned) return res.status(404).json({ error: 'Student not found.' });
  const disabled = req.body.disabled ? 1 : 0;
  db.prepare("UPDATE users SET disabled = ? WHERE id = ? AND role = 'student'").run(disabled, studentId);
  if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(studentId); // log them out now
  res.json({ ok: true, disabled: !!disabled });
});

// ============================================================================
// TEACHERS  (root teachers can invite other teachers)
// ============================================================================
app.post('/api/teachers', requireRoot, (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim();
  const makeRoot = req.body.isRoot ? 1 : 0;
  if (!name || !email) return res.status(400).json({ error: 'Teacher name and email are required.' });
  if (!phone) return res.status(400).json({ error: 'Teacher phone number is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone))
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'A user with that email already exists.' });
  if (db.prepare('SELECT id FROM signup_tokens WHERE email = ? AND used = 0').get(email))
    return res.status(409).json({ error: 'A pending invite for that email already exists.' });

  const token = randomToken();
  db.prepare(
    "INSERT INTO signup_tokens (token, name, email, phone, invite_role, is_root, teacher_id) VALUES (?, ?, ?, ?, 'teacher', ?, ?)"
  ).run(token, name, email, phone, makeRoot, req.user.id);
  res.json({ token, signupPath: `/signup.html?token=${token}` });
});

// List all teachers plus pending teacher invites (root view).
app.get('/api/teachers', requireRoot, (req, res) => {
  const signedUp = db.prepare(
    "SELECT id, name, email, phone, is_root, disabled FROM users WHERE role = 'teacher' ORDER BY id"
  ).all();
  const pending = db.prepare(
    "SELECT name, email, phone, is_root, token FROM signup_tokens WHERE invite_role = 'teacher' AND used = 0 ORDER BY created_at DESC"
  ).all();
  const teachers = [
    ...signedUp.map((u) => ({
      name: u.name, email: u.email, phone: u.phone, isRoot: !!u.is_root, disabled: !!u.disabled,
      signedUp: true, isSelf: u.id === req.user.id, signupPath: null,
    })),
    ...pending.map((p) => ({
      name: p.name, email: p.email, phone: p.phone, isRoot: !!p.is_root, disabled: false,
      signedUp: false, isSelf: false, signupPath: `/signup.html?token=${p.token}`,
    })),
  ];
  res.json({ teachers });
});

// Validate a signup token (used by the signup page to pre-fill name/email).
app.get('/api/signup/:token', (req, res) => {
  const t = db.prepare('SELECT * FROM signup_tokens WHERE token = ?').get(req.params.token);
  if (!t) return res.status(404).json({ error: 'This signup link is invalid.' });
  if (t.used) return res.status(410).json({ error: 'This signup link has already been used.' });
  res.json({ name: t.name, email: t.email, role: t.invite_role, isRoot: !!t.is_root });
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

  const role = t.invite_role === 'teacher' ? 'teacher' : 'student';
  const isRoot = role === 'teacher' && t.is_root ? 1 : 0;
  const info = db.prepare(
    'INSERT INTO users (role, name, email, phone, password_hash, is_root) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(role, t.name, t.email, t.phone, hashPassword(password), isRoot);
  const newId = Number(info.lastInsertRowid);
  db.prepare('UPDATE signup_tokens SET used = 1, student_id = ? WHERE id = ?').run(newId, t.id);
  startSession(res, newId);
  res.json({ user: { id: newId, role, name: t.name, email: t.email, isRoot: !!isRoot } });
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
// Only accept image URLs we produced (paths under /uploads/), never arbitrary URLs.
function safeImageUrl(url) {
  return typeof url === 'string' && /^\/uploads\/[\w.-]+$/.test(url) ? url : '';
}

function writeQuestions(testId, questions) {
  const insertQ = db.prepare(
    `INSERT INTO questions (test_id, type, prompt, options_json, correct_answer, image_url, points, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
    insertQ.run(testId, q.type, q.prompt.trim(), options, correct, safeImageUrl(q.image), points, idx);
  });
}

// Accepts a base64 data URL, saves it as an image file, returns its public URL.
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
app.post('/api/upload', requireAuth('teacher'), (req, res) => {
  const dataUrl = req.body.dataUrl || '';
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Invalid image data.' });
  const ext = IMAGE_EXT[m[1].toLowerCase()];
  if (!ext) return res.status(400).json({ error: 'Only PNG, JPG, GIF, or WebP images are allowed.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image must be 5 MB or smaller.' });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.json({ url: '/uploads/' + name });
});

// A test is closed once its deadline (if any) is in the past.
function isClosed(dueDate) {
  if (!dueDate) return false;
  const t = new Date(dueDate).getTime();
  return Number.isFinite(t) && t < Date.now();
}

// Keep only a valid datetime-local string (YYYY-MM-DDTHH:MM), else ''.
function readDueDate(body) {
  const d = (body.dueDate || '').trim();
  if (!d) return '';
  return Number.isFinite(new Date(d).getTime()) ? d : '';
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
  const dueDate = readDueDate(req.body);

  const testId = transaction(() => {
    const newId = Number(db.prepare(
      'INSERT INTO tests (teacher_id, title, description, negative_marking, penalty, due_date) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, title, description, negative_marking, penalty, dueDate).lastInsertRowid);
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
  const dueDate = readDueDate(req.body);

  const keptAttempts = transaction(() => {
    // Preserve students' past attempts. Any current question that a student has
    // already answered is ARCHIVED (kept so old results still show the exact
    // questions/scores). Current questions with no answers can be safely removed.
    const current = db.prepare('SELECT id FROM questions WHERE test_id = ? AND archived = 0').all(test.id);
    const hasAnswers = db.prepare('SELECT 1 FROM answers WHERE question_id = ? LIMIT 1');
    const archive = db.prepare('UPDATE questions SET archived = 1 WHERE id = ?');
    const remove = db.prepare('DELETE FROM questions WHERE id = ?');
    for (const q of current) {
      if (hasAnswers.get(q.id)) archive.run(q.id);
      else remove.run(q.id);
    }
    db.prepare('UPDATE tests SET title = ?, description = ?, negative_marking = ?, penalty = ?, due_date = ? WHERE id = ?')
      .run(title, description, negative_marking, penalty, dueDate, test.id);
    writeQuestions(test.id, questions); // inserts the new version as active (archived = 0)
    return db.prepare('SELECT COUNT(*) AS c FROM attempts WHERE test_id = ? AND submitted_at IS NOT NULL').get(test.id).c;
  });
  res.json({ id: test.id, keptAttempts });
});

app.get('/api/tests', requireAuth('teacher'), (req, res) => {
  const tests = db.prepare(
    `SELECT t.id, t.title, t.description, t.negative_marking, t.penalty, t.due_date, t.created_at,
            (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id AND q.archived = 0) AS question_count,
            (SELECT COUNT(*) FROM assignments a WHERE a.test_id = t.id) AS assigned_count,
            (SELECT COUNT(*) FROM attempts at WHERE at.test_id = t.id AND at.submitted_at IS NOT NULL) AS submitted_count
       FROM tests t WHERE t.teacher_id = ? ORDER BY t.created_at DESC`
  ).all(req.user.id);
  tests.forEach((t) => { t.closed = isClosed(t.due_date); });
  res.json({ tests });
});

app.get('/api/tests/:id', requireAuth('teacher'), (req, res) => {
  const test = db.prepare('SELECT * FROM tests WHERE id = ? AND teacher_id = ?').get(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const questions = db.prepare('SELECT * FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position').all(test.id)
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
    `SELECT a.id AS assignment_id, t.id AS test_id, t.title, t.description, t.due_date,
            (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id AND q.archived = 0) AS question_count,
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
    dueDate: r.due_date,
    closed: isClosed(r.due_date),
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

  const test = db.prepare('SELECT id, title, description, negative_marking, penalty, due_date FROM tests WHERE id = ?').get(a.test_id);
  if (isClosed(test.due_date))
    return res.status(403).json({ error: 'The deadline for this test has passed. You can no longer take it.' });
  const questions = db.prepare('SELECT id, type, prompt, options_json, image_url, points FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position')
    .all(a.test_id)
    .map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, points: q.points, image: q.image_url, options: JSON.parse(q.options_json) }));
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

  const test = db.prepare('SELECT negative_marking, penalty, due_date FROM tests WHERE id = ?').get(a.test_id);
  if (isClosed(test.due_date))
    return res.status(403).json({ error: 'The deadline for this test has passed. Your submission was not accepted.' });
  const questions = db.prepare('SELECT * FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position').all(a.test_id);
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
            q.id AS question_id, q.type, q.prompt, q.options_json, q.correct_answer, q.image_url, q.points
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
    image: r.image_url,
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
