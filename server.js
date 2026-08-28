import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
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

// Security headers. CSP is intentionally left off for now: the SPA relies on
// inline styles and self-hosted MathLive/KaTeX worker & font assets, so a
// default policy would break it. Every other helmet protection still applies
// (HSTS, X-Content-Type-Options, frameguard, referrer policy, ...).
app.use(helmet({ contentSecurityPolicy: false }));

// --- Rate limiting: basic DoS + brute-force protection ----------------------
// Disabled in the automated test run (which bursts thousands of requests from
// one IP) via DISABLE_RATE_LIMIT=1.
const rlSkip = () => process.env.DISABLE_RATE_LIMIT === '1';
// A generous per-IP ceiling on ALL API traffic — absorbs floods/scraping while
// staying well above what a busy institute (many students behind one shared IP)
// needs. Tune `max` up if a large campus hits it during a live test.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, skip: rlSkip,
  message: { error: 'Too many requests — please slow down and try again in a moment.' },
});
app.use('/api', apiLimiter);

// Larger limit so base64-encoded question images fit in the JSON body.
app.use(express.json({ limit: '8mb' }));

// Stricter limit on sign-in to blunt password brute-forcing. Keyed by the
// email being tried (NOT the IP), so a shared-IP computer lab where 40 students
// each log in once is unaffected, while thousands of guesses at one account are
// throttled.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, skip: rlSkip,
  keyGenerator: (req) => String(req.body?.email || '').trim().toLowerCase() || 'anon',
  message: { error: 'Too many sign-in attempts for this account. Please wait a few minutes and try again.' },
});

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
    // A student may belong to several organizations; per-org access (expiry /
    // disable) is enforced per membership at the assignment/take level, so the
    // account stays logged in even if one org's membership has lapsed.
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

// The platform-level root admin.
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only the root admin can do that.' });
  next();
}

// A support-team agent (works the ticket queue).
function requireSupport(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.user.role !== 'support') return res.status(403).json({ error: 'Support access only.' });
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

// Record an org-scoped audit entry. Best-effort: never breaks the request.
// Turn a list of names into readable prose: "Pratik", "Pratik and Aisha",
// "Pratik, Aisha and 3 others". Keeps the audit details human, not a raw count.
function namesList(names, max = 3) {
  const clean = names.map((n) => String(n || '').trim()).filter(Boolean);
  if (clean.length === 0) return 'no one';
  if (clean.length === 1) return clean[0];
  if (clean.length <= max) return clean.slice(0, -1).join(', ') + ' and ' + clean[clean.length - 1];
  const rest = clean.length - max;
  return clean.slice(0, max).join(', ') + ` and ${rest} other${rest === 1 ? '' : 's'}`;
}

// Produce a list of human phrases describing what changed between two test states,
// e.g. ["Renamed to \"Physics Final\"", "Added Physics section", "Added 2 questions"].
function describeTestChanges({ old, now }) {
  const out = [];
  if (now.title !== old.title) out.push(`Renamed to "${now.title}"`);
  if (now.description !== old.description) out.push(now.description ? 'Updated description' : 'Cleared description');
  if (now.dueDate !== old.dueDate) out.push(now.dueDate ? `Changed deadline to ${now.dueDate}` : 'Removed deadline');
  if (now.startsAt !== old.startsAt) out.push(now.startsAt ? `Set start date to ${now.startsAt}` : 'Removed start date');
  if (now.requiresSlot !== old.requiresSlot) out.push(now.requiresSlot ? 'Enabled slot booking' : 'Disabled slot booking');
  else if (now.requiresSlot && now.slotCount !== old.slotCount) out.push(`Changed to ${now.slotCount} time slot${now.slotCount === 1 ? '' : 's'}`);
  if (now.duration !== old.duration) out.push(now.duration ? `Set timer to ${now.duration} min` : 'Removed timer');
  if (now.negative_marking !== old.negative_marking || now.penalty !== old.penalty)
    out.push(now.negative_marking ? `Enabled negative marking (${now.penalty})` : 'Disabled negative marking');
  if (now.proctored !== old.proctored)
    out.push(now.proctored ? `Enabled proctoring (max ${now.maxViolations} violations)` : 'Disabled proctoring');
  else if (now.proctored && now.maxViolations !== old.maxViolations)
    out.push(`Changed proctoring limit to ${now.maxViolations} violations`);

  // Section changes: which section names appeared or disappeared.
  const sectionsOf = (qs) => new Set(qs.map((q) => String(q.section || '').trim()).filter(Boolean));
  const oldSecs = sectionsOf(old.questions), nowSecs = sectionsOf(now.questions);
  for (const s of nowSecs) if (!oldSecs.has(s)) out.push(`Added ${s} section`);
  for (const s of oldSecs) if (!nowSecs.has(s)) out.push(`Removed ${s} section`);

  // Question count change (or, if the count is unchanged, whether their text changed).
  const delta = now.questions.length - old.questions.length;
  if (delta > 0) out.push(`Added ${delta} question${delta === 1 ? '' : 's'}`);
  else if (delta < 0) out.push(`Removed ${-delta} question${-delta === 1 ? '' : 's'}`);
  else {
    const promptsOf = (qs) => qs.map((q) => String(q.prompt || '').trim());
    const oldP = promptsOf(old.questions).join(' '), nowP = promptsOf(now.questions).join(' ');
    if (oldP !== nowP) out.push('Edited questions');
  }

  return out;
}

async function logAudit(req, { action, entityType = '', entityId = null, entityLabel = '', details = '' }) {
  try {
    if (!req.user || req.user.org_id == null) return;
    await run(
      'INSERT INTO audit_logs (org_id, actor_id, actor_name, action, entity_type, entity_id, entity_label, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.org_id, req.user.id, req.user.name || '', action, entityType, entityId, String(entityLabel).slice(0, 200), String(details).slice(0, 500)]
    );
  } catch (e) { console.error('audit log failed:', e.message); }
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
// Admin-only: create a new organization and its root teacher in one step.
// There is deliberately NO public/self-service org sign-up — only a platform
// admin can create organizations. (Does not log the new teacher in; the admin
// hands over the credentials, or the teacher logs in themselves afterward.)
app.post('/api/register-teacher', requireAdmin, h(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are all required.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await get('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(409).json({ error: 'An account with that email already exists.' });

  const { newId, orgId } = await tx(async (t) => {
    const oid = (await t.run(
      "INSERT INTO organizations (name, plan_id) VALUES (?, (SELECT id FROM plans WHERE name = 'Free')) RETURNING id",
      [`${name}'s Organization`]
    )).rows[0].id;
    const uid = (await t.run(
      'INSERT INTO users (role, name, email, password_hash, is_root, org_id) VALUES (?, ?, ?, ?, 1, ?) RETURNING id',
      ['teacher', name, email, hashPassword(password), oid]
    )).rows[0].id;
    return { newId: uid, orgId: oid };
  });
  res.json({ user: { id: newId, role: 'teacher', name, email, isRoot: true, orgId } });
}));

app.post('/api/login', loginLimiter, h(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = await get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password.' });
  if (user.disabled)
    return res.status(403).json({ error: 'Your account has been disabled. Please contact your teacher.' });
  // A student's access is now per-organization; it's enforced per membership when
  // they view/take a test, not at login — so a lapse in one org doesn't lock them out.
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
  // A student may belong to multiple organizations, so an existing student email
  // is fine — we only block a duplicate WITHIN THIS organization. A teacher/admin
  // account with that email is still a clash.
  if (await get("SELECT id FROM users WHERE email = ? AND role IN ('teacher','admin')", [email]))
    return res.status(409).json({ error: 'That email belongs to a teacher or admin account.' });
  if (await get("SELECT id FROM signup_tokens WHERE email = ? AND org_id = ? AND invite_role = 'student'", [email, req.user.org_id]))
    return res.status(409).json({ error: 'That student is already in your organization (or has a pending invite).' });

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
  await logAudit(req, { action: 'student.create', entityType: 'student', entityLabel: name, details: email });
  res.json({ token, signupPath: `/signup?token=${token}` });
}));

