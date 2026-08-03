import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { get, all, run, tx, init } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Larger limit so base64-encoded question images fit in the JSON body.
app.use(express.json({ limit: '8mb' }));

// Folder where uploaded question images are stored and served from.
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Wrap an async route handler so rejected promises become Express errors.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Password helpers (scrypt, built into Node — no dependency) --------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const randomToken = () => crypto.randomBytes(24).toString('hex');

// --- Password-reset helpers --------------------------------------------------
// Email is optional: if SMTP isn't configured, we log the link to the console
// so resets still work in local/dev setups (and admin-generated links always work).
const mailer = (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE) === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function createResetToken(userId) {
  const token = randomToken();
  await run(
    "INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL '1 hour')",
    [token, userId]
  );
  return token;
}

function resetLink(req, token) {
  return `${req.protocol}://${req.get('host')}/reset.html?token=${token}`;
}

async function sendResetEmail(to, link) {
  if (!mailer) {
    console.log(`\n[password reset] SMTP not configured. Reset link for ${to}:\n  ${link}\n`);
    return;
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Reset your Online Test Platform password',
    text: `We received a request to reset your password.\n\nOpen this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>We received a request to reset your password.</p>
           <p><a href="${link}">Click here to choose a new password</a> (valid for 1 hour).</p>
           <p>If you didn't request this, you can ignore this email.</p>`,
  });
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
app.use(h(async (req, res, next) => {
  req.user = null;
  const sid = parseCookies(req).sid;
  if (sid) {
    const row = await get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.disabled = 0`,
      [sid]
    );
    if (row) req.user = row;
  }
  next();
}));

function requireAuth(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in.' });
    if (role && req.user.role !== role)
      return res.status(403).json({ error: `Only ${role}s can do that.` });
    next();
  };
}

// Root teachers can manage other teachers.
function requireRoot(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.user.role !== 'teacher' || !req.user.is_root)
    return res.status(403).json({ error: 'Only root teachers can do that.' });
  next();
}

async function startSession(res, userId) {
  const token = randomToken();
  await run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [token, userId]);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 });
}

const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, email: u.email, isRoot: !!u.is_root });

// ============================================================================
// AUTH
// ============================================================================
app.post('/api/register-teacher', h(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are all required.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await get('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(409).json({ error: 'An account with that email already exists.' });

  // Bootstrap: while no root teacher exists yet, the next teacher to register
  // becomes the root teacher (who can then invite others).
  const rootExists = await get("SELECT 1 FROM users WHERE role = 'teacher' AND is_root = 1 LIMIT 1");
  const isRoot = rootExists ? 0 : 1;
  const newId = (await run(
    'INSERT INTO users (role, name, email, password_hash, is_root) VALUES (?, ?, ?, ?, ?) RETURNING id',
    ['teacher', name, email, hashPassword(password), isRoot]
  )).rows[0].id;
  await startSession(res, newId);
  res.json({ user: { id: newId, role: 'teacher', name, email, isRoot: !!isRoot } });
}));

app.post('/api/login', h(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = await get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password.' });
  if (user.disabled)
    return res.status(403).json({ error: 'Your account has been disabled. Please contact your teacher.' });
  await startSession(res, user.id);
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', h(async (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) await run('DELETE FROM sessions WHERE token = ?', [sid]);
  res.clearCookie('sid');
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

// Change your own password (any logged-in user).
app.post('/api/change-password', requireAuth(), h(async (req, res) => {
  const currentPassword = req.body.currentPassword || '';
  const newPassword = req.body.newPassword || '';
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(currentPassword, user.password_hash))
    return res.status(403).json({ error: 'Your current password is incorrect.' });
  await run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), req.user.id]);
  // Log out everywhere else — keep only the current session valid.
  const sid = parseCookies(req).sid;
  await run('DELETE FROM sessions WHERE user_id = ? AND token != ?', [req.user.id, sid]);
  res.json({ ok: true });
}));

// Self-service: request a password reset link by email.
app.post('/api/forgot-password', h(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const user = email ? await get('SELECT id, disabled FROM users WHERE email = ?', [email]) : null;
  if (user && !user.disabled) {
    const token = await createResetToken(user.id);
    await sendResetEmail(email, resetLink(req, token));
  }
  // Always generic, so we don't reveal which emails exist.
  res.json({ ok: true });
}));

// Validate a reset token (used by the reset page).
app.get('/api/reset/:token', h(async (req, res) => {
  const r = await get(
    `SELECT pr.used, pr.expires_at, u.email, u.role
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token = ?`,
    [req.params.token]
  );
  if (!r) return res.status(404).json({ error: 'This reset link is invalid.' });
  if (r.used) return res.status(410).json({ error: 'This reset link has already been used.' });
  if (new Date(r.expires_at) < new Date()) return res.status(410).json({ error: 'This reset link has expired.' });
  res.json({ email: r.email, role: r.role });
}));

// Complete a reset: set a new password.
app.post('/api/reset/:token', h(async (req, res) => {
  const password = req.body.password || '';
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const r = await get('SELECT * FROM password_resets WHERE token = ?', [req.params.token]);
  if (!r) return res.status(404).json({ error: 'This reset link is invalid.' });
  if (r.used) return res.status(410).json({ error: 'This reset link has already been used.' });
  if (new Date(r.expires_at) < new Date()) return res.status(410).json({ error: 'This reset link has expired.' });
  const user = await get('SELECT role FROM users WHERE id = ?', [r.user_id]);

  await tx(async (t) => {
    await t.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), r.user_id]);
    await t.run('UPDATE password_resets SET used = 1 WHERE token = ?', [req.params.token]);
    // Invalidate any other outstanding reset links and log the user out everywhere.
    await t.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [r.user_id]);
    await t.run('DELETE FROM sessions WHERE user_id = ?', [r.user_id]);
  });
  res.json({ ok: true, role: user.role });
}));

// ============================================================================
// STUDENTS + SIGNUP LINKS  (teacher creates students)
// ============================================================================
app.post('/api/students', requireAuth('teacher'), h(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim();
  if (!name || !email) return res.status(400).json({ error: 'Student name and email are required.' });
  if (!phone) return res.status(400).json({ error: 'Student phone number is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone))
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (await get('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(409).json({ error: 'A user with that email already exists.' });
  if (await get('SELECT id FROM signup_tokens WHERE email = ? AND used = 0', [email]))
    return res.status(409).json({ error: 'A pending invite for that email already exists.' });

  const token = randomToken();
  await run(
    'INSERT INTO signup_tokens (token, name, email, phone, teacher_id) VALUES (?, ?, ?, ?, ?)',
    [token, name, email, phone, req.user.id]
  );
  res.json({ token, signupPath: `/signup.html?token=${token}` });
}));

// List this teacher's students + pending invites.
app.get('/api/students', requireAuth('teacher'), h(async (req, res) => {
  const q = (req.query.q || '').trim();
  const base =
    `SELECT t.name, t.email, t.phone, t.token, t.used, t.student_id, u.disabled
       FROM signup_tokens t
       LEFT JOIN users u ON u.id = t.student_id
      WHERE t.teacher_id = ? AND t.invite_role = 'student'`;
  let invites;
  if (q) {
    // Escape LIKE wildcards so the user's text is matched literally. ILIKE = case-insensitive.
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    invites = await all(
      `${base} AND (t.name ILIKE ? ESCAPE '\\' OR t.email ILIKE ? ESCAPE '\\') ORDER BY t.created_at DESC`,
      [req.user.id, like, like]
    );
  } else {
    invites = await all(`${base} ORDER BY t.created_at DESC`, [req.user.id]);
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
}));

// Download all of this teacher's students as a CSV file.
app.get('/api/students/export.csv', requireAuth('teacher'), h(async (req, res) => {
  const rows = await all(
    `SELECT t.name, t.email, t.phone, t.used, u.disabled,
            to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM signup_tokens t
       LEFT JOIN users u ON u.id = t.student_id
      WHERE t.teacher_id = ? AND t.invite_role = 'student' ORDER BY t.created_at DESC`,
    [req.user.id]
  );

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
  const csv = '﻿' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
  res.send(csv);
}));

// Enable/disable a student. A disabled student cannot log in, and any active
// session is revoked immediately.
app.patch('/api/students/:id', requireAuth('teacher'), h(async (req, res) => {
  const studentId = Number(req.params.id);
  const owned = await get(
    'SELECT 1 FROM signup_tokens WHERE teacher_id = ? AND student_id = ?',
    [req.user.id, studentId]
  );
  if (!owned) return res.status(404).json({ error: 'Student not found.' });
  const disabled = req.body.disabled ? 1 : 0;
  await run("UPDATE users SET disabled = ? WHERE id = ? AND role = 'student'", [disabled, studentId]);
  if (disabled) await run('DELETE FROM sessions WHERE user_id = ?', [studentId]); // log them out now
  res.json({ ok: true, disabled: !!disabled });
}));

// Teacher generates a password-reset link for one of their students.
app.post('/api/students/:id/reset-link', requireAuth('teacher'), h(async (req, res) => {
  const studentId = Number(req.params.id);
  const owned = await get('SELECT 1 FROM signup_tokens WHERE teacher_id = ? AND student_id = ?', [req.user.id, studentId]);
  if (!owned) return res.status(404).json({ error: 'Student not found.' });
  const token = await createResetToken(studentId);
  res.json({ resetPath: `/reset.html?token=${token}` });
}));

// ============================================================================
// TEACHERS  (root teachers can invite other teachers)
// ============================================================================
app.post('/api/teachers', requireRoot, h(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim();
  const makeRoot = req.body.isRoot ? 1 : 0;
  if (!name || !email) return res.status(400).json({ error: 'Teacher name and email are required.' });
  if (!phone) return res.status(400).json({ error: 'Teacher phone number is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone))
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (await get('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(409).json({ error: 'A user with that email already exists.' });
  if (await get('SELECT id FROM signup_tokens WHERE email = ? AND used = 0', [email]))
    return res.status(409).json({ error: 'A pending invite for that email already exists.' });

  const token = randomToken();
  await run(
    "INSERT INTO signup_tokens (token, name, email, phone, invite_role, is_root, teacher_id) VALUES (?, ?, ?, ?, 'teacher', ?, ?)",
    [token, name, email, phone, makeRoot, req.user.id]
  );
  res.json({ token, signupPath: `/signup.html?token=${token}` });
}));

// List all teachers plus pending teacher invites (root view).
app.get('/api/teachers', requireRoot, h(async (req, res) => {
  const signedUp = await all(
    "SELECT id, name, email, phone, is_root, disabled FROM users WHERE role = 'teacher' ORDER BY id"
  );
  const pending = await all(
    "SELECT name, email, phone, is_root, token FROM signup_tokens WHERE invite_role = 'teacher' AND used = 0 ORDER BY created_at DESC"
  );
  const teachers = [
    ...signedUp.map((u) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, isRoot: !!u.is_root, disabled: !!u.disabled,
      signedUp: true, isSelf: u.id === req.user.id, signupPath: null,
    })),
    ...pending.map((p) => ({
      id: null, name: p.name, email: p.email, phone: p.phone, isRoot: !!p.is_root, disabled: false,
      signedUp: false, isSelf: false, signupPath: `/signup.html?token=${p.token}`,
    })),
  ];
  res.json({ teachers });
}));

// Root generates a password-reset link for any teacher.
app.post('/api/teachers/:id/reset-link', requireRoot, h(async (req, res) => {
  const teacherId = Number(req.params.id);
  const t = await get("SELECT id FROM users WHERE id = ? AND role = 'teacher'", [teacherId]);
  if (!t) return res.status(404).json({ error: 'Teacher not found.' });
  const token = await createResetToken(teacherId);
  res.json({ resetPath: `/reset.html?token=${token}` });
}));

// Validate a signup token (used by the signup page to pre-fill name/email).
app.get('/api/signup/:token', h(async (req, res) => {
  const t = await get('SELECT * FROM signup_tokens WHERE token = ?', [req.params.token]);
  if (!t) return res.status(404).json({ error: 'This signup link is invalid.' });
  if (t.used) return res.status(410).json({ error: 'This signup link has already been used.' });
  res.json({ name: t.name, email: t.email, role: t.invite_role, isRoot: !!t.is_root });
}));

// Complete signup: set a password (creates a student or teacher per the invite).
app.post('/api/signup/:token', h(async (req, res) => {
  const t = await get('SELECT * FROM signup_tokens WHERE token = ?', [req.params.token]);
  if (!t) return res.status(404).json({ error: 'This signup link is invalid.' });
  if (t.used) return res.status(410).json({ error: 'This signup link has already been used.' });
  const password = req.body.password || '';
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await get('SELECT id FROM users WHERE email = ?', [t.email]))
    return res.status(409).json({ error: 'An account with that email already exists.' });

  const role = t.invite_role === 'teacher' ? 'teacher' : 'student';
  const isRoot = role === 'teacher' && t.is_root ? 1 : 0;
  const newId = (await run(
    'INSERT INTO users (role, name, email, phone, password_hash, is_root) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [role, t.name, t.email, t.phone, hashPassword(password), isRoot]
  )).rows[0].id;
  await run('UPDATE signup_tokens SET used = 1, student_id = ? WHERE id = ?', [newId, t.id]);
  await startSession(res, newId);
  res.json({ user: { id: newId, role, name: t.name, email: t.email, isRoot: !!isRoot } });
}));

// ============================================================================
// TESTS  (teacher creates + manages)
// ============================================================================
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

// Only accept image URLs we produced (paths under /uploads/), never arbitrary URLs.
function safeImageUrl(url) {
  return typeof url === 'string' && /^\/uploads\/[\w.-]+$/.test(url) ? url : '';
}

// Insert the given questions for a test using the provided (transactional) run.
async function writeQuestions(runFn, testId, questions) {
  for (const [idx, q] of questions.entries()) {
    let options = '[]';
    let correct = '';
    if (q.type === 'mcq') {
      options = JSON.stringify(q.options.filter((o) => o.trim() !== ''));
      correct = String(q.correct);
    } else if (q.type === 'truefalse') {
      correct = String(q.correct);
    }
    const points = Number(q.points) > 0 ? Number(q.points) : 1;
    await runFn(
      `INSERT INTO questions (test_id, type, prompt, options_json, correct_answer, image_url, points, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [testId, q.type, q.prompt.trim(), options, correct, safeImageUrl(q.image), points, idx]
    );
  }
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

// Time limit in minutes (0 = no timer).
function readDuration(body) {
  const d = Math.round(Number(body.durationMinutes));
  return Number.isFinite(d) && d > 0 ? d : 0;
}

app.post('/api/tests', requireAuth('teacher'), h(async (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!title) return res.status(400).json({ error: 'Test title is required.' });
  const invalid = validateQuestions(questions);
  if (invalid) return res.status(400).json({ error: invalid });
  const { negative_marking, penalty } = readMarking(req.body);
  const dueDate = readDueDate(req.body);
  const duration = readDuration(req.body);

  const testId = await tx(async (t) => {
    const newId = (await t.run(
      'INSERT INTO tests (teacher_id, title, description, negative_marking, penalty, due_date, duration_minutes) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [req.user.id, title, description, negative_marking, penalty, dueDate, duration]
    )).rows[0].id;
    await writeQuestions(t.run, newId, questions);
    return newId;
  });
  res.json({ id: testId });
}));

// Update an existing test — preserves past attempts by archiving answered questions.
app.put('/api/tests/:id', requireAuth('teacher'), h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!title) return res.status(400).json({ error: 'Test title is required.' });
  const invalid = validateQuestions(questions);
  if (invalid) return res.status(400).json({ error: invalid });
  const { negative_marking, penalty } = readMarking(req.body);
  const dueDate = readDueDate(req.body);
  const duration = readDuration(req.body);

  const keptAttempts = await tx(async (t) => {
    // Archive any answered current question (so old results keep their exact
    // questions/scores); remove unanswered current questions.
    const current = await t.all('SELECT id FROM questions WHERE test_id = ? AND archived = 0', [test.id]);
    for (const q of current) {
      const answered = await t.get('SELECT 1 FROM answers WHERE question_id = ? LIMIT 1', [q.id]);
      if (answered) await t.run('UPDATE questions SET archived = 1 WHERE id = ?', [q.id]);
      else await t.run('DELETE FROM questions WHERE id = ?', [q.id]);
    }
    await t.run(
      'UPDATE tests SET title = ?, description = ?, negative_marking = ?, penalty = ?, due_date = ?, duration_minutes = ? WHERE id = ?',
      [title, description, negative_marking, penalty, dueDate, duration, test.id]
    );
    await writeQuestions(t.run, test.id, questions);
    return (await t.get("SELECT COUNT(*) AS c FROM attempts WHERE test_id = ? AND submitted_at IS NOT NULL", [test.id])).c;
  });
  res.json({ id: test.id, keptAttempts });
}));

