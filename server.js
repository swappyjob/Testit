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
const PROD = process.env.NODE_ENV === 'production';

// Behind a hosting platform's load balancer / reverse proxy (Render, a VPS
// nginx, Cloud Run, ...), trust the X-Forwarded-* headers so req.protocol is
// 'https' and Secure cookies are sent correctly.
if (PROD) app.set('trust proxy', 1);

// Larger limit so base64-encoded question images fit in the JSON body.
app.use(express.json({ limit: '8mb' }));

// Folder where uploaded question images are stored and served from. In
// production point UPLOAD_DIR at a persistent disk so images survive redeploys.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');
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

// A student's access end date. The whole end-date day is still valid; access
// expires once that day has fully passed.
function isExpired(accessUntil) {
  if (!accessUntil) return false;
  const t = new Date(accessUntil + 'T23:59:59').getTime();
  return Number.isFinite(t) && t < Date.now();
}
// Keep only a valid YYYY-MM-DD date string, else ''.
function readAccessUntil(body) {
  const d = (body.accessUntil || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  return Number.isFinite(new Date(d).getTime()) ? d : '';
}

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
  return `${req.protocol}://${req.get('host')}/reset?token=${token}`;
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
      `SELECT u.*, o.name AS org_name, o.subscription_expires_at AS org_subscription_until
         FROM sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN organizations o ON o.id = u.org_id
        WHERE s.token = ? AND u.disabled = 0`,
      [sid]
    );
    // Students past their access end date are treated as logged out.
    if (row && !(row.role === 'student' && isExpired(row.access_until))) req.user = row;
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

// The platform-level root admin.
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only the root admin can do that.' });
  next();
}

// When a teacher's organization subscription has expired, the whole org drops to
// read-only: block every create/edit/delete. Reads are unaffected. Admins and
// students are not subject to this check.
function requireActiveSubscription(req, res, next) {
  if (req.user && req.user.role === 'teacher' && isExpired(req.user.org_subscription_until)) {
    return res.status(403).json({
      error: "Your organization's subscription has expired, so the account is in read-only mode. Please ask your administrator to renew it.",
    });
  }
  next();
}

async function startSession(res, userId) {
  const token = randomToken();
  await run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [token, userId]);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 1000 * 60 * 60 * 24 * 7 });
}

const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, email: u.email, isRoot: !!u.is_root,
  orgId: u.org_id, orgName: u.org_name || null,
  subscriptionUntil: u.org_subscription_until || null,
  subscriptionExpired: isExpired(u.org_subscription_until),
});

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

  // Bootstrap/dev entry point (not exposed in the UI): create a fresh
  // organization and make this teacher its root teacher.
  const { newId, orgId } = await tx(async (t) => {
    const oid = (await t.run('INSERT INTO organizations (name) VALUES (?) RETURNING id', [`${name}'s Organization`])).rows[0].id;
    const uid = (await t.run(
      'INSERT INTO users (role, name, email, password_hash, is_root, org_id) VALUES (?, ?, ?, ?, 1, ?) RETURNING id',
      ['teacher', name, email, hashPassword(password), oid]
    )).rows[0].id;
    return { newId: uid, orgId: oid };
  });
  await startSession(res, newId);
  res.json({ user: { id: newId, role: 'teacher', name, email, isRoot: true, orgId } });
}));

