// Reset a user's password.  node set-password.mjs <email> <newpassword>
import crypto from 'node:crypto';
import { pool } from './db.js';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const email = (process.argv[2] || '').trim().toLowerCase();
const pw = process.argv[3] || '';
if (!email || !pw) { console.log('Usage: node set-password.mjs <email> <newpassword>'); process.exit(1); }

const u = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
if (!u) { console.log('No user found with email:', email); await pool.end(); process.exit(1); }
await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(pw), u.id]);
console.log('✓ Password updated for', email);
await pool.end();