app.get('/api/tests', requireAuth('teacher'), h(async (req, res) => {
  const tests = await all(
    `SELECT t.id, t.title, t.description, t.negative_marking, t.penalty, t.due_date, t.duration_minutes, t.created_at,
            (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id AND q.archived = 0) AS question_count,
            (SELECT COUNT(*) FROM assignments a WHERE a.test_id = t.id) AS assigned_count,
            (SELECT COUNT(*) FROM attempts at WHERE at.test_id = t.id AND at.submitted_at IS NOT NULL) AS submitted_count
       FROM tests t WHERE t.teacher_id = ? ORDER BY t.created_at DESC`,
    [req.user.id]
  );
  tests.forEach((t) => { t.closed = isClosed(t.due_date); });
  res.json({ tests });
}));

app.get('/api/tests/:id', requireAuth('teacher'), h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const questions = (await all('SELECT * FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position', [test.id]))
    .map((q) => ({ ...q, options: JSON.parse(q.options_json) }));
  res.json({ test, questions });
}));

app.delete('/api/tests/:id', requireAuth('teacher'), h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  await run('DELETE FROM tests WHERE id = ?', [test.id]);
  res.json({ ok: true });
}));

// ============================================================================
// ASSIGNMENTS  (teacher assigns a test to students)
// ============================================================================
app.post('/api/assignments', requireAuth('teacher'), h(async (req, res) => {
  const testId = Number(req.body.test_id);
  const studentIds = Array.isArray(req.body.student_ids) ? req.body.student_ids.map(Number) : [];
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [testId, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  if (studentIds.length === 0) return res.status(400).json({ error: 'Select at least one student.' });

  let added = 0;
  await tx(async (t) => {
    for (const sid of studentIds) {
      const student = await t.get("SELECT id FROM users WHERE id = ? AND role = 'student'", [sid]);
      if (student) {
        const r = await t.run(
          'INSERT INTO assignments (test_id, student_id, teacher_id) VALUES (?, ?, ?) ON CONFLICT (test_id, student_id) DO NOTHING',
          [testId, sid, req.user.id]
        );
        added += r.changes;
      }
    }
  });
  res.json({ assigned: added });
}));

// Who is already assigned to a given test (teacher view).
app.get('/api/tests/:id/assignments', requireAuth('teacher'), h(async (req, res) => {
  const rows = await all(
    `SELECT a.student_id, u.name, u.email,
            EXISTS(SELECT 1 FROM attempts at WHERE at.assignment_id = a.id AND at.submitted_at IS NOT NULL) AS submitted
       FROM assignments a JOIN users u ON u.id = a.student_id
      WHERE a.test_id = ?`,
    [req.params.id]
  );
  res.json({ assigned: rows });
}));

// ============================================================================
// STUDENT: my assigned tests + taking them
// ============================================================================
app.get('/api/my-assignments', requireAuth('student'), h(async (req, res) => {
  const rows = await all(
    `SELECT a.id AS assignment_id, t.id AS test_id, t.title, t.description, t.due_date,
            (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id AND q.archived = 0) AS question_count,
            at.id AS attempt_id, at.submitted_at, at.auto_score, at.manual_score,
            at.max_score, at.needs_grading
       FROM assignments a
       JOIN tests t ON t.id = a.test_id
       LEFT JOIN attempts at ON at.assignment_id = a.id
      WHERE a.student_id = ?
      ORDER BY a.created_at DESC`,
    [req.user.id]
  );
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
}));

// Fetch a test to take — WITHOUT correct answers.
app.get('/api/take/:assignmentId', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  let attempt = await get('SELECT * FROM attempts WHERE assignment_id = ?', [a.id]);
  if (attempt && attempt.submitted_at)
    return res.status(409).json({ error: 'You have already submitted this test.' });

  const test = await get('SELECT id, title, description, negative_marking, penalty, due_date, duration_minutes FROM tests WHERE id = ?', [a.test_id]);
  if (isClosed(test.due_date))
    return res.status(403).json({ error: 'The deadline for this test has passed. You can no longer take it.' });

  // For a timed test, anchor the countdown to a server-recorded start time.
  // The first open creates an in-progress attempt; reopening resumes the same clock.
  let remainingSeconds = null;
  if (test.duration_minutes > 0) {
    if (!attempt) {
      attempt = (await run(
        'INSERT INTO attempts (assignment_id, test_id, student_id) VALUES (?, ?, ?) RETURNING id, started_at',
        [a.id, a.test_id, req.user.id]
      )).rows[0];
    }
    const elapsed = (Date.now() - new Date(attempt.started_at).getTime()) / 1000;
    remainingSeconds = Math.max(0, Math.round(test.duration_minutes * 60 - elapsed));
  }

  const questions = (await all(
    'SELECT id, type, prompt, options_json, image_url, points FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position',
    [a.test_id]
  )).map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, points: q.points, image: q.image_url, options: JSON.parse(q.options_json) }));
  res.json({ test, questions, durationMinutes: test.duration_minutes, remainingSeconds });
}));