app.post('/api/login', h(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = await get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password.' });
  if (user.disabled)
    return res.status(403).json({ error: 'Your account has been disabled. Please contact your teacher.' });
  if (user.role === 'student' && isExpired(user.access_until))
    return res.status(403).json({ error: 'Your access period has ended. Please contact your teacher.' });
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
app.post('/api/students', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim();
  const accessUntil = readAccessUntil(req.body);
  if (!name || !email) return res.status(400).json({ error: 'Student name and email are required.' });
  if (!phone) return res.status(400).json({ error: 'Student phone number is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone))
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (await get('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(409).json({ error: 'A user with that email already exists.' });
  if (await get('SELECT id FROM signup_tokens WHERE email = ? AND used = 0', [email]))
    return res.status(409).json({ error: 'A pending invite for that email already exists.' });

  // Enforce the organization's plan student limit (NULL cap = unlimited).
  const plan = await get(
    'SELECT p.max_students FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = ?',
    [req.user.org_id]
  );
  if (plan && plan.max_students != null) {
    const used = (await get("SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [req.user.org_id])).c;
    if (used >= plan.max_students)
      return res.status(403).json({ error: `Your organization has reached its plan's student limit (${plan.max_students}). Ask your administrator to upgrade the plan.` });
  }

  const token = randomToken();
  await run(
    'INSERT INTO signup_tokens (token, name, email, phone, access_until, org_id, teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [token, name, email, phone, accessUntil, req.user.org_id, req.user.id]
  );
  res.json({ token, signupPath: `/signup?token=${token}` });
}));

// List this teacher's students + pending invites.
app.get('/api/students', requireAuth('teacher'), h(async (req, res) => {
  const q = (req.query.q || '').trim();
  // Students belong to the organization, so every teacher in the org sees them all.
  const base =
    `SELECT t.id AS token_id, t.name, t.email, t.phone, t.access_until, t.token, t.used, t.student_id, u.disabled
       FROM signup_tokens t
       LEFT JOIN users u ON u.id = t.student_id
      WHERE t.org_id = ? AND t.invite_role = 'student'`;
  let invites;
  if (q) {
    // Escape LIKE wildcards so the user's text is matched literally. ILIKE = case-insensitive.
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    invites = await all(
      `${base} AND (t.name ILIKE ? ESCAPE '\\' OR t.email ILIKE ? ESCAPE '\\') ORDER BY t.created_at DESC`,
      [req.user.org_id, like, like]
    );
  } else {
    invites = await all(`${base} ORDER BY t.created_at DESC`, [req.user.org_id]);
  }
  const students = invites.map((i) => ({
    id: i.token_id,
    name: i.name,
    email: i.email,
    phone: i.phone,
    accessUntil: i.access_until,
    expired: !!i.access_until && isExpired(i.access_until),
    signedUp: !!i.used,
    studentId: i.student_id,
    disabled: !!i.disabled,
    signupPath: i.used ? null : `/signup?token=${i.token}`,
  }));
  res.json({ students });
}));

// Download all of this teacher's students as a CSV file.
app.get('/api/students/export.csv', requireAuth('teacher'), h(async (req, res) => {
  const rows = await all(
    `SELECT t.name, t.email, t.phone, t.access_until, t.used, u.disabled,
            to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM signup_tokens t
       LEFT JOIN users u ON u.id = t.student_id
      WHERE t.org_id = ? AND t.invite_role = 'student' ORDER BY t.created_at DESC`,
    [req.user.org_id]
  );

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Name', 'Email', 'Mobile Number', 'Access Until', 'Signup Status', 'Account Status', 'Added On'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const signup = r.used ? 'Signed up' : 'Invite pending';
    const account = !r.used ? '' : (r.disabled ? 'Disabled' : (isExpired(r.access_until) ? 'Expired' : 'Active'));
    lines.push([r.name, r.email, r.phone, r.access_until, signup, account, r.created_at].map(esc).join(','));
  }
  const csv = '﻿' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
  res.send(csv);
}));

// Enable/disable a student. A disabled student cannot log in, and any active
// session is revoked immediately.
app.patch('/api/students/:id', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const studentId = Number(req.params.id);
  const owned = await get(
    "SELECT 1 FROM users WHERE id = ? AND role = 'student' AND org_id = ?",
    [studentId, req.user.org_id]
  );
  if (!owned) return res.status(404).json({ error: 'Student not found.' });
  const disabled = req.body.disabled ? 1 : 0;
  await run("UPDATE users SET disabled = ? WHERE id = ? AND role = 'student'", [disabled, studentId]);
  if (disabled) await run('DELETE FROM sessions WHERE user_id = ?', [studentId]); // log them out now
  res.json({ ok: true, disabled: !!disabled });
}));

// Edit a student's details (name, phone, access end date). Email is immutable.
// :id is the signup-invite id (works for pending and signed-up students).
app.put('/api/students/:id', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const tok = await get(
    "SELECT * FROM signup_tokens WHERE id = ? AND org_id = ? AND invite_role = 'student'",
    [Number(req.params.id), req.user.org_id]
  );
  if (!tok) return res.status(404).json({ error: 'Student not found.' });
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const accessUntil = readAccessUntil(req.body);
  if (!name) return res.status(400).json({ error: 'Student name is required.' });
  if (!phone) return res.status(400).json({ error: 'Student phone number is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone))
    return res.status(400).json({ error: 'Please enter a valid phone number.' });

  await run('UPDATE signup_tokens SET name = ?, phone = ?, access_until = ? WHERE id = ?',
    [name, phone, accessUntil, tok.id]);
  if (tok.student_id) {
    await run('UPDATE users SET name = ?, phone = ?, access_until = ? WHERE id = ?',
      [name, phone, accessUntil, tok.student_id]);
  }
  res.json({ ok: true });
}));

// Teacher generates a password-reset link for one of their students.
app.post('/api/students/:id/reset-link', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const studentId = Number(req.params.id);
  const owned = await get("SELECT 1 FROM users WHERE id = ? AND role = 'student' AND org_id = ?", [studentId, req.user.org_id]);
  if (!owned) return res.status(404).json({ error: 'Student not found.' });
  const token = await createResetToken(studentId);
  res.json({ resetPath: `/reset?token=${token}` });
}));

// ============================================================================
// TEACHERS  (root teachers can invite other teachers)
// ============================================================================
app.post('/api/teachers', requireRoot, requireActiveSubscription, h(async (req, res) => {
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
    "INSERT INTO signup_tokens (token, name, email, phone, invite_role, is_root, org_id, teacher_id) VALUES (?, ?, ?, ?, 'teacher', ?, ?, ?)",
    [token, name, email, phone, makeRoot, req.user.org_id, req.user.id]
  );
  res.json({ token, signupPath: `/signup?token=${token}` });
}));

