// Create (or update the password of) a support-team agent.
//   node make-support.mjs "Name" support@example.com password
import crypto from 'node:crypto';
import { pool } from './db.js';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const name = (process.argv[2] || '').trim();
const email = (process.argv[3] || '').trim().toLowerCase();
const pw = process.argv[4] || '';
if (!name || !email || !pw) {
  console.log('Usage: node make-support.mjs "Name" <email> <password>');
  process.exit(1);
}

const existing = (await pool.query('SELECT id, role FROM users WHERE email = $1', [email])).rows[0];
if (existing && existing.role !== 'support') {
  console.log(`That email already belongs to a ${existing.role}; pick a different email for the support agent.`);
  await pool.end();
  process.exit(1);
}
if (existing) {
  await pool.query('UPDATE users SET name = $1, password_hash = $2 WHERE id = $3', [name, hashPassword(pw), existing.id]);
  console.log('✓ Updated existing support agent:', email);
} else {
  await pool.query("INSERT INTO users (role, name, email, password_hash) VALUES ('support', $1, $2, $3)", [name, email, hashPassword(pw)]);
  console.log('✓ Created support agent:', email);
}
await pool.end();