// Submit answers — auto-grade mcq/truefalse, flag short answers for the teacher.
app.post('/api/submit/:assignmentId', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  const existing = await get('SELECT * FROM attempts WHERE assignment_id = ?', [a.id]);
  if (existing && existing.submitted_at)
    return res.status(409).json({ error: 'You have already submitted this test.' });

  const test = await get('SELECT negative_marking, penalty, due_date FROM tests WHERE id = ?', [a.test_id]);
  if (isClosed(test.due_date))
    return res.status(403).json({ error: 'The deadline for this test has passed. Your submission was not accepted.' });
  const questions = await all('SELECT * FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position', [a.test_id]);
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
      else if (answered && test.negative_marking) awarded = -test.penalty;
      autoScore += awarded;
    } else {
      needsGrading = 1; // short answer — teacher grades later
    }
    graded.push({ questionId: q.id, response: resp, isCorrect, awarded });
  }

  await tx(async (t) => {
    let attemptId;
    if (existing) {
      // Finalize the in-progress (timed) attempt.
      attemptId = existing.id;
      await t.run(
        'UPDATE attempts SET submitted_at = NOW(), auto_score = ?, manual_score = 0, max_score = ?, needs_grading = ? WHERE id = ?',
        [autoScore, maxScore, needsGrading, attemptId]
      );
    } else {
      attemptId = (await t.run(
        `INSERT INTO attempts (assignment_id, test_id, student_id, submitted_at, auto_score, manual_score, max_score, needs_grading)
         VALUES (?, ?, ?, NOW(), ?, 0, ?, ?) RETURNING id`,
        [a.id, a.test_id, req.user.id, autoScore, maxScore, needsGrading]
      )).rows[0].id;
    }
    for (const g of graded) {
      await t.run(
        'INSERT INTO answers (attempt_id, question_id, response, is_correct, points_awarded) VALUES (?, ?, ?, ?, ?)',
        [attemptId, g.questionId, g.response, g.isCorrect, g.awarded]
      );
    }
  });
  res.json({ autoScore, maxScore, needsGrading: !!needsGrading });
}));