// List teachers IN THE VIEWER'S ORGANIZATION. Any teacher can view the roster;
// pending invites (and their signup links) are only included for root teachers.
app.get('/api/teachers', requireAuth('teacher'), h(async (req, res) => {
  const isRoot = !!req.user.is_root;
  const signedUp = await all(
    "SELECT id, name, email, phone, is_root, disabled FROM users WHERE role = 'teacher' AND org_id = ? ORDER BY id",
    [req.user.org_id]
  );
  const teachers = signedUp.map((u) => ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, isRoot: !!u.is_root, disabled: !!u.disabled,
    signedUp: true, isSelf: u.id === req.user.id, signupPath: null,
  }));
  if (isRoot) {
    const pending = await all(
      "SELECT name, email, phone, is_root, token FROM signup_tokens WHERE invite_role = 'teacher' AND used = 0 AND org_id = ? ORDER BY created_at DESC",
      [req.user.org_id]
    );
    for (const p of pending) {
      teachers.push({
        id: null, name: p.name, email: p.email, phone: p.phone, isRoot: !!p.is_root, disabled: false,
        signedUp: false, isSelf: false, signupPath: `/signup?token=${p.token}`,
      });
    }
  }
  res.json({ teachers, canManage: isRoot });
}));

// Root enables/disables another teacher. A disabled teacher cannot log in and
// is logged out immediately. A root cannot disable their own account.
app.patch('/api/teachers/:id', requireRoot, requireActiveSubscription, h(async (req, res) => {
  const teacherId = Number(req.params.id);
  if (teacherId === req.user.id)
    return res.status(400).json({ error: "You can't disable your own account." });
  const t = await get("SELECT id FROM users WHERE id = ? AND role = 'teacher' AND org_id = ?", [teacherId, req.user.org_id]);
  if (!t) return res.status(404).json({ error: 'Teacher not found.' });
  const disabled = req.body.disabled ? 1 : 0;
  await run('UPDATE users SET disabled = ? WHERE id = ?', [disabled, teacherId]);
  if (disabled) await run('DELETE FROM sessions WHERE user_id = ?', [teacherId]);
  res.json({ ok: true, disabled: !!disabled });
}));

// Root generates a password-reset link for a teacher in their organization.
app.post('/api/teachers/:id/reset-link', requireRoot, requireActiveSubscription, h(async (req, res) => {
  const teacherId = Number(req.params.id);
  const t = await get("SELECT id FROM users WHERE id = ? AND role = 'teacher' AND org_id = ?", [teacherId, req.user.org_id]);
  if (!t) return res.status(404).json({ error: 'Teacher not found.' });
  const token = await createResetToken(teacherId);
  res.json({ resetPath: `/reset?token=${token}` });
}));

// Root edits a signed-up teacher in their organization (name, phone, role).
// Email is immutable. A root can't remove their own root status (self-lockout).
app.put('/api/teachers/:id', requireRoot, requireActiveSubscription, h(async (req, res) => {
  const teacherId = Number(req.params.id);
  const t = await get("SELECT id FROM users WHERE id = ? AND role = 'teacher' AND org_id = ?", [teacherId, req.user.org_id]);
  if (!t) return res.status(404).json({ error: 'Teacher not found.' });
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  let isRoot = req.body.isRoot ? 1 : 0;
  if (!name) return res.status(400).json({ error: 'Teacher name is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (teacherId === req.user.id) isRoot = 1;
  await run('UPDATE users SET name = ?, phone = ?, is_root = ? WHERE id = ?', [name, phone, isRoot, teacherId]);
  res.json({ ok: true });
}));

// Root edits a still-pending teacher invite in their organization (name, phone, role).
app.put('/api/teacher-invites/:token', requireRoot, requireActiveSubscription, h(async (req, res) => {
  const inv = await get(
    "SELECT id FROM signup_tokens WHERE token = ? AND invite_role = 'teacher' AND used = 0 AND org_id = ?",
    [req.params.token, req.user.org_id]
  );
  if (!inv) return res.status(404).json({ error: 'Invite not found.' });
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const isRoot = req.body.isRoot ? 1 : 0;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  await run('UPDATE signup_tokens SET name = ?, phone = ?, is_root = ? WHERE token = ?', [name, phone, isRoot, req.params.token]);
  res.json({ ok: true });
}));

// ============================================================================
// ADMIN  (platform root admin: organizations + their root teachers)
// ============================================================================
app.post('/api/orgs', requireAdmin, h(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name is required.' });
  const id = (await run(
    "INSERT INTO organizations (name, plan_id) VALUES (?, (SELECT id FROM plans WHERE name = 'Basic')) RETURNING id",
    [name]
  )).rows[0].id;
  res.json({ id, name });
}));

// List the available pricing plans.
app.get('/api/plans', requireAdmin, h(async (req, res) => {
  const plans = await all('SELECT id, name, max_students, price_monthly FROM plans ORDER BY sort_order');
  res.json({ plans });
}));

// Assign a plan to an organization.
app.put('/api/orgs/:id/plan', requireAdmin, h(async (req, res) => {
  const planId = Number(req.body.planId);
  if (!(await get('SELECT id FROM organizations WHERE id = ?', [Number(req.params.id)])))
    return res.status(404).json({ error: 'Organization not found.' });
  if (!(await get('SELECT id FROM plans WHERE id = ?', [planId])))
    return res.status(400).json({ error: 'Invalid plan.' });
  await run('UPDATE organizations SET plan_id = ? WHERE id = ?', [planId, Number(req.params.id)]);
  res.json({ ok: true });
}));

// Admin sets (or clears) an organization's subscription expiry date (YYYY-MM-DD).
// Empty string clears it (no expiry). Once past, the org's teachers go read-only.
app.put('/api/orgs/:id/subscription', requireAdmin, h(async (req, res) => {
  if (!(await get('SELECT id FROM organizations WHERE id = ?', [Number(req.params.id)])))
    return res.status(404).json({ error: 'Organization not found.' });
  const raw = (req.body.expiresAt || '').trim();
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw))
    return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format (or empty to clear).' });
  await run('UPDATE organizations SET subscription_expires_at = ? WHERE id = ?', [raw, Number(req.params.id)]);
  res.json({ ok: true, expiresAt: raw, expired: isExpired(raw) });
}));