// Bulk-add students from a parsed CSV: creates an invite per valid row, enforces
// the plan cap, and reports what was created vs. skipped (with reasons).
app.post('/api/students/bulk', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const rows = Array.isArray(req.body.students) ? req.body.students : [];
  if (rows.length === 0) return res.status(400).json({ error: 'No students found in the file.' });
  if (rows.length > 1000) return res.status(400).json({ error: 'Please import at most 1000 students at a time.' });

  const plan = await get('SELECT p.max_students FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = ?', [req.user.org_id]);
  const cap = plan && plan.max_students != null ? plan.max_students : null;
  let used = (await get("SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [req.user.org_id])).c;

  const created = [], skipped = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const name = (rows[i].name || '').trim();
    const email = (rows[i].email || '').trim().toLowerCase();
    const phone = (rows[i].phone || '').trim();
    const accessUntil = readAccessUntil(rows[i]);
    const label = name || email || `Row ${i + 1}`;
    if (!name || !email) { skipped.push({ label, reason: 'Name and email are required' }); continue; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { skipped.push({ label, reason: 'Invalid email address' }); continue; }
    if (!phone || !/^[\d+()\-\s]{6,20}$/.test(phone)) { skipped.push({ label, reason: 'Missing or invalid phone number' }); continue; }
    if (seen.has(email)) { skipped.push({ label, reason: 'Duplicate row in the file' }); continue; }
    if (cap != null && used >= cap) { skipped.push({ label, reason: `Plan limit reached (${cap} students)` }); continue; }
    if (await get("SELECT id FROM users WHERE email = ? AND role IN ('teacher','admin')", [email])) { skipped.push({ label, reason: 'Email belongs to a teacher/admin account' }); continue; }
    if (await get("SELECT id FROM signup_tokens WHERE email = ? AND org_id = ? AND invite_role = 'student'", [email, req.user.org_id])) { skipped.push({ label, reason: 'Already in your organization' }); continue; }
    const token = randomToken();
    await run('INSERT INTO signup_tokens (token, name, email, phone, access_until, org_id, teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [token, name, email, phone, accessUntil, req.user.org_id, req.user.id]);
    seen.add(email);
    used += 1;
    created.push({ name, email, signupPath: `/signup?token=${token}` });
  }
  if (created.length) await logAudit(req, { action: 'student.create', entityType: 'student', entityLabel: `${created.length} students`, details: `Bulk import (${created.length} added, ${skipped.length} skipped)` });
  res.json({ created, skipped });
}));

// List this teacher's students + pending invites.
app.get('/api/students', requireAuth('teacher'), h(async (req, res) => {
  const q = (req.query.q || '').trim();
  // Students belong to the organization, so every teacher in the org sees them all.
  const base =
    `SELECT t.id AS token_id, t.name, t.email, t.phone, t.access_until, t.token, t.used, t.student_id, t.disabled
       FROM signup_tokens t
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
    `SELECT t.name, t.email, t.phone, t.access_until, t.used, t.disabled,
            to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM signup_tokens t
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

// Enable/disable a student WITHIN THIS organization only (per-membership). The
// student stays logged in and keeps access to their other orgs; a disabled
// membership just hides this org's tests. :id is the student's user id.
app.patch('/api/students/:id', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const studentId = Number(req.params.id);
  const m = await get(
    `SELECT st.id AS token_id, u.name, u.email
       FROM signup_tokens st JOIN users u ON u.id = st.student_id
      WHERE st.student_id = ? AND st.org_id = ? AND st.invite_role = 'student'`,
    [studentId, req.user.org_id]
  );
  if (!m) return res.status(404).json({ error: 'Student not found.' });
  const disabled = req.body.disabled ? 1 : 0;
  await run('UPDATE signup_tokens SET disabled = ? WHERE id = ?', [disabled, m.token_id]);
  await logAudit(req, { action: disabled ? 'student.disable' : 'student.enable', entityType: 'student', entityId: studentId, entityLabel: m.name, details: m.email });
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

  // access_until is per-organization (on the membership); name/phone are the
  // shared profile, kept in sync so assignment lists show the right name.
  await run('UPDATE signup_tokens SET name = ?, phone = ?, access_until = ? WHERE id = ?',
    [name, phone, accessUntil, tok.id]);
  if (tok.student_id) {
    await run('UPDATE users SET name = ?, phone = ? WHERE id = ?', [name, phone, tok.student_id]);
  }
  res.json({ ok: true });
}));

// Teacher generates a password-reset link for one of their students.
app.post('/api/students/:id/reset-link', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const studentId = Number(req.params.id);
  const owned = await get(
    "SELECT 1 FROM signup_tokens WHERE student_id = ? AND org_id = ? AND invite_role = 'student' AND used = 1",
    [studentId, req.user.org_id]
  );
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
  await logAudit(req, { action: 'teacher.create', entityType: 'teacher', entityLabel: name, details: makeRoot ? `${email} (root)` : email });
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
    "INSERT INTO organizations (name, plan_id) VALUES (?, (SELECT id FROM plans WHERE name = 'Free')) RETURNING id",
    [name]
  )).rows[0].id;
  res.json({ id, name });
}));