// ============================================================================
// RESULTS + GRADING  (teacher)
// ============================================================================
app.get('/api/tests/:id/results', requireAuth('teacher'), h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const rows = await all(
    `SELECT at.id AS attempt_id, u.name, u.email, at.submitted_at,
            at.auto_score, at.manual_score, at.max_score, at.needs_grading
       FROM attempts at JOIN users u ON u.id = at.student_id
      WHERE at.test_id = ? AND at.submitted_at IS NOT NULL
      ORDER BY at.submitted_at DESC`,
    [test.id]
  );
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
}));

// Full detail of one attempt (for grading / review).
app.get('/api/attempts/:attemptId', requireAuth('teacher'), h(async (req, res) => {
  const attempt = await get(
    `SELECT at.*, u.name, u.email FROM attempts at
       JOIN users u ON u.id = at.student_id
       JOIN tests t ON t.id = at.test_id
      WHERE at.id = ? AND t.teacher_id = ?`,
    [req.params.attemptId, req.user.id]
  );
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
  const items = (await all(
    `SELECT ans.id AS answer_id, ans.response, ans.is_correct, ans.points_awarded,
            q.id AS question_id, q.type, q.prompt, q.options_json, q.correct_answer, q.image_url, q.points
       FROM answers ans JOIN questions q ON q.id = ans.question_id
      WHERE ans.attempt_id = ? ORDER BY q.position`,
    [attempt.id]
  )).map((r) => ({
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
}));

// Teacher grades short answers: { grades: { answerId: points } }
app.post('/api/attempts/:attemptId/grade', requireAuth('teacher'), h(async (req, res) => {
  const attempt = await get(
    `SELECT at.* FROM attempts at JOIN tests t ON t.id = at.test_id
      WHERE at.id = ? AND t.teacher_id = ?`,
    [req.params.attemptId, req.user.id]
  );
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
  const grades = req.body.grades || {};

  await tx(async (t) => {
    for (const [answerId, pts] of Object.entries(grades)) {
      const ans = await t.get(
        `SELECT ans.*, q.points AS max_points, q.type FROM answers ans
           JOIN questions q ON q.id = ans.question_id
          WHERE ans.id = ? AND ans.attempt_id = ?`,
        [Number(answerId), attempt.id]
      );
      if (!ans || ans.type !== 'short') continue;
      let p = Number(pts);
      if (!Number.isFinite(p) || p < 0) p = 0;
      if (p > ans.max_points) p = ans.max_points;
      await t.run('UPDATE answers SET points_awarded = ?, is_correct = ? WHERE id = ?', [p, p > 0 ? 1 : 0, ans.id]);
    }
    const manual = (await t.get(
      `SELECT COALESCE(SUM(ans.points_awarded), 0) AS s FROM answers ans
         JOIN questions q ON q.id = ans.question_id
        WHERE ans.attempt_id = ? AND q.type = 'short'`,
      [attempt.id]
    )).s;
    const ungraded = (await t.get(
      `SELECT COUNT(*) AS c FROM answers ans JOIN questions q ON q.id = ans.question_id
        WHERE ans.attempt_id = ? AND q.type = 'short' AND ans.is_correct IS NULL`,
      [attempt.id]
    )).c;
    await t.run('UPDATE attempts SET manual_score = ?, needs_grading = ? WHERE id = ?', [manual, ungraded > 0 ? 1 : 0, attempt.id]);
  });
  res.json({ ok: true });
}));

// --- Static files ------------------------------------------------------------
// no-cache so the browser always revalidates and never shows a stale page.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// JSON error handler (async route rejections land here).
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

await init();
app.listen(PORT, () => {
  console.log(`\n  Online Test Platform running at:  http://localhost:${PORT}\n`);
});