// List the platform admins.
app.get('/api/admins', requireAdmin, h(async (req, res) => {
  const admins = await all("SELECT id, name, email FROM users WHERE role = 'admin' ORDER BY id");
  res.json({ admins: admins.map((a) => ({ id: a.id, name: a.name, email: a.email, isSelf: a.id === req.user.id })) });
}));

// An admin creates another platform admin.
app.post('/api/admins', requireAdmin, h(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await get('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(409).json({ error: 'That email is already in use.' });
  const id = (await run(
    "INSERT INTO users (role, name, email, password_hash) VALUES ('admin', ?, ?, ?) RETURNING id",
    [name, email, hashPassword(password)]
  )).rows[0].id;
  res.json({ id, name, email });
}));

// A teacher views their own organization's current plan, usage, and all plans.
app.get('/api/my-org/plan', requireAuth('teacher'), h(async (req, res) => {
  const plan = await get(
    'SELECT p.id, p.name, p.max_students, p.price_monthly FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = ?',
    [req.user.org_id]
  );
  const studentCount = (await get(
    "SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [req.user.org_id]
  )).c;
  const plans = await all('SELECT id, name, max_students, price_monthly FROM plans ORDER BY sort_order');
  res.json({ plan: plan && plan.id ? plan : null, studentCount, plans });
}));

// A root teacher subscribes their organization to a different plan (self-service).
app.post('/api/my-org/plan', requireRoot, h(async (req, res) => {
  const planId = Number(req.body.planId);
  const plan = await get('SELECT id, name, max_students FROM plans WHERE id = ?', [planId]);
  if (!plan) return res.status(400).json({ error: 'Invalid plan.' });
  const studentCount = (await get(
    "SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [req.user.org_id]
  )).c;
  if (plan.max_students != null && studentCount > plan.max_students)
    return res.status(400).json({ error: `Your organization has ${studentCount} students, but the ${plan.name} plan supports up to ${plan.max_students}. Remove students or choose a larger plan.` });
  await run('UPDATE organizations SET plan_id = ? WHERE id = ?', [planId, req.user.org_id]);
  res.json({ ok: true });
}));

// List organizations with their teachers (signed up + pending) and counts.
// Optional ?q= filters by organization name (case-insensitive).
app.get('/api/orgs', requireAdmin, h(async (req, res) => {
  const q = (req.query.q || '').trim();
  const cols = 'o.id, o.name, o.plan_id, o.subscription_expires_at, p.name AS plan_name, p.max_students, p.price_monthly';
  const orgs = q
    ? await all(`SELECT ${cols} FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.name ILIKE ? ESCAPE '\\' ORDER BY o.name`,
        ['%' + q.replace(/[\\%_]/g, '\\$&') + '%'])
    : await all(`SELECT ${cols} FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id ORDER BY o.name`);
  const result = [];
  for (const o of orgs) {
    const signedUp = await all(
      "SELECT id, name, email, phone, is_root, disabled FROM users WHERE role = 'teacher' AND org_id = ? ORDER BY id", [o.id]
    );
    const pending = await all(
      "SELECT name, email, phone, is_root, token FROM signup_tokens WHERE invite_role = 'teacher' AND used = 0 AND org_id = ? ORDER BY created_at DESC", [o.id]
    );
    // Billable student count = student slots provisioned (invites), matching the plan cap.
    const studentCount = (await get("SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [o.id])).c;
    const teachers = [
      ...signedUp.map((u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, isRoot: !!u.is_root, disabled: !!u.disabled, signedUp: true, signupPath: null })),
      ...pending.map((p) => ({ id: null, name: p.name, email: p.email, phone: p.phone, isRoot: !!p.is_root, disabled: false, signedUp: false, signupPath: `/signup?token=${p.token}` })),
    ];
    result.push({
      id: o.id, name: o.name, teachers, teacherCount: signedUp.length, studentCount,
      planId: o.plan_id, planName: o.plan_name, maxStudents: o.max_students, priceMonthly: o.price_monthly,
      subscriptionUntil: o.subscription_expires_at || '', subscriptionExpired: isExpired(o.subscription_expires_at),
    });
  }
  res.json({ orgs: result });
}));

// Admin enables/disables any teacher (in any organization). A disabled teacher
// is logged out immediately and cannot log in.
app.patch('/api/admin/teachers/:id', requireAdmin, h(async (req, res) => {
  const teacherId = Number(req.params.id);
  const t = await get("SELECT id FROM users WHERE id = ? AND role = 'teacher'", [teacherId]);
  if (!t) return res.status(404).json({ error: 'Teacher not found.' });
  const disabled = req.body.disabled ? 1 : 0;
  await run('UPDATE users SET disabled = ? WHERE id = ?', [disabled, teacherId]);
  if (disabled) await run('DELETE FROM sessions WHERE user_id = ?', [teacherId]);
  res.json({ ok: true, disabled: !!disabled });
}));

// Admin edits a teacher (name, phone, root status). Email is immutable.
app.put('/api/admin/teachers/:id', requireAdmin, h(async (req, res) => {
  const teacherId = Number(req.params.id);
  const t = await get("SELECT id FROM users WHERE id = ? AND role = 'teacher'", [teacherId]);
  if (!t) return res.status(404).json({ error: 'Teacher not found.' });
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const isRoot = req.body.isRoot ? 1 : 0;
  if (!name) return res.status(400).json({ error: 'Teacher name is required.' });
  if (!phone) return res.status(400).json({ error: 'Teacher phone number is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone))
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  await run('UPDATE users SET name = ?, phone = ?, is_root = ? WHERE id = ?', [name, phone, isRoot, teacherId]);
  res.json({ ok: true });
}));

// Admin generates a password-reset link for any teacher (in any organization).
app.post('/api/admin/teachers/:id/reset-link', requireAdmin, h(async (req, res) => {
  const teacherId = Number(req.params.id);
  const t = await get("SELECT id FROM users WHERE id = ? AND role = 'teacher'", [teacherId]);
  if (!t) return res.status(404).json({ error: 'Teacher not found.' });
  const token = await createResetToken(teacherId);
  res.json({ resetPath: `/reset?token=${token}` });
}));

// Admin renames an organization.
app.put('/api/orgs/:id', requireAdmin, h(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name is required.' });
  const org = await get('SELECT id FROM organizations WHERE id = ?', [Number(req.params.id)]);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });
  await run('UPDATE organizations SET name = ? WHERE id = ?', [name, org.id]);
  res.json({ ok: true });
}));