// List the available pricing plans.
// ---- Billing periods (subscription renewal) --------------------------------
const BILLING_PERIODS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
const isPeriod = (p) => Object.prototype.hasOwnProperty.call(BILLING_PERIODS, p);
// Price for a plan on a given period. An admin can set an explicit (discounted)
// per-period price; when it's 0 the price is derived as monthly × months.
function periodPrice(plan, period) {
  const months = BILLING_PERIODS[period];
  if (!months) return null;
  const explicit = { quarterly: plan.price_quarterly, half_yearly: plan.price_half_yearly, yearly: plan.price_yearly }[period];
  if (period !== 'monthly' && explicit > 0) return explicit;
  return (plan.price_monthly || 0) * months;
}
// All period prices for a plan, for the renewal UI.
function planPricing(plan) {
  const out = {};
  for (const p of Object.keys(BILLING_PERIODS)) out[p] = plan == null || plan.price_monthly == null ? null : periodPrice(plan, p);
  return out;
}
// Extend a subscription by `months` from the later of today or the current
// expiry, returned as a YYYY-MM-DD string.
function extendExpiry(currentExpiry, months) {
  const now = new Date();
  const cur = currentExpiry ? new Date(currentExpiry) : null;
  const base = cur && !isNaN(cur) && cur.getTime() > now.getTime() ? cur : now;
  const d = new Date(base.getTime());
  d.setMonth(d.getMonth() + months);
  // Format from local date parts (not toISOString, which shifts to UTC and can
  // land a day earlier than the client's preview).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const PLAN_COLS = 'p.id, p.name, p.max_students, p.price_monthly, p.price_quarterly, p.price_half_yearly, p.price_yearly, p.sort_order';

app.get('/api/plans', requireAdmin, h(async (req, res) => {
  const plans = await all(
    `SELECT ${PLAN_COLS},
            (SELECT COUNT(*) FROM organizations o WHERE o.plan_id = p.id) AS org_count
       FROM plans p ORDER BY p.sort_order, p.id`
  );
  res.json({ plans: plans.map((p) => ({ ...p, pricing: planPricing(p) })) });
}));

// Validate + normalize a plan payload from the admin plan editor.
function readPlanBody(body) {
  const name = String(body.name || '').trim();
  const unlimited = body.unlimited === true;
  const maxStudents = unlimited ? null : Math.round(Number(body.maxStudents));
  const price = Math.round(Number(body.priceMonthly));
  const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Math.round(Number(body.sortOrder)) : 0;
  // Optional per-period prices (0 / blank = derive from monthly).
  const nn = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const priceQuarterly = nn(body.priceQuarterly);
  const priceHalfYearly = nn(body.priceHalfYearly);
  const priceYearly = nn(body.priceYearly);
  if (!name) return { error: 'Plan name is required.' };
  if (!unlimited && (!Number.isFinite(maxStudents) || maxStudents < 1)) return { error: 'Student cap must be a positive number (or mark the plan Unlimited).' };
  if (!Number.isFinite(price) || price < 0) return { error: 'Price must be 0 or more (in rupees per month).' };
  return { name, maxStudents, price, sortOrder, priceQuarterly, priceHalfYearly, priceYearly };
}

// Admin creates a pricing plan.
app.post('/api/plans', requireAdmin, h(async (req, res) => {
  const p = readPlanBody(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  if (await get('SELECT id FROM plans WHERE LOWER(name) = LOWER(?)', [p.name]))
    return res.status(409).json({ error: 'A plan with that name already exists.' });
  const id = (await run(
    'INSERT INTO plans (name, max_students, price_monthly, sort_order, price_quarterly, price_half_yearly, price_yearly) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [p.name, p.maxStudents, p.price, p.sortOrder, p.priceQuarterly, p.priceHalfYearly, p.priceYearly]
  )).rows[0].id;
  res.json({ id });
}));

// Admin edits a pricing plan.
app.put('/api/plans/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await get('SELECT id FROM plans WHERE id = ?', [id]))) return res.status(404).json({ error: 'Plan not found.' });
  const p = readPlanBody(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  if (await get('SELECT id FROM plans WHERE LOWER(name) = LOWER(?) AND id <> ?', [p.name, id]))
    return res.status(409).json({ error: 'A plan with that name already exists.' });
  await run('UPDATE plans SET name = ?, max_students = ?, price_monthly = ?, sort_order = ?, price_quarterly = ?, price_half_yearly = ?, price_yearly = ? WHERE id = ?',
    [p.name, p.maxStudents, p.price, p.sortOrder, p.priceQuarterly, p.priceHalfYearly, p.priceYearly, id]);
  res.json({ ok: true });
}));

// Admin deletes a plan — blocked while any organization is still on it.
app.delete('/api/plans/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await get('SELECT id FROM plans WHERE id = ?', [id]))) return res.status(404).json({ error: 'Plan not found.' });
  const inUse = (await get('SELECT COUNT(*) AS c FROM organizations WHERE plan_id = ?', [id])).c;
  if (inUse > 0) return res.status(409).json({ error: `${inUse} organization(s) are on this plan. Reassign them to another plan first.` });
  await run('DELETE FROM plans WHERE id = ?', [id]);
  res.json({ ok: true });
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

// A teacher views their own organization's current plan, usage, all plans, and
// the current subscription expiry (for the renewal flow).
app.get('/api/my-org/plan', requireAuth('teacher'), h(async (req, res) => {
  const org = await get(
    `SELECT o.subscription_expires_at, o.subscription_period, o.subscription_term_price, o.credit_balance, ${PLAN_COLS}
       FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = ?`,
    [req.user.org_id]
  );
  const plan = org && org.id ? { id: org.id, name: org.name, max_students: org.max_students, price_monthly: org.price_monthly, price_quarterly: org.price_quarterly, price_half_yearly: org.price_half_yearly, price_yearly: org.price_yearly, pricing: planPricing(org) } : null;
  const studentCount = (await get(
    "SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [req.user.org_id]
  )).c;
  const plans = (await all(`SELECT ${PLAN_COLS} FROM plans p ORDER BY p.sort_order`)).map((p) => ({ ...p, pricing: planPricing(p) }));
  res.json({
    plan, studentCount, plans,
    subscriptionUntil: org ? (org.subscription_expires_at || '') : '',
    subscriptionPeriod: org ? (org.subscription_period || '') : '',
    subscriptionTermPrice: org ? (org.subscription_term_price || 0) : 0,
    creditBalance: org ? (org.credit_balance || 0) : 0,
    subscriptionExpired: isExpired(org && org.subscription_expires_at),
  });
}));

// A root teacher subscribes their organization to a different plan (self-service).
app.post('/api/my-org/plan', requireRoot, h(async (req, res) => {
  const planId = Number(req.body.planId);
  const plan = await get('SELECT id, name, max_students FROM plans WHERE id = ?', [planId]);
  if (!plan) return res.status(400).json({ error: 'Invalid plan.' });
  // Unlimited plans are custom/negotiated — not self-serve. Contact required.
  if (plan.max_students == null)
    return res.status(403).json({ error: 'That’s a custom plan — please contact us to set it up for your organization.' });
  const studentCount = (await get(
    "SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [req.user.org_id]
  )).c;
  if (plan.max_students != null && studentCount > plan.max_students)
    return res.status(400).json({ error: `Your organization has ${studentCount} students, but the ${plan.name} plan supports up to ${plan.max_students}. Remove students or choose a larger plan.` });
  await run('UPDATE organizations SET plan_id = ? WHERE id = ?', [planId, req.user.org_id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// PAYMENT INTEGRATION SEAM.
// When a payment gateway (e.g. Razorpay) is added, this is where a renewal
// payment is verified before the subscription is extended:
//   1. A separate endpoint creates a payment order for the chosen plan+period.
//   2. The gateway's checkout collects payment on the client.
//   3. This function verifies the signed payment reference server-side.
// Until that exists, PAYMENTS_ENABLED is off and renewal proceeds directly
// (a manual/complimentary renewal, recorded in the audit log). Set the env var
// PAYMENTS_ENABLED=1 only once real verification is wired in below.
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === '1';
async function verifyRenewalPayment(/* req, plan, period */) {
  if (!PAYMENTS_ENABLED) return { ok: true, manual: true };
  // TODO: verify req.body.paymentRef against the gateway (signature + amount).
  return { ok: false, error: 'Payment verification is not configured yet.' };
}

// Days between now and a YYYY-MM-DD expiry (0 if past/empty).
function daysUntil(dateStr) {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
}
// Nominal length of a billing period in days (30-day months).
function periodDays(period) { return (BILLING_PERIODS[period] || 1) * 30; }

// Period-aware proration for a mid-cycle plan change. Credits the unused value
// of the CURRENT term (at the price actually paid, including any discount) and
// charges the same fraction of the NEW plan's price for the same period — so
// the renewal date is preserved and the customer neither loses nor gains money.
//   org needs: subscription_expires_at, subscription_period, subscription_term_price,
//              and the current plan price columns (cur_monthly, cur_q, cur_h, cur_y).
function computeProration(org, newPlan) {
  const period = org.subscription_period && isPeriod(org.subscription_period) ? org.subscription_period : 'monthly';
  const pDays = periodDays(period);
  const daysRemaining = Math.min(pDays, daysUntil(org.subscription_expires_at));
  const fraction = pDays > 0 ? daysRemaining / pDays : 0;
  const curPlanForPrice = { price_monthly: org.cur_monthly, price_quarterly: org.cur_q, price_half_yearly: org.cur_h, price_yearly: org.cur_y };
  const oldTermPrice = org.subscription_term_price > 0 ? org.subscription_term_price : (periodPrice(curPlanForPrice, period) || 0);
  const newTermPrice = periodPrice(newPlan, period) || 0;
  const credit = Math.round(oldTermPrice * fraction); // unused value of the current term
  const charge = Math.round(newTermPrice * fraction);  // new plan for the remaining term
  return { period, daysRemaining, fraction, oldTermPrice, newTermPrice, credit, charge };
}

// Append a billing-ledger row and return the resulting balance.
async function recordTxn(t, orgId, { kind, planName, period, charged, credit, balanceAfter, expiresAt, note, actorName }) {
  await t.run(
    `INSERT INTO subscription_transactions (org_id, kind, plan_name, period, charged, credit, balance_after, expires_at, note, actor_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, kind, planName || '', period || '', charged || 0, credit || 0, balanceAfter || 0, expiresAt || '', note || '', actorName || '']
  );
}

// A root teacher changes plan and/or renews their subscription. Three modes:
//  - change  : switching plan while the subscription is still ACTIVE → the new
//              plan (and its student cap) applies immediately, the renewal date
//              is UNCHANGED, and a prorated top-up covers the remaining days.
//  - subscribe: switching plan while expired/none → a fresh term for `period`.
//  - renew   : same plan (no planId) → extend by `period` from the current expiry.
// `period` (monthly|quarterly|half_yearly|yearly) is required for subscribe/renew.
app.post('/api/my-org/renew', requireRoot, h(async (req, res) => {
  const org = await get(
    `SELECT o.id, o.name, o.plan_id, o.subscription_expires_at, o.subscription_period, o.subscription_term_price, o.credit_balance,
            p.name AS plan_name, p.max_students AS cur_cap, p.price_monthly AS cur_monthly,
            p.price_quarterly AS cur_q, p.price_half_yearly AS cur_h, p.price_yearly AS cur_y
       FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = ?`,
    [req.user.org_id]
  );
  if (!org) return res.status(404).json({ error: 'Organization not found.' });
  const active = !!org.subscription_expires_at && !isExpired(org.subscription_expires_at);
  const balance = org.credit_balance || 0;
  const targetPlanId = req.body.planId ? Number(req.body.planId) : null;
  const switching = targetPlanId && targetPlanId !== org.plan_id;

  async function loadTargetPlan() {
    const np = await get(`SELECT ${PLAN_COLS} FROM plans p WHERE p.id = ?`, [targetPlanId]);
    if (!np) return { error: 'Invalid plan.', code: 400 };
    if (np.max_students == null) return { error: 'That’s a custom plan — please contact us to set it up for your organization.', code: 403 };
    const studentCount = (await get("SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [org.id])).c;
    if (studentCount > np.max_students)
      return { error: `Your organization has ${studentCount} students, but the ${np.name} plan supports up to ${np.max_students}. Remove students or choose a larger plan.`, code: 400 };
    return { np };
  }

  // ---- Mode: mid-cycle plan change — credit the unused term, then either keep the
  //      renewal date (same billing period) or start a fresh term (different period) ----
  if (switching && active) {
    const t = await loadTargetPlan();
    if (t.error) return res.status(t.code).json({ error: t.error });
    const pr = computeProration(org, t.np); // pr.credit = unused value of the CURRENT term; pr.period = current period
    const chosenPeriod = req.body.period ? String(req.body.period) : pr.period;
    if (!isPeriod(chosenPeriod)) return res.status(400).json({ error: 'Choose a valid billing period.' });
    const pay = await verifyRenewalPayment(req, t.np, 'change');
    if (!pay.ok) return res.status(402).json({ error: pay.error });
    const upgrade = (t.np.price_monthly || 0) > (org.cur_monthly || 0);
    const samePeriod = chosenPeriod === pr.period;
    const credit = pr.credit; // unused value of the current prepaid term (always credited back)
    // Same cadence → keep the renewal date, prorate the new plan for the remaining days.
    // New cadence → start a fresh term today at the new plan's full period price.
    const charge = samePeriod ? pr.charge : (periodPrice(t.np, chosenPeriod) || 0);
    const newTermPrice = samePeriod ? pr.newTermPrice : charge;
    const newExpiry = samePeriod ? org.subscription_expires_at : extendExpiry('', BILLING_PERIODS[chosenPeriod]);
    const dueAfterTermCredit = Math.max(0, charge - credit); // new cost minus unused-term credit
    const bankedCredit = Math.max(0, credit - charge);       // surplus credit → banked
    const balanceUsed = Math.min(balance, dueAfterTermCredit);
    const netPay = dueAfterTermCredit - balanceUsed;
    const newBalance = balance - balanceUsed + bankedCredit;
    await tx(async (tt) => {
      await tt.run(
        'UPDATE organizations SET plan_id = ?, subscription_period = ?, subscription_term_price = ?, subscription_expires_at = ?, credit_balance = ? WHERE id = ?',
        [targetPlanId, chosenPeriod, newTermPrice, newExpiry, newBalance, org.id]
      );
      await recordTxn(tt, org.id, {
        kind: upgrade ? 'upgrade' : 'downgrade', planName: t.np.name, period: chosenPeriod, charged: netPay,
        credit: (credit + balanceUsed) - bankedCredit, balanceAfter: newBalance, expiresAt: newExpiry,
        note: `${org.plan_name} → ${t.np.name}${samePeriod ? `, ${pr.daysRemaining} day(s) left` : `, new ${chosenPeriod} term`}${bankedCredit ? `; ₹${bankedCredit} credited to balance` : ''}`,
        actorName: req.user.name,
      });
    });
    await logAudit(req, {
      action: 'subscription.change', entityType: 'organization', entityId: org.id, entityLabel: org.name,
      details: `${upgrade ? 'Upgraded' : 'Changed'} ${org.plan_name} → ${t.np.name} (${chosenPeriod})${samePeriod ? `; renewal date unchanged (${newExpiry})` : `; new term → ${newExpiry}`}; charge ₹${charge} − credit ₹${credit} = pay ₹${netPay}${bankedCredit ? `; banked ₹${bankedCredit}` : ''}${pay.manual ? ' (manual — no gateway yet)' : ''}`,
    });
    return res.json({
      ok: true, mode: 'change', upgrade, planName: t.np.name, expiresAt: newExpiry,
      period: chosenPeriod, periodChanged: !samePeriod, daysRemaining: pr.daysRemaining, credit, charge,
      balanceUsed, bankedCredit, netPay, creditBalance: newBalance, manual: !!pay.manual, switched: true,
    });
  }

  // ---- Mode: fresh subscribe (expired) or renew (same plan) — needs a period ----
  const period = String(req.body.period || 'monthly');
  if (!isPeriod(period)) return res.status(400).json({ error: 'Choose a valid billing period.' });
  let planForPrice = { name: org.plan_name, price_monthly: org.cur_monthly, price_quarterly: org.cur_q, price_half_yearly: org.cur_h, price_yearly: org.cur_y };
  if (switching) {
    const t = await loadTargetPlan();
    if (t.error) return res.status(t.code).json({ error: t.error });
    planForPrice = t.np;
  }
  const pay = await verifyRenewalPayment(req, planForPrice, period);
  if (!pay.ok) return res.status(402).json({ error: pay.error });
  const termPrice = periodPrice(planForPrice, period) || 0;
  const balanceUsed = Math.min(balance, termPrice);
  const netPay = termPrice - balanceUsed;
  const newBalance = balance - balanceUsed;
  const newExpiry = extendExpiry(switching ? '' : org.subscription_expires_at, BILLING_PERIODS[period]);
  await tx(async (t) => {
    if (switching) await t.run('UPDATE organizations SET plan_id = ? WHERE id = ?', [targetPlanId, org.id]);
    await t.run('UPDATE organizations SET subscription_expires_at = ?, subscription_period = ?, subscription_term_price = ?, credit_balance = ? WHERE id = ?',
      [newExpiry, period, termPrice, newBalance, org.id]);
    await recordTxn(t, org.id, {
      kind: switching ? 'subscribe' : 'renew', planName: planForPrice.name, period, charged: netPay,
      credit: balanceUsed, balanceAfter: newBalance, expiresAt: newExpiry, note: '', actorName: req.user.name,
    });
  });
  await logAudit(req, {
    action: switching ? 'subscription.subscribe' : 'subscription.renew', entityType: 'organization', entityId: org.id, entityLabel: org.name,
    details: `${switching ? 'Subscribed' : 'Renewed'} ${planForPrice.name} (${period}${pay.manual ? ', manual — no gateway yet' : ''}) → expires ${newExpiry}; charge ₹${termPrice}${balanceUsed ? ` − credit ₹${balanceUsed}` : ''} = pay ₹${netPay}`,
  });
  res.json({ ok: true, mode: switching ? 'subscribe' : 'renew', planName: planForPrice.name, expiresAt: newExpiry, period, amount: termPrice, charged: netPay, balanceUsed, creditBalance: newBalance, manual: !!pay.manual, switched: !!switching });
}));

// A teacher views their organization's billing history (subscribe/renew/change).
app.get('/api/my-org/transactions', requireAuth('teacher'), h(async (req, res) => {
  const rows = await all(
    `SELECT kind, plan_name, period, charged, credit, balance_after, expires_at, note, actor_name, created_at
       FROM subscription_transactions WHERE org_id = ? ORDER BY id DESC LIMIT 50`,
    [req.user.org_id]
  );
  const bal = await get('SELECT credit_balance FROM organizations WHERE id = ?', [req.user.org_id]);
  res.json({ creditBalance: (bal && bal.credit_balance) || 0, transactions: rows });
}));

// List organizations with their teachers (signed up + pending) and counts.
// Optional ?q= filters by organization name (case-insensitive).
// Paginated, filterable summary list of organizations for the admin grid.
// Query params: q (name), plan (planId), status (active|expired|no_expiry|
// over_limit), page (1-based), pageSize. Teachers are NOT included here — the
// per-org detail endpoint returns those.
app.get('/api/orgs', requireAdmin, h(async (req, res) => {
  const q = (req.query.q || '').trim();
  const planFilter = Number(req.query.plan);
  const status = String(req.query.status || '').trim();
  const page = Math.max(1, Math.round(Number(req.query.page)) || 1);
  const pageSize = Math.min(50, Math.max(5, Math.round(Number(req.query.pageSize)) || 10));
  const today = new Date().toISOString().slice(0, 10);

  const params = [];
  const innerConds = ['1=1'];
  if (q) { innerConds.push("o.name ILIKE ? ESCAPE '\\'"); params.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); }
  if (Number.isFinite(planFilter) && planFilter > 0) { innerConds.push('o.plan_id = ?'); params.push(planFilter); }
  const inner = `
    SELECT o.id, o.name, o.plan_id, o.subscription_expires_at,
           p.name AS plan_name, p.max_students, p.price_monthly,
           (SELECT COUNT(*) FROM users u WHERE u.role = 'teacher' AND u.org_id = o.id) AS teacher_count,
           (SELECT COUNT(*) FROM signup_tokens st WHERE st.invite_role = 'student' AND st.org_id = o.id) AS student_count
      FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id
     WHERE ${innerConds.join(' AND ')}`;

  const outerConds = ['1=1'];
  if (status === 'expired') { outerConds.push("x.subscription_expires_at <> '' AND x.subscription_expires_at < ?"); params.push(today); }
  else if (status === 'active') { outerConds.push("x.subscription_expires_at <> '' AND x.subscription_expires_at >= ?"); params.push(today); }
  else if (status === 'no_expiry') { outerConds.push("x.subscription_expires_at = ''"); }
  else if (status === 'over_limit') { outerConds.push('x.max_students IS NOT NULL AND x.student_count > x.max_students'); }
  const filtered = `SELECT * FROM (${inner}) x WHERE ${outerConds.join(' AND ')}`;

  const total = (await get(`SELECT COUNT(*) AS c FROM (${filtered}) y`, params)).c;
  const rows = await all(`${filtered} ORDER BY x.name LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const orgs = rows.map((o) => ({
    id: o.id, name: o.name, teacherCount: o.teacher_count, studentCount: o.student_count,
    planId: o.plan_id, planName: o.plan_name, maxStudents: o.max_students, priceMonthly: o.price_monthly,
    subscriptionUntil: o.subscription_expires_at || '', subscriptionExpired: isExpired(o.subscription_expires_at),
  }));
  res.json({ orgs, total, page, pageSize });
}));

// Full detail for one organization (incl. teachers) — the admin detail view.
app.get('/api/orgs/:id', requireAdmin, h(async (req, res) => {
  const o = await get(
    `SELECT o.id, o.name, o.plan_id, o.subscription_expires_at, p.name AS plan_name, p.max_students, p.price_monthly
       FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = ?`, [Number(req.params.id)]
  );
  if (!o) return res.status(404).json({ error: 'Organization not found.' });
  const signedUp = await all("SELECT id, name, email, phone, is_root, disabled FROM users WHERE role = 'teacher' AND org_id = ? ORDER BY id", [o.id]);
  const pending = await all("SELECT name, email, phone, is_root, token FROM signup_tokens WHERE invite_role = 'teacher' AND used = 0 AND org_id = ? ORDER BY created_at DESC", [o.id]);
  const studentCount = (await get("SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [o.id])).c;
  const teachers = [
    ...signedUp.map((u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, isRoot: !!u.is_root, disabled: !!u.disabled, signedUp: true, signupPath: null })),
    ...pending.map((p) => ({ id: null, name: p.name, email: p.email, phone: p.phone, isRoot: !!p.is_root, disabled: false, signedUp: false, signupPath: `/signup?token=${p.token}` })),
  ];
  res.json({
    org: {
      id: o.id, name: o.name, teachers, teacherCount: signedUp.length, studentCount,
      planId: o.plan_id, planName: o.plan_name, maxStudents: o.max_students, priceMonthly: o.price_monthly,
      subscriptionUntil: o.subscription_expires_at || '', subscriptionExpired: isExpired(o.subscription_expires_at),
    },
  });
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
  // If someone already has an account with this email, they join by accepting
  // (logging in) rather than setting a new password.
  const existingAccount = !!(await get("SELECT id FROM users WHERE email = ?", [t.email]));
  const org = t.org_id ? await get('SELECT name FROM organizations WHERE id = ?', [t.org_id]) : null;
  res.json({ name: t.name, email: t.email, role: t.invite_role, isRoot: !!t.is_root, existingAccount, orgName: org ? org.name : null });
}));

// A logged-in student accepts an invite to join an additional organization.
app.post('/api/accept-invite/:token', requireAuth('student'), h(async (req, res) => {
  const t = await get('SELECT * FROM signup_tokens WHERE token = ?', [req.params.token]);
  if (!t) return res.status(404).json({ error: 'This invite link is invalid.' });
  if (t.used) return res.status(410).json({ error: 'This invite link has already been used.' });
  if (t.invite_role !== 'student') return res.status(400).json({ error: 'This invite is not for a student.' });
  if (t.email.toLowerCase() !== String(req.user.email).toLowerCase())
    return res.status(403).json({ error: 'This invite was sent to a different email address. Log in with that email to accept it.' });
  if (await get("SELECT id FROM signup_tokens WHERE email = ? AND org_id = ? AND invite_role = 'student' AND used = 1", [t.email, t.org_id]))
    return res.status(409).json({ error: "You're already a member of that organization." });
  await run('UPDATE signup_tokens SET used = 1, student_id = ? WHERE id = ?', [req.user.id, t.id]);
  res.json({ ok: true });
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

// Convert a builder-shape question into stored answer fields (drops blank
// choices and remaps the correct index/set). Used by the question bank.
function normalizeQuestion(q) {
  let options_json = '[]', correct_answer = '';
  if (q.type === 'mcq') {
    const kept = []; let correct = 0;
    (q.options || []).forEach((v, idx) => { if (String(v).trim() !== '') { if (idx === Number(q.correct)) correct = kept.length; kept.push(v); } });
    options_json = JSON.stringify(kept); correct_answer = String(correct);
  } else if (q.type === 'multi') {
    const kept = []; const arr = []; const chosen = new Set((Array.isArray(q.correct) ? q.correct : []).map(Number));
    (q.options || []).forEach((v, idx) => { if (String(v).trim() !== '') { if (chosen.has(idx)) arr.push(kept.length); kept.push(v); } });
    options_json = JSON.stringify(kept); correct_answer = JSON.stringify(arr);
  } else if (q.type === 'truefalse') {
    correct_answer = String(q.correct);
  }
  return {
    type: q.type, prompt: String(q.prompt || '').trim(), options_json, correct_answer,
    image_url: safeImageUrl(q.image), points: Number(q.points) > 0 ? Number(q.points) : 1,
    explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '',
  };
}

// ============================================================================
// QUESTION BANK  (organization-wide reusable questions)
// ============================================================================
app.get('/api/bank', requireAuth('teacher'), h(async (req, res) => {
  const q = (req.query.q || '').trim();
  const topic = (req.query.topic || '').trim();
  const type = (req.query.type || '').trim();
  const where = ['org_id = ?']; const args = [req.user.org_id];
  if (q) { where.push("prompt ILIKE ? ESCAPE '\\'"); args.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); }
  if (topic) { where.push('topic = ?'); args.push(topic); }
  if (['mcq', 'multi', 'truefalse', 'short'].includes(type)) { where.push('type = ?'); args.push(type); }
  const rows = await all(`SELECT * FROM bank_questions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, args);
  const topics = (await all("SELECT DISTINCT topic FROM bank_questions WHERE org_id = ? AND topic <> '' ORDER BY topic", [req.user.org_id])).map((r) => r.topic);
  res.json({
    questions: rows.map((r) => ({
      id: r.id, type: r.type, prompt: r.prompt, options: JSON.parse(r.options_json),
      correctAnswer: r.correct_answer, points: r.points, image: r.image_url,
      explanation: r.explanation, topic: r.topic, difficulty: r.difficulty,
    })),
    topics,
  });
}));

app.post('/api/bank', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const q = req.body || {};
  const invalid = validateQuestions([q]);
  if (invalid) return res.status(400).json({ error: invalid });
  const n = normalizeQuestion(q);
  const topic = String(q.topic || '').trim().slice(0, 100);
  const difficulty = String(q.difficulty || '').trim().slice(0, 20);
  const id = (await run(
    `INSERT INTO bank_questions (org_id, created_by, type, prompt, options_json, correct_answer, points, image_url, explanation, topic, difficulty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.org_id, req.user.id, n.type, n.prompt, n.options_json, n.correct_answer, n.points, n.image_url, n.explanation, topic, difficulty]
  )).rows[0].id;
  res.json({ id });
}));

app.put('/api/bank/:id', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const existing = await get('SELECT id FROM bank_questions WHERE id = ? AND org_id = ?', [Number(req.params.id), req.user.org_id]);
  if (!existing) return res.status(404).json({ error: 'Question not found.' });
  const q = req.body || {};
  const invalid = validateQuestions([q]);
  if (invalid) return res.status(400).json({ error: invalid });
  const n = normalizeQuestion(q);
  const topic = String(q.topic || '').trim().slice(0, 100);
  const difficulty = String(q.difficulty || '').trim().slice(0, 20);
  await run(
    'UPDATE bank_questions SET type = ?, prompt = ?, options_json = ?, correct_answer = ?, points = ?, image_url = ?, explanation = ?, topic = ?, difficulty = ? WHERE id = ?',
    [n.type, n.prompt, n.options_json, n.correct_answer, n.points, n.image_url, n.explanation, topic, difficulty, existing.id]
  );
  res.json({ ok: true });
}));

app.delete('/api/bank/:id', requireAuth('teacher'), h(async (req, res) => {
  await run('DELETE FROM bank_questions WHERE id = ? AND org_id = ?', [Number(req.params.id), req.user.org_id]);
  res.json({ ok: true });
}));

// ============================================================================
// AUDIT LOG  (organization-wide activity, teacher-visible for transparency)
// ============================================================================
app.get('/api/audit', requireAuth('teacher'), h(async (req, res) => {
  const q = (req.query.q || '').trim();
  const where = ['org_id = ?']; const args = [req.user.org_id];
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    where.push("(actor_name ILIKE ? ESCAPE '\\' OR entity_label ILIKE ? ESCAPE '\\' OR details ILIKE ? ESCAPE '\\' OR action ILIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const rows = await all(`SELECT * FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 300`, args);
  res.json({
    logs: rows.map((r) => ({
      id: r.id, at: r.created_at, actor: r.actor_name, action: r.action,
      entityType: r.entity_type, entityLabel: r.entity_label, details: r.details,
    })),
  });
}));

// ============================================================================
// SUPPORT TICKETS  (teachers raise; the support team resolves)
// ============================================================================
const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'normal', 'high'];
const ticketView = (t) => ({
  id: t.id, subject: t.subject, category: t.category, priority: t.priority, status: t.status,
  orgId: t.org_id, orgName: t.org_name || null, teacherName: t.teacher_name || null, teacherEmail: t.teacher_email || null,
  createdAt: t.created_at, updatedAt: t.updated_at, messageCount: t.message_count,
});
const messageView = (m) => ({ id: m.id, authorRole: m.author_role, authorName: m.author_name, body: m.body, image: m.image_url || '', at: m.created_at });

// --- Teacher: raise + track their own tickets ---
app.post('/api/tickets', requireAuth('teacher'), h(async (req, res) => {
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();
  const category = (req.body.category || 'Other').trim().slice(0, 60) || 'Other';
  const priority = TICKET_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal';
  const image = safeImageUrl(req.body.image);
  if (!subject) return res.status(400).json({ error: 'Please add a short subject.' });
  if (!message) return res.status(400).json({ error: 'Please describe the issue.' });
  const id = await tx(async (t) => {
    const tid = (await t.run(
      'INSERT INTO tickets (org_id, teacher_id, subject, category, priority) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [req.user.org_id, req.user.id, subject.slice(0, 200), category, priority]
    )).rows[0].id;
    await t.run(
      "INSERT INTO ticket_messages (ticket_id, author_id, author_role, author_name, body, image_url) VALUES (?, ?, 'teacher', ?, ?, ?)",
      [tid, req.user.id, req.user.name || '', message, image]
    );
    return tid;
  });
  res.json({ id });
}));

app.get('/api/tickets', requireAuth('teacher'), h(async (req, res) => {
  const rows = await all(
    `SELECT t.*, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
       FROM tickets t WHERE t.teacher_id = ? ORDER BY t.updated_at DESC`,
    [req.user.id]
  );
  res.json({ tickets: rows.map(ticketView) });
}));

app.get('/api/tickets/:id', requireAuth('teacher'), h(async (req, res) => {
  const t = await get('SELECT * FROM tickets WHERE id = ? AND teacher_id = ?', [Number(req.params.id), req.user.id]);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  const messages = await all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at', [t.id]);
  res.json({ ticket: ticketView({ ...t, message_count: messages.length }), messages: messages.map(messageView) });
}));

app.post('/api/tickets/:id/messages', requireAuth('teacher'), h(async (req, res) => {
  const body = (req.body.body || '').trim();
  const image = safeImageUrl(req.body.image);
  if (!body && !image) return res.status(400).json({ error: 'Message cannot be empty.' });
  const t = await get('SELECT * FROM tickets WHERE id = ? AND teacher_id = ?', [Number(req.params.id), req.user.id]);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  if (t.status === 'closed') return res.status(409).json({ error: 'This ticket is closed. Raise a new one if you still need help.' });
  await run("INSERT INTO ticket_messages (ticket_id, author_id, author_role, author_name, body, image_url) VALUES (?, ?, 'teacher', ?, ?, ?)",
    [t.id, req.user.id, req.user.name || '', body, image]);
  // A teacher reply reopens a resolved ticket so it comes back to the queue.
  const nextStatus = t.status === 'resolved' ? 'open' : t.status;
  await run('UPDATE tickets SET updated_at = NOW(), status = ? WHERE id = ?', [nextStatus, t.id]);
  res.json({ ok: true });
}));

// --- Support: the whole queue ---
const supportTicketRow = `SELECT t.*, o.name AS org_name, u.name AS teacher_name, u.email AS teacher_email,
       (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
       FROM tickets t LEFT JOIN organizations o ON o.id = t.org_id LEFT JOIN users u ON u.id = t.teacher_id`;

app.get('/api/support/tickets', requireSupport, h(async (req, res) => {
  const status = req.query.status;
  const where = TICKET_STATUSES.includes(status) ? 'WHERE t.status = ?' : '';
  const rows = await all(`${supportTicketRow} ${where} ORDER BY t.updated_at DESC LIMIT 300`,
    where ? [status] : []);
  const counts = {};
  for (const s of TICKET_STATUSES) counts[s] = 0;
  (await all('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status')).forEach((r) => { counts[r.status] = r.c; });
  res.json({ tickets: rows.map(ticketView), counts });
}));

app.get('/api/support/tickets/:id', requireSupport, h(async (req, res) => {
  const t = await get(`${supportTicketRow} WHERE t.id = ?`, [Number(req.params.id)]);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  const messages = await all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at', [t.id]);
  res.json({ ticket: ticketView(t), messages: messages.map(messageView) });
}));

app.post('/api/support/tickets/:id/messages', requireSupport, h(async (req, res) => {
  const body = (req.body.body || '').trim();
  const image = safeImageUrl(req.body.image);
  if (!body && !image) return res.status(400).json({ error: 'Message cannot be empty.' });
  const t = await get('SELECT * FROM tickets WHERE id = ?', [Number(req.params.id)]);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  await run("INSERT INTO ticket_messages (ticket_id, author_id, author_role, author_name, body, image_url) VALUES (?, ?, 'support', ?, ?, ?)",
    [t.id, req.user.id, req.user.name || 'Support', body, image]);
  // Replying to a brand-new ticket moves it into 'in_progress'.
  const nextStatus = t.status === 'open' ? 'in_progress' : t.status;
  await run('UPDATE tickets SET updated_at = NOW(), status = ? WHERE id = ?', [nextStatus, t.id]);
  res.json({ ok: true });
}));

app.patch('/api/support/tickets/:id', requireSupport, h(async (req, res) => {
  const status = req.body.status;
  const priority = req.body.priority;
  if (status !== undefined && !TICKET_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  if (priority !== undefined && !TICKET_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority.' });
  const t = await get('SELECT id FROM tickets WHERE id = ?', [Number(req.params.id)]);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  const sets = [], args = [];
  if (status !== undefined) { sets.push('status = ?'); args.push(status); }
  if (priority !== undefined) { sets.push('priority = ?'); args.push(priority); }
  if (!sets.length) return res.json({ ok: true });
  args.push(t.id);
  await run(`UPDATE tickets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, args);
  res.json({ ok: true });
}));

// --- Admin: manage support-team accounts ---
app.get('/api/support-agents', requireAdmin, h(async (req, res) => {
  const rows = await all("SELECT id, name, email FROM users WHERE role = 'support' ORDER BY id");
  res.json({ agents: rows });
}));
app.post('/api/support-agents', requireAdmin, h(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await get('SELECT id FROM users WHERE email = ?', [email])) return res.status(409).json({ error: 'A user with that email already exists.' });
  const id = (await run("INSERT INTO users (role, name, email, password_hash) VALUES ('support', ?, ?, ?) RETURNING id",
    [name, email, hashPassword(password)])).rows[0].id;
  res.json({ id, name, email });
}));

// Save a base64 data URL as an image file. Returns { url } or { status, error }.
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function saveDataUrlImage(dataUrl, maxBytes) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return { status: 400, error: 'Invalid image data.' };
  const ext = IMAGE_EXT[m[1].toLowerCase()];
  if (!ext) return { status: 400, error: 'Only PNG, JPG, GIF, or WebP images are allowed.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) return { status: 413, error: `Image must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller.` };
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: '/uploads/' + name };
}

app.post('/api/upload', requireAuth('teacher'), requireActiveSubscription, (req, res) => {
  const r = saveDataUrlImage(req.body.dataUrl, 5 * 1024 * 1024);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ url: r.url });
});

// Screenshot upload for support tickets: usable by teachers (even in read-only
// mode — they may need help precisely because something's broken) and support
// agents. Capped at 2 MB.
app.post('/api/ticket-upload', h(async (req, res) => {
  if (!req.user || !['teacher', 'support'].includes(req.user.role))
    return res.status(403).json({ error: 'Not allowed.' });
  const r = saveDataUrlImage(req.body.dataUrl, 2 * 1024 * 1024);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ url: r.url });
}));

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

// ---- Scheduled windows & booked time slots --------------------------------
// Optional start date — like readDueDate but for when a test opens.
function readStartDate(body) {
  const d = (body.startsAt || '').trim();
  if (!d) return '';
  return Number.isFinite(new Date(d).getTime()) ? d : '';
}
// Human-friendly rendering of a datetime-local string for error messages.
function fmtWhen(s) {
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return String(s || '');
  try {
    return new Date(t).toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return String(s || ''); }
}
// A slot's enter window tolerates internet issues: it opens 30 min before the
// slot and closes 30 min after the slot plus the test's full duration.
const SLOT_BUFFER_MS = 30 * 60 * 1000;
function slotWindow(slotAt, durationMinutes) {
  const start = new Date(slotAt).getTime();
  if (!Number.isFinite(start)) return null;
  const dur = (Number(durationMinutes) || 0) * 60 * 1000;
  return { openAt: start - SLOT_BUFFER_MS, closeAt: start + dur + SLOT_BUFFER_MS };
}
// True when a test has a start date that is still in the future.
function notYetOpen(startsAt) {
  if (!startsAt) return false;
  const t = new Date(startsAt).getTime();
  return Number.isFinite(t) && t > Date.now();
}
// Keep only valid slots ({ id?, at, capacity }); drop rows without a real date.
function normalizeSlots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    const at = String((s && s.at) || '').trim();
    if (!at || !Number.isFinite(new Date(at).getTime())) continue;
    const cap = Math.max(0, Math.round(Number(s.capacity)) || 0);
    const id = s && s.id ? Number(s.id) : null;
    out.push({ id: Number.isFinite(id) ? id : null, at, capacity: cap });
  }
  return out;
}
// Slot booking is optional, but when it's on the setup must make sense.
function validateSlotSetup(requiresSlot, slots, duration) {
  if (!requiresSlot) return null;
  if (!Array.isArray(slots) || slots.length === 0)
    return 'Add at least one time slot, or turn off slot booking for this test.';
  if (!(duration > 0))
    return 'Slot booking needs a time limit (duration) so each slot has a window.';
  return null;
}
// Reconcile a test's slots inside a transaction. Slots a student already booked
// are never deleted (so a teacher can't silently strip someone's booking).
async function writeSlots(t, testId, slots) {
  const incoming = normalizeSlots(slots);
  const keepIds = new Set(incoming.filter((s) => s.id).map((s) => s.id));
  const existing = await t.all('SELECT id FROM test_slots WHERE test_id = ?', [testId]);
  for (const ex of existing) {
    if (keepIds.has(ex.id)) continue;
    const booked = await t.get('SELECT 1 FROM assignments WHERE slot_id = ? LIMIT 1', [ex.id]);
    if (!booked) await t.run('DELETE FROM test_slots WHERE id = ?', [ex.id]);
  }
  for (const s of incoming) {
    if (s.id && keepIds.has(s.id)) {
      await t.run('UPDATE test_slots SET slot_at = ?, capacity = ? WHERE id = ? AND test_id = ?', [s.at, s.capacity, s.id, testId]);
    } else {
      await t.run('INSERT INTO test_slots (test_id, slot_at, capacity) VALUES (?, ?, ?)', [testId, s.at, s.capacity]);
    }
  }
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
  const startsAt = readStartDate(req.body);
  const duration = readDuration(req.body);
  const { proctored, maxViolations } = readProctoring(req.body);
  const requiresSlot = req.body.requiresSlot ? 1 : 0;
  const slots = normalizeSlots(req.body.slots);
  const slotErr = validateSlotSetup(requiresSlot, slots, duration);
  if (slotErr) return res.status(400).json({ error: slotErr });

  const testId = await tx(async (t) => {
    const newId = (await t.run(
      'INSERT INTO tests (teacher_id, title, description, negative_marking, penalty, due_date, starts_at, duration_minutes, proctored, max_violations, requires_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [req.user.id, title, description, negative_marking, penalty, dueDate, startsAt, duration, proctored, maxViolations, requiresSlot]
    )).rows[0].id;
    await writeQuestions(t.run, newId, questions);
    if (requiresSlot) await writeSlots(t, newId, slots);
    return newId;
  });
  await logAudit(req, { action: 'test.create', entityType: 'test', entityId: testId, entityLabel: title, details: `${questions.length} question(s)` });
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
  const startsAt = readStartDate(req.body);
  const duration = readDuration(req.body);
  const { proctored, maxViolations } = readProctoring(req.body);
  const requiresSlot = req.body.requiresSlot ? 1 : 0;
  const slots = normalizeSlots(req.body.slots);
  const slotErr = validateSlotSetup(requiresSlot, slots, duration);
  if (slotErr) return res.status(400).json({ error: slotErr });
  const oldQuestions = await all("SELECT prompt, section FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position, id", [test.id]);
  const oldQCount = oldQuestions.length;
  const oldSlotCount = (await get('SELECT COUNT(*) AS c FROM test_slots WHERE test_id = ?', [test.id])).c;

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
      'UPDATE tests SET title = ?, description = ?, negative_marking = ?, penalty = ?, due_date = ?, starts_at = ?, duration_minutes = ?, proctored = ?, max_violations = ?, requires_slot = ? WHERE id = ?',
      [title, description, negative_marking, penalty, dueDate, startsAt, duration, proctored, maxViolations, requiresSlot, test.id]
    );
    await writeQuestions(t.run, test.id, questions);
    // Turning slot booking off (or editing the slot list) reconciles rows;
    // an empty list with booking off clears every unbooked slot.
    await writeSlots(t, test.id, requiresSlot ? slots : []);
    return (await t.get("SELECT COUNT(*) AS c FROM attempts WHERE test_id = ? AND submitted_at IS NOT NULL", [test.id])).c;
  });
  const changes = describeTestChanges({
    old: { title: test.title, description: test.description || '', dueDate: test.due_date || '', startsAt: test.starts_at || '', requiresSlot: test.requires_slot, slotCount: oldSlotCount, duration: test.duration_minutes, negative_marking: test.negative_marking, penalty: test.penalty, proctored: test.proctored, maxViolations: test.max_violations, questions: oldQuestions },
    now: { title, description, dueDate, startsAt, requiresSlot, slotCount: slots.length, duration, negative_marking, penalty, proctored, maxViolations, questions },
  });
  await logAudit(req, { action: 'test.update', entityType: 'test', entityId: test.id, entityLabel: title, details: changes.length ? changes.join('; ') : 'Re-saved with no changes' });
  res.json({ id: test.id, keptAttempts });
}));

app.get('/api/tests', requireAuth('teacher'), h(async (req, res) => {
  const tests = await all(
    `SELECT t.id, t.title, t.description, t.negative_marking, t.penalty, t.due_date, t.starts_at, t.duration_minutes, t.requires_slot, t.created_at,
            (SELECT COUNT(*) FROM test_slots ts WHERE ts.test_id = t.id) AS slot_count,
            (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id AND q.archived = 0) AS question_count,
            (SELECT COUNT(*) FROM assignments a WHERE a.test_id = t.id) AS assigned_count,
            (SELECT COUNT(*) FROM attempts at WHERE at.test_id = t.id AND at.submitted_at IS NOT NULL) AS submitted_count
       FROM tests t WHERE t.teacher_id = ? ORDER BY t.created_at DESC`,
    [req.user.id]
  );
  tests.forEach((t) => { t.closed = isClosed(t.due_date); });
  res.json({ tests });
}));

// At-a-glance numbers + recent tests for the teacher "Home" overview.
app.get('/api/teacher/summary', requireAuth('teacher'), h(async (req, res) => {
  const orgId = req.user.org_id;
  const tests = (await get('SELECT COUNT(*) AS c FROM tests WHERE teacher_id = ?', [req.user.id])).c;
  const students = (await get("SELECT COUNT(*) AS c FROM signup_tokens WHERE invite_role = 'student' AND org_id = ?", [orgId])).c;
  const teachers = (await get("SELECT COUNT(*) AS c FROM users WHERE role = 'teacher' AND org_id = ?", [orgId])).c;
  const agg = await get(
    `SELECT COUNT(*) FILTER (WHERE at.submitted_at IS NOT NULL) AS submissions,
            COUNT(*) FILTER (WHERE at.submitted_at IS NOT NULL AND at.needs_grading = 1) AS pending,
            AVG(CASE WHEN at.submitted_at IS NOT NULL AND at.needs_grading = 0 AND at.max_score > 0
                     THEN (at.auto_score + at.manual_score)::float / at.max_score END) AS avg_ratio
       FROM attempts at JOIN tests t ON t.id = at.test_id
      WHERE t.teacher_id = ?`,
    [req.user.id]
  );
  const recent = await all(
    `SELECT t.id, t.title, t.due_date,
            (SELECT COUNT(*) FROM attempts a WHERE a.test_id = t.id AND a.submitted_at IS NOT NULL) AS submitted,
            (SELECT COUNT(*) FROM assignments a WHERE a.test_id = t.id) AS assigned
       FROM tests t WHERE t.teacher_id = ? ORDER BY t.created_at DESC LIMIT 5`,
    [req.user.id]
  );
  res.json({
    tests, students, teachers,
    submissions: Number(agg.submissions) || 0,
    pendingGrading: Number(agg.pending) || 0,
    avgScorePct: agg.avg_ratio != null ? Math.round(Number(agg.avg_ratio) * 100) : null,
    recentTests: recent.map((r) => ({ id: r.id, title: r.title, submitted: r.submitted, assigned: r.assigned, closed: isClosed(r.due_date) })),
  });
}));

app.get('/api/tests/:id', requireAuth('teacher'), h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const questions = (await all('SELECT * FROM questions WHERE test_id = ? AND archived = 0 ORDER BY position', [test.id]))
    .map((q) => ({ ...q, options: JSON.parse(q.options_json) }));
  const slots = (await all('SELECT id, slot_at, capacity FROM test_slots WHERE test_id = ? ORDER BY slot_at, id', [test.id]))
    .map((s) => ({ id: s.id, at: s.slot_at, capacity: s.capacity }));
  res.json({ test, questions, slots });
}));

app.delete('/api/tests/:id', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  await run('DELETE FROM tests WHERE id = ?', [test.id]);
  await logAudit(req, { action: 'test.delete', entityType: 'test', entityId: test.id, entityLabel: test.title });
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
  const addedNames = [];
  await tx(async (t) => {
    for (const sid of studentIds) {
      // The student must be enrolled (and not disabled) in the teacher's org.
      const student = await t.get(
        `SELECT u.id, u.name FROM users u
           JOIN signup_tokens st ON st.student_id = u.id
          WHERE u.id = ? AND u.role = 'student' AND st.org_id = ? AND st.used = 1 AND st.disabled = 0`,
        [sid, req.user.org_id]
      );
      if (student) {
        const r = await t.run(
          'INSERT INTO assignments (test_id, student_id, teacher_id) VALUES (?, ?, ?) ON CONFLICT (test_id, student_id) DO NOTHING',
          [testId, sid, req.user.id]
        );
        if (r.changes > 0) { added += r.changes; addedNames.push(student.name); }
      }
    }
  });
  if (added > 0) await logAudit(req, { action: 'test.assign', entityType: 'test', entityId: testId, entityLabel: test.title, details: 'Assigned to ' + namesList(addedNames) });
  res.json({ assigned: added });
}));

// Who is already assigned to a given test (teacher view).
app.get('/api/tests/:id/assignments', requireAuth('teacher'), h(async (req, res) => {
  const rows = await all(
    `SELECT a.student_id, u.name, u.email, a.slot_id, bs.slot_at,
            EXISTS(SELECT 1 FROM attempts at WHERE at.assignment_id = a.id AND at.submitted_at IS NOT NULL) AS submitted,
            EXISTS(SELECT 1 FROM attempts at WHERE at.assignment_id = a.id) AS started
       FROM assignments a JOIN users u ON u.id = a.student_id
       LEFT JOIN test_slots bs ON bs.id = a.slot_id
      WHERE a.test_id = ?`,
    [req.params.id]
  );
  res.json({ assigned: rows.map((r) => ({ ...r, slotAt: r.slot_at || null })) });
}));

// Teacher re-opens booking for a student who missed (or needs to change) their
// slot: clears the booked slot and any un-submitted attempt so they can rebook.
app.post('/api/tests/:id/reopen-slot', requireAuth('teacher'), requireActiveSubscription, h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const studentId = Number(req.body.studentId);
  const a = await get('SELECT * FROM assignments WHERE test_id = ? AND student_id = ?', [test.id, studentId]);
  if (!a) return res.status(404).json({ error: 'That student is not assigned to this test.' });
  const done = await get('SELECT 1 FROM attempts WHERE assignment_id = ? AND submitted_at IS NOT NULL', [a.id]);
  if (done) return res.status(400).json({ error: 'That student has already submitted this test.' });
  const student = await get('SELECT name FROM users WHERE id = ?', [studentId]);
  await tx(async (t) => {
    await t.run('DELETE FROM attempts WHERE assignment_id = ? AND submitted_at IS NULL', [a.id]);
    await t.run('UPDATE assignments SET slot_id = NULL WHERE id = ?', [a.id]);
  });
  await logAudit(req, { action: 'test.reopen_slot', entityType: 'test', entityId: test.id, entityLabel: test.title, details: `Reopened slot booking for ${student ? student.name : 'student #' + studentId}` });
  res.json({ ok: true });
}));

// ============================================================================
// STUDENT: my assigned tests + taking them
// ============================================================================

// The student's membership in the organization that owns `testId` (the test's
// teacher's org). Returns null if they aren't enrolled there.
async function membershipForTest(studentId, testId) {
  return get(
    `SELECT st.* FROM tests t
       JOIN users tu ON tu.id = t.teacher_id
       JOIN signup_tokens st ON st.student_id = ? AND st.org_id = tu.org_id
            AND st.invite_role = 'student' AND st.used = 1
      WHERE t.id = ?`,
    [studentId, testId]
  );
}
// True when the student may currently see/take/review this test's org content.
function membershipActive(m) {
  return !!m && !m.disabled && !isExpired(m.access_until);
}

// Live rank + percentile for a score on a test, across everyone who has
// submitted so far. Recomputed on every call (never cached) so it stays current
// as more students finish over the following days.
//   rank        — 1-based, competition ranking (ties share a rank)
//   percentile  — NTA-style: 100 × (candidates scoring at or below you) / total
async function computeRank(testId, myScore) {
  const total = (await get('SELECT COUNT(*) AS c FROM attempts WHERE test_id = ? AND submitted_at IS NOT NULL', [testId])).c;
  if (total === 0) return { rank: null, total: 0, percentile: null };
  const better = (await get('SELECT COUNT(*) AS c FROM attempts WHERE test_id = ? AND submitted_at IS NOT NULL AND (auto_score + manual_score) > ?', [testId, myScore])).c;
  const atOrBelow = (await get('SELECT COUNT(*) AS c FROM attempts WHERE test_id = ? AND submitted_at IS NOT NULL AND (auto_score + manual_score) <= ?', [testId, myScore])).c;
  return { rank: better + 1, total, percentile: Math.round((atOrBelow / total) * 1000) / 10 };
}

// Live rank/percentile for the student's own submitted attempt on one test.
app.get('/api/my-assignments/:assignmentId/rank', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (!membershipActive(await membershipForTest(req.user.id, a.test_id)))
    return res.status(403).json({ error: 'This test belongs to an organization you no longer have access to.' });
  const attempt = await get('SELECT * FROM attempts WHERE assignment_id = ? AND submitted_at IS NOT NULL', [a.id]);
  if (!attempt) return res.status(409).json({ error: 'You have not submitted this test yet.' });
  const myScore = attempt.auto_score + attempt.manual_score;
  const rank = await computeRank(a.test_id, myScore);
  res.json({ ...rank, score: myScore, maxScore: attempt.max_score, needsGrading: !!attempt.needs_grading });
}));

// The organizations a student is an active member of (for the org switcher).
app.get('/api/my-orgs', requireAuth('student'), h(async (req, res) => {
  const rows = await all(
    `SELECT o.id, o.name, st.access_until
       FROM signup_tokens st JOIN organizations o ON o.id = st.org_id
      WHERE st.student_id = ? AND st.invite_role = 'student' AND st.used = 1 AND st.disabled = 0
      ORDER BY o.name`,
    [req.user.id]
  );
  res.json({ orgs: rows.filter((r) => !isExpired(r.access_until)).map((r) => ({ id: r.id, name: r.name })) });
}));

app.get('/api/my-assignments', requireAuth('student'), h(async (req, res) => {
  // Only surface tests from organizations where the student's membership is
  // active (enrolled, not disabled). Each test is labelled with its org so a
  // student enrolled in several institutes can tell them apart.
  const rows = await all(
    `SELECT a.id AS assignment_id, a.slot_id, t.id AS test_id, t.title, t.description, t.due_date,
            t.starts_at, t.requires_slot, t.duration_minutes, bs.slot_at AS booked_slot_at,
            o.id AS org_id, o.name AS org_name, st.access_until AS membership_access,
            (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id AND q.archived = 0) AS question_count,
            at.id AS attempt_id, at.submitted_at, at.auto_score, at.manual_score,
            at.max_score, at.needs_grading,
            (SELECT COUNT(*) FROM attempts x WHERE x.test_id = t.id AND x.submitted_at IS NOT NULL) AS test_submissions,
            (SELECT COUNT(*) FROM attempts x WHERE x.test_id = t.id AND x.submitted_at IS NOT NULL AND (x.auto_score + x.manual_score) > (at.auto_score + at.manual_score)) AS better_count,
            (SELECT COUNT(*) FROM attempts x WHERE x.test_id = t.id AND x.submitted_at IS NOT NULL AND (x.auto_score + x.manual_score) <= (at.auto_score + at.manual_score)) AS atorbelow_count
       FROM assignments a
       JOIN tests t ON t.id = a.test_id
       JOIN users tu ON tu.id = t.teacher_id
       JOIN signup_tokens st ON st.student_id = a.student_id AND st.org_id = tu.org_id
            AND st.invite_role = 'student' AND st.used = 1 AND st.disabled = 0
       LEFT JOIN organizations o ON o.id = tu.org_id
       LEFT JOIN test_slots bs ON bs.id = a.slot_id
       LEFT JOIN attempts at ON at.assignment_id = a.id
      WHERE a.student_id = ?
      ORDER BY a.created_at DESC`,
    [req.user.id]
  );
  const now = Date.now();
  const assignments = rows
    .filter((r) => !isExpired(r.membership_access)) // per-org access window
    .map((r) => {
      const submitted = !!r.submitted_at;
      const requiresSlot = !!r.requires_slot;
      const slotAt = r.booked_slot_at || null;
      const win = slotAt ? slotWindow(slotAt, r.duration_minutes) : null;
      const takers = r.test_submissions;
      return {
        assignmentId: r.assignment_id,
        testId: r.test_id,
        title: r.title,
        description: r.description,
        orgId: r.org_id || null,
        orgName: r.org_name || null,
        questionCount: r.question_count,
        submitted,
        started: !!r.attempt_id && !submitted,
        needsGrading: !!r.needs_grading,
        score: submitted ? r.auto_score + r.manual_score : null,
        maxScore: r.max_score,
        // Live rank + percentile among everyone who has submitted this test.
        rank: submitted ? r.better_count + 1 : null,
        totalTakers: submitted ? takers : null,
        percentile: submitted && takers > 0 ? Math.round((r.atorbelow_count / takers) * 1000) / 10 : null,
        dueDate: r.due_date,
        closed: isClosed(r.due_date),
        startsAt: r.starts_at || '',
        notYetOpen: notYetOpen(r.starts_at),
        // Slot booking state (only meaningful when requiresSlot is true).
        requiresSlot,
        slotAt,
        needsBooking: requiresSlot && !slotAt && !submitted,
        slotOpen: !!win && now >= win.openAt && now <= win.closeAt,
        slotUpcoming: !!win && now < win.openAt,
        slotMissed: !!win && !submitted && now > win.closeAt,
        slotOpenAt: win ? new Date(win.openAt).toISOString() : null,
        slotCloseAt: win ? new Date(win.closeAt).toISOString() : null,
      };
    });
  res.json({ assignments });
}));

// The slots a student can pick from for a slot-scheduled test, with seats left.
app.get('/api/my-assignments/:assignmentId/slots', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (!membershipActive(await membershipForTest(req.user.id, a.test_id)))
    return res.status(403).json({ error: 'Your access to this organization has ended. Please contact the institute.' });
  const test = await get('SELECT requires_slot, duration_minutes FROM tests WHERE id = ?', [a.test_id]);
  if (!test.requires_slot) return res.json({ slots: [], bookedSlotId: null });
  const rows = await all(
    `SELECT ts.id, ts.slot_at, ts.capacity,
            (SELECT COUNT(*) FROM assignments a2 WHERE a2.slot_id = ts.id) AS booked
       FROM test_slots ts WHERE ts.test_id = ? ORDER BY ts.slot_at, ts.id`,
    [a.test_id]
  );
  const now = Date.now();
  const slots = rows.map((r) => {
    const win = slotWindow(r.slot_at, test.duration_minutes);
    const isMine = r.id === a.slot_id;
    return {
      id: r.id, slotAt: r.slot_at, capacity: r.capacity, booked: r.booked,
      full: r.capacity > 0 && r.booked >= r.capacity && !isMine,
      past: !!win && now > win.closeAt,
      opensAt: win ? new Date(win.openAt).toISOString() : null,
      closesAt: win ? new Date(win.closeAt).toISOString() : null,
      mine: isMine,
    };
  });
  res.json({ slots, bookedSlotId: a.slot_id || null });
}));

// A student books (or changes) their slot for a slot-scheduled test.
app.post('/api/my-assignments/:assignmentId/slot', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (!membershipActive(await membershipForTest(req.user.id, a.test_id)))
    return res.status(403).json({ error: 'Your access to this organization has ended. Please contact the institute.' });
  const test = await get('SELECT requires_slot, duration_minutes, due_date FROM tests WHERE id = ?', [a.test_id]);
  if (!test.requires_slot) return res.status(400).json({ error: 'This test does not use time slots.' });
  if (isClosed(test.due_date)) return res.status(403).json({ error: 'This test is closed.' });
  const attempt = await get('SELECT id, submitted_at FROM attempts WHERE assignment_id = ?', [a.id]);
  if (attempt && attempt.submitted_at) return res.status(409).json({ error: 'You have already submitted this test.' });
  if (attempt) return res.status(409).json({ error: 'You have already started this test, so the slot cannot be changed.' });

  const slotId = Number(req.body.slotId);
  const booked = await tx(async (t) => {
    const slot = await t.get('SELECT id, slot_at, capacity FROM test_slots WHERE id = ? AND test_id = ?', [slotId, a.test_id]);
    if (!slot) return { error: 'That time slot is no longer available.' };
    const win = slotWindow(slot.slot_at, test.duration_minutes);
    if (win && Date.now() > win.closeAt) return { error: 'That slot has already passed. Please pick another.' };
    if (slot.capacity > 0) {
      const count = (await t.get('SELECT COUNT(*) AS c FROM assignments WHERE slot_id = ? AND id <> ?', [slotId, a.id])).c;
      if (count >= slot.capacity) return { error: 'That slot is full. Please pick another time.' };
    }
    await t.run('UPDATE assignments SET slot_id = ? WHERE id = ?', [slotId, a.id]);
    return { slotAt: slot.slot_at };
  });
  if (booked.error) return res.status(409).json({ error: booked.error });
  res.json({ ok: true, slotAt: booked.slotAt });
}));

// A student reviews their own submitted attempt (read-only): questions, their
// answers, the correct answers, and per-question marks.
app.get('/api/my-review/:assignmentId', requireAuth('student'), h(async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  // Nothing from an organization the student is disabled/expired in is visible —
  // including past results.
  if (!membershipActive(await membershipForTest(req.user.id, a.test_id)))
    return res.status(403).json({ error: 'This test belongs to an organization you no longer have access to.' });
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

// Fetch a test to take — WITHOUT correct answers. With ?preview=1 it returns
// only the instructions metadata and does NOT create an attempt or start the
// timer (used for the "read the rules, then Begin" screen).
app.get('/api/take/:assignmentId', requireAuth('student'), h(async (req, res) => {
  const preview = req.query.preview === '1' || req.query.preview === 'true';
  const a = await get('SELECT * FROM assignments WHERE id = ? AND student_id = ?', [req.params.assignmentId, req.user.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (!membershipActive(await membershipForTest(req.user.id, a.test_id)))
    return res.status(403).json({ error: 'Your access to this organization has ended. Please contact the institute.' });
  let attempt = await get('SELECT * FROM attempts WHERE assignment_id = ?', [a.id]);
  if (attempt && attempt.submitted_at)
    return res.status(409).json({ error: 'You have already submitted this test.' });

  const test = await get('SELECT id, title, description, negative_marking, penalty, due_date, starts_at, duration_minutes, requires_slot, proctored, max_violations FROM tests WHERE id = ?', [a.test_id]);
  if (isClosed(test.due_date))
    return res.status(403).json({ error: 'The deadline for this test has passed. You can no longer take it.' });
  if (notYetOpen(test.starts_at))
    return res.status(403).json({ error: `This test hasn't opened yet. It opens at ${fmtWhen(test.starts_at)}.` });

  // Slot-scheduled tests are only accessible inside the student's booked window.
  let slotWin = null;
  if (test.requires_slot) {
    if (!a.slot_id)
      return res.status(403).json({ error: 'Please book a time slot for this test before starting it.' });
    const slot = await get('SELECT slot_at FROM test_slots WHERE id = ?', [a.slot_id]);
    slotWin = slot ? slotWindow(slot.slot_at, test.duration_minutes) : null;
    if (!slotWin)
      return res.status(403).json({ error: 'Your booked slot is no longer available. Ask your teacher to reschedule.' });
    if (Date.now() < slotWin.openAt)
      return res.status(403).json({ error: `Your slot opens at ${fmtWhen(slot.slot_at)}. Come back then.` });
    if (Date.now() > slotWin.closeAt)
      return res.status(403).json({ error: 'You missed your slot window. Ask your teacher to reschedule you.' });
  }

  // Instructions screen: report what the student is about to sit, but don't
  // create an attempt or start the clock until they click Begin.
  if (preview) {
    const agg = await get('SELECT COUNT(*) AS c, COALESCE(SUM(points), 0) AS marks FROM questions WHERE test_id = ? AND archived = 0', [a.test_id]);
    res.json({
      preview: true,
      inProgress: !!attempt,
      test,
      questionCount: agg.c,
      totalMarks: agg.marks,
      durationMinutes: test.duration_minutes,
      slotCloseAt: slotWin ? new Date(slotWin.closeAt).toISOString() : null,
    });
    return;
  }

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
  // The slot window is a hard stop even mid-attempt: time runs out at close.
  if (slotWin) {
    const untilClose = Math.max(0, Math.round((slotWin.closeAt - Date.now()) / 1000));
    remainingSeconds = remainingSeconds == null ? untilClose : Math.min(remainingSeconds, untilClose);
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
  if (!membershipActive(await membershipForTest(req.user.id, a.test_id))) return res.json({ ok: false });
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
  if (!membershipActive(await membershipForTest(req.user.id, a.test_id)))
    return res.status(403).json({ error: 'Your access to this organization has ended. Please contact the institute.' });
  const existing = await get('SELECT * FROM attempts WHERE assignment_id = ?', [a.id]);
  if (existing && existing.submitted_at)
    return res.status(409).json({ error: 'You have already submitted this test.' });

  const test = await get('SELECT negative_marking, penalty, due_date, requires_slot, duration_minutes FROM tests WHERE id = ?', [a.test_id]);
  if (isClosed(test.due_date))
    return res.status(403).json({ error: 'The deadline for this test has passed. Your submission was not accepted.' });
  // Honour the booked slot window on submit too (with a short grace so a
  // submission that starts just before close still lands).
  if (test.requires_slot && a.slot_id) {
    const slot = await get('SELECT slot_at FROM test_slots WHERE id = ?', [a.slot_id]);
    const win = slot ? slotWindow(slot.slot_at, test.duration_minutes) : null;
    if (win && Date.now() > win.closeAt + 60 * 1000)
      return res.status(403).json({ error: 'Your slot window has closed. Your submission was not accepted — ask your teacher to reschedule.' });
  }
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

// Top 10 students by score for a test (the "toppers board").
app.get('/api/tests/:id/leaderboard', requireAuth('teacher'), h(async (req, res) => {
  const test = await get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const rows = await all(
    `SELECT u.name, u.email, (at.auto_score + at.manual_score) AS score, at.max_score, at.submitted_at, at.needs_grading
       FROM attempts at JOIN users u ON u.id = at.student_id
      WHERE at.test_id = ? AND at.submitted_at IS NOT NULL
      ORDER BY (at.auto_score + at.manual_score) DESC, at.submitted_at ASC
      LIMIT 10`,
    [test.id]
  );
  let rank = 0, prevScore = null;
  const leaderboard = rows.map((r, i) => {
    if (prevScore === null || r.score !== prevScore) { rank = i + 1; prevScore = r.score; } // competition ranking (ties share a rank)
    return { rank, name: r.name, email: r.email, score: r.score, maxScore: r.max_score, submittedAt: r.submitted_at, needsGrading: !!r.needs_grading };
  });
  res.json({ title: test.title, leaderboard, anyPending: leaderboard.some((x) => x.needsGrading) });
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