// Admin creates a root teacher for an organization (returns a signup link).
app.post('/api/admin/root-teachers', requireAdmin, h(async (req, res) => {
  const orgId = Number(req.body.orgId);
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim();
  if (!(await get('SELECT id FROM organizations WHERE id = ?', [orgId])))
    return res.status(404).json({ error: 'Organization not found.' });
  if (!name || !email) return res.status(400).json({ error: 'Teacher name and email are required.' });
  if (!phone) return res.status(400).json({ error: 'Teacher phone number is required.' });
  if (!/^[\d+()\-\s]{6,20}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (await get('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(409).json({ error: 'A user with that email already exists.' });
  if (await get('SELECT id FROM signup_tokens WHERE email = ? AND used = 0', [email]))
    return res.status(409).json({ error: 'A pending invite for that email already exists.' });

  const token = randomToken();
  await run(
    "INSERT INTO signup_tokens (token, name, email, phone, invite_role, is_root, org_id, teacher_id) VALUES (?, ?, ?, ?, 'teacher', 1, ?, ?)",
    [token, name, email, phone, orgId, req.user.id]
  );
  res.json({ token, signupPath: `/signup?token=${token}` });
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
    'INSERT INTO users (role, name, email, phone, password_hash, is_root, access_until, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [role, t.name, t.email, t.phone, hashPassword(password), isRoot, t.access_until || '', t.org_id || null]
  )).rows[0].id;
  await run('UPDATE signup_tokens SET used = 1, student_id = ? WHERE id = ?', [newId, t.id]);
  await startSession(res, newId);
  res.json({ user: { id: newId, role, name: t.name, email: t.email, isRoot: !!isRoot, orgId: t.org_id || null } });
}));

// ============================================================================
// TESTS  (teacher creates + manages)
// ============================================================================
function validateQuestions(questions) {
  if (questions.length === 0) return 'Add at least one question.';
  for (const [i, q] of questions.entries()) {
    if (!q.prompt || !q.prompt.trim()) return `Question ${i + 1} is missing its text.`;
    if (!['mcq', 'truefalse', 'short', 'multi'].includes(q.type)) return `Question ${i + 1} has an invalid type.`;
    if (q.type === 'mcq') {
      const opts = Array.isArray(q.options) ? q.options.filter((o) => o.trim() !== '') : [];
      if (opts.length < 2) return `Question ${i + 1} needs at least two choices.`;
      const ci = Number(q.correct);
      if (!Number.isInteger(ci) || ci < 0 || ci >= opts.length)
        return `Question ${i + 1} needs a correct choice selected.`;
    }
    if (q.type === 'multi') {
      const opts = Array.isArray(q.options) ? q.options.filter((o) => o.trim() !== '') : [];
      if (opts.length < 2) return `Question ${i + 1} needs at least two choices.`;
      const correct = Array.isArray(q.correct) ? q.correct.map(Number) : [];
      const valid = correct.filter((ci) => Number.isInteger(ci) && ci >= 0 && ci < opts.length);
      if (valid.length < 1) return `Question ${i + 1} needs at least one correct choice selected.`;
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

// Parse a JSON array of option indices into a clean, sorted, de-duplicated set.
// Used for multi-answer questions (both the stored key and the student response).
function parseIndexSet(str) {
  let arr = [];
  try { arr = JSON.parse(str); } catch { /* not JSON */ }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(Number))].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
}

// Insert the given questions for a test using the provided (transactional) run.
async function writeQuestions(runFn, testId, questions) {
  for (const [idx, q] of questions.entries()) {
    let options = '[]';
    let correct = '';
    if (q.type === 'mcq') {
      options = JSON.stringify(q.options.filter((o) => o.trim() !== ''));
      correct = String(q.correct);
    } else if (q.type === 'multi') {
      const opts = q.options.filter((o) => o.trim() !== '');
      options = JSON.stringify(opts);
      const set = [...new Set((Array.isArray(q.correct) ? q.correct : []).map(Number))]
        .filter((ci) => Number.isInteger(ci) && ci >= 0 && ci < opts.length)
        .sort((a, b) => a - b);
      correct = JSON.stringify(set); // e.g. "[0,2]"
    } else if (q.type === 'truefalse') {
      correct = String(q.correct);
    }
    const points = Number(q.points) > 0 ? Number(q.points) : 1;
    const section = typeof q.section === 'string' ? q.section.trim().slice(0, 100) : '';
    const explanation = typeof q.explanation === 'string' ? q.explanation.trim() : '';
    await runFn(
      `INSERT INTO questions (test_id, type, prompt, options_json, correct_answer, image_url, points, position, section, explanation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [testId, q.type, q.prompt.trim(), options, correct, safeImageUrl(q.image), points, idx, section, explanation]
    );
  }
}

// Accepts a base64 data URL, saves it as an image file, returns its public URL.
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
app.post('/api/upload', requireAuth('teacher'), requireActiveSubscription, (req, res) => {
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
function readProctoring(body) {
  const proctored = body.proctored ? 1 : 0;
  const n = Math.round(Number(body.maxViolations));
  return { proctored, maxViolations: Number.isFinite(n) && n >= 1 ? n : 3 };
}

app.post('/api/tests', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!title) return res.status(400).json({ error: 'Test title is required.' });
  const invalid = validateQuestions(questions);
  if (invalid) return res.status(400).json({ error: invalid });
  const { negative_marking, penalty } = readMarking(req.body);
  const dueDate = readDueDate(req.body);
  const duration = readDuration(req.body);
  const { proctored, maxViolations } = readProctoring(req.body);

  const testId = await tx(async (t) => {
    const newId = (await t.run(
      'INSERT INTO tests (teacher_id, title, description, negative_marking, penalty, due_date, duration_minutes, proctored, max_violations) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [req.user.id, title, description, negative_marking, penalty, dueDate, duration, proctored, maxViolations]
    )).rows[0].id;
    await writeQuestions(t.run, newId, questions);
    return newId;
  });
  res.json({ id: testId });
}));

// Update an existing test — preserves past attempts by archiving answered questions.
app.put('/api/tests/:id', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
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
  const { proctored, maxViolations } = readProctoring(req.body);

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
      'UPDATE tests SET title = ?, description = ?, negative_marking = ?, penalty = ?, due_date = ?, duration_minutes = ?, proctored = ?, max_violations = ? WHERE id = ?',
      [title, description, negative_marking, penalty, dueDate, duration, proctored, maxViolations, test.id]
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

app.delete('/api/tests/:id', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  await run('DELETE FROM tests WHERE id = ?', [test.id]);
  res.json({ ok: true });
}));

// ============================================================================
// TEST DRAFTS  (auto-saved, resumable work-in-progress test creation)
// ============================================================================
app.get('/api/drafts', requireAuth('teacher'), h(async (req, res) => {
  const rows = await all('SELECT id, title, updated_at FROM test_drafts WHERE teacher_id = ? ORDER BY updated_at DESC', [req.user.id]);
  res.json({ drafts: rows.map((r) => ({ id: r.id, title: r.title || '', updatedAt: r.updated_at })) });
}));

app.post('/api/drafts', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const title = String(req.body.title || '').slice(0, 300);
  const data = typeof req.body.data === 'string' ? req.body.data : JSON.stringify(req.body.data || {});
  const id = (await run('INSERT INTO test_drafts (teacher_id, title, data) VALUES (?, ?, ?) RETURNING id', [req.user.id, title, data])).rows[0].id;
  res.json({ id });
}));

app.put('/api/drafts/:id', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const d = await get('SELECT id FROM test_drafts WHERE id = ? AND teacher_id = ?', [Number(req.params.id), req.user.id]);
  if (!d) return res.status(404).json({ error: 'Draft not found.' });
  const title = String(req.body.title || '').slice(0, 300);
  const data = typeof req.body.data === 'string' ? req.body.data : JSON.stringify(req.body.data || {});
  await run('UPDATE test_drafts SET title = ?, data = ?, updated_at = NOW() WHERE id = ?', [title, data, d.id]);
  res.json({ ok: true });
}));

app.get('/api/drafts/:id', requireAuth('teacher'), h(async (req, res) => {
  const d = await get('SELECT id, title, data FROM test_drafts WHERE id = ? AND teacher_id = ?', [Number(req.params.id), req.user.id]);
  if (!d) return res.status(404).json({ error: 'Draft not found.' });
  res.json({ id: d.id, title: d.title || '', data: d.data || '{}' });
}));

app.delete('/api/drafts/:id', requireAuth('teacher'), h(async (req, res) => {
  await run('DELETE FROM test_drafts WHERE id = ? AND teacher_id = ?', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
}));

// ============================================================================
// ASSIGNMENTS  (teacher assigns a test to students)
// ============================================================================
app.post('/api/assignments', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const testId = Number(req.body.test_id);
  const studentIds = Array.isArray(req.body.student_ids) ? req.body.student_ids.map(Number) : [];
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [testId, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  if (studentIds.length === 0) return res.status(400).json({ error: 'Select at least one student.' });

  let added = 0;
  await tx(async (t) => {
    for (const sid of studentIds) {
      const student = await t.get("SELECT id FROM users WHERE id = ? AND role = 'student' AND org_id = ?", [sid, req.user.org_id]);
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
    started: !!r.attempt_id && !r.submitted_at,
    needsGrading: !!r.needs_grading,
    score: r.submitted_at ? r.auto_score + r.manual_score : null,
    maxScore: r.max_score,
    dueDate: r.due_date,
    closed: isClosed(r.due_date),
  }));
  res.json({ assignments });
}));

// A student reviews their own submitted attempt (read-only): questions, their
// answers, the correct answers, and per-question marks.
app.get('/api/my-review/:assignmentId', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  const attempt = await get('SELECT * FROM attempts WHERE assignment_id = ? AND submitted_at IS NOT NULL', [a.id]);
  if (!attempt) return res.status(403).json({ error: 'You can review this test only after you submit it.' });
  const test = await get('SELECT title FROM tests WHERE id = ?', [a.test_id]);
  const items = (await all(
    `SELECT ans.response, ans.is_correct, ans.points_awarded,
            q.type, q.prompt, q.options_json, q.correct_answer, q.image_url, q.points, q.section, q.explanation
       FROM answers ans JOIN questions q ON q.id = ans.question_id
      WHERE ans.attempt_id = ? ORDER BY q.position`,
    [attempt.id]
  )).map((r) => ({
    type: r.type, prompt: r.prompt, section: r.section,
    options: JSON.parse(r.options_json), response: r.response,
    correctAnswer: r.correct_answer, isCorrect: r.is_correct,
    pointsAwarded: r.points_awarded, points: r.points, image: r.image_url,
    explanation: r.explanation,
  }));
  res.json({
    test: { title: test.title },
    score: attempt.auto_score + attempt.manual_score,
    maxScore: attempt.max_score,
    needsGrading: !!attempt.needs_grading,
    items,
  });
}));

// Fetch a test to take — WITHOUT correct answers.
app.get('/api/take/:assignmentId', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  let attempt = await get('SELECT * FROM attempts WHERE assignment_id = ?', [a.id]);
  if (attempt && attempt.submitted_at)
    return res.status(409).json({ error: 'You have already submitted this test.' });

  const test = await get('SELECT id, title, description, negative_marking, penalty, due_date, duration_minutes, proctored, max_violations FROM tests WHERE id = ?', [a.test_id]);
  if (isClosed(test.due_date))
    return res.status(403).json({ error: 'The deadline for this test has passed. You can no longer take it.' });

  // Ensure an in-progress attempt exists so answers/position can be saved and
  // resumed after a disconnect. For timed tests this also anchors the countdown.
  if (!attempt) {
    attempt = (await run(
      'INSERT INTO attempts (assignment_id, test_id, student_id) VALUES (?, ?, ?) RETURNING id, started_at, draft_answers, current_index',
      [a.id, a.test_id, req.user.id]
    )).rows[0];
  }
  let remainingSeconds = null;
  if (test.duration_minutes > 0) {
    const elapsed = (Date.now() - new Date(attempt.started_at).getTime()) / 1000;
    remainingSeconds = Math.max(0, Math.round(test.duration_minutes * 60 - elapsed));
  }
  let savedAnswers = {};
  try { const p = JSON.parse(attempt.draft_answers || '{}'); if (p && typeof p === 'object') savedAnswers = p; } catch { /* ignore */ }

  const questions = (await all(
    'SELECT id, type, prompt, options_json, image_url, points, section FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position',
    [a.test_id]
  )).map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, points: q.points, image: q.image_url, section: q.section, options: JSON.parse(q.options_json) }));
  res.json({ test, questions, durationMinutes: test.duration_minutes, remainingSeconds, savedAnswers, currentIndex: attempt.current_index || 0 });
}));

// Auto-save a student's in-progress answers + position (resume after disconnect).
app.post('/api/take/:assignmentId/progress', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  const attempt = await get('SELECT id, submitted_at FROM attempts WHERE assignment_id = ?', [a.id]);
  if (!attempt || attempt.submitted_at) return res.json({ ok: false });
  const answers = (req.body.answers && typeof req.body.answers === 'object') ? req.body.answers : {};
  const currentIndex = Math.max(0, Math.round(Number(req.body.currentIndex)) || 0);
  await run('UPDATE attempts SET draft_answers = ?, current_index = ? WHERE id = ?', [JSON.stringify(answers), currentIndex, attempt.id]);
  res.json({ ok: true });
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
  const violations = Math.max(0, Math.round(Number(req.body.violations)) || 0); // proctoring events

  let autoScore = 0;
  let maxScore = 0;
  let needsGrading = 0;
  const graded = [];
  const secOrder = [];               // section names in first-appearance order
  const secMap = {};                 // name -> { awarded, max, pending }
  for (const q of questions) {
    maxScore += q.points;
    const sec = q.section || '';
    if (!(sec in secMap)) { secMap[sec] = { awarded: 0, max: 0, pending: false }; secOrder.push(sec); }
    secMap[sec].max += q.points;
    const resp = responses[q.id] != null ? String(responses[q.id]) : '';
    let isCorrect = null;
    let awarded = 0;
    if (q.type === 'mcq' || q.type === 'truefalse') {
      const answered = resp !== '';
      isCorrect = answered && resp === q.correct_answer ? 1 : 0;
      if (isCorrect) awarded = q.points;
      else if (answered && test.negative_marking) awarded = -test.penalty;
      autoScore += awarded;
    } else if (q.type === 'multi') {
      // Response and stored answer are both JSON arrays of option indices.
      // All-or-nothing: full marks only when the chosen set exactly matches.
      const chosen = parseIndexSet(resp);
      const answered = chosen.length > 0;
      const key = parseIndexSet(q.correct_answer);
      const exact = answered && chosen.length === key.length && chosen.every((v, k) => v === key[k]);
      isCorrect = exact ? 1 : 0;
      if (isCorrect) awarded = q.points;
      else if (answered && test.negative_marking) awarded = -test.penalty;
      autoScore += awarded;
    } else {
      needsGrading = 1; // short answer — teacher grades later
      secMap[sec].pending = true;
    }
    secMap[sec].awarded += awarded;
    graded.push({ questionId: q.id, response: resp, isCorrect, awarded });
  }
  const sectionBreakdown = secOrder.map((name) => ({
    section: name, awarded: secMap[name].awarded, max: secMap[name].max, pending: secMap[name].pending,
  }));

  await tx(async (t) => {
    let attemptId;
    if (existing) {
      // Finalize the in-progress (timed) attempt.
      attemptId = existing.id;
      await t.run(
        'UPDATE attempts SET submitted_at = NOW(), auto_score = ?, manual_score = 0, max_score = ?, needs_grading = ?, violations = ? WHERE id = ?',
        [autoScore, maxScore, needsGrading, violations, attemptId]
      );
    } else {
      attemptId = (await t.run(
        `INSERT INTO attempts (assignment_id, test_id, student_id, submitted_at, auto_score, manual_score, max_score, needs_grading, violations)
         VALUES (?, ?, ?, NOW(), ?, 0, ?, ?, ?) RETURNING id`,
        [a.id, a.test_id, req.user.id, autoScore, maxScore, needsGrading, violations]
      )).rows[0].id;
    }
    for (const g of graded) {
      await t.run(
        'INSERT INTO answers (attempt_id, question_id, response, is_correct, points_awarded) VALUES (?, ?, ?, ?, ?)',
        [attemptId, g.questionId, g.response, g.isCorrect, g.awarded]
      );
    }
  });
  res.json({ autoScore, maxScore, needsGrading: !!needsGrading, sectionBreakdown });
}));

// ============================================================================
// RESULTS + GRADING  (teacher)
// ============================================================================
app.get('/api/tests/:id/results', requireAuth('teacher'), h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const rows = await all(
    `SELECT at.id AS attempt_id, u.name, u.email, at.submitted_at,
            at.auto_score, at.manual_score, at.max_score, at.needs_grading, at.violations
       FROM attempts at JOIN users u ON u.id = at.student_id
      WHERE at.test_id = ? AND at.submitted_at IS NOT NULL
      ORDER BY at.submitted_at DESC`,
    [test.id]
  );
  res.json({
    proctored: !!test.proctored,
    results: rows.map((r) => ({
      attemptId: r.attempt_id,
      name: r.name,
      email: r.email,
      submittedAt: r.submitted_at,
      score: r.auto_score + r.manual_score,
      maxScore: r.max_score,
      needsGrading: !!r.needs_grading,
      violations: r.violations || 0,
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
            q.id AS question_id, q.type, q.prompt, q.options_json, q.correct_answer, q.image_url, q.points, q.section, q.explanation
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
    section: r.section,
    options: JSON.parse(r.options_json),
    correctAnswer: r.correct_answer,
    image: r.image_url,
    points: r.points,
    explanation: r.explanation,
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
      violations: attempt.violations || 0,
    },
    items,
  });
}));

// Teacher grades short answers: { grades: { answerId: points } }
app.post('/api/attempts/:attemptId/grade', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
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

// --- Static files (React build) ----------------------------------------------
const CLIENT_DIST = path.join(__dirname, 'client', 'dist');
// Uploaded question images.
app.use('/uploads', express.static(UPLOAD_DIR));
// The built React app (hashed assets are safe to cache).
app.use(express.static(CLIENT_DIST));
// SPA fallback: any non-API, non-uploads GET returns index.html so client-side
// routing works on refresh/deep links.
app.get(/^(?!\/api\/|\/uploads\/).*/, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

// JSON error handler (async route rejections land here).
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// On first boot in a fresh environment, create the platform admin from
// ADMIN_EMAIL / ADMIN_PASSWORD (and optional ADMIN_NAME). Idempotent: if an
// account with that email already exists, it is left untouched — so a redeploy
// never resets the password. Change the password in-app afterwards.
async function seedAdminFromEnv() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  if (await get('SELECT id FROM users WHERE email = ?', [email])) return;
  await run('INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)', [
    'admin', (process.env.ADMIN_NAME || 'Administrator').trim(), email, hashPassword(password),
  ]);
  console.log('Seeded platform admin from environment:', email);
}

await init();
await seedAdminFromEnv();
app.listen(PORT, () => {
  console.log(`\n  Online Test Platform running at:  http://localhost:${PORT}\n`);
});
