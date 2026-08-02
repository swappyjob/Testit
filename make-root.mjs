// Promote an existing teacher account to a root teacher.
//   node make-root.mjs someone@example.com
import { pool } from './db.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.log('Usage: node make-root.mjs <teacher-email>');
  process.exit(1);
}
const u = (await pool.query('SELECT id, role, is_root FROM users WHERE email = $1', [email])).rows[0];
if (!u) { console.log('No user found with email:', email); await pool.end(); process.exit(1); }
if (u.role !== 'teacher') { console.log(`That account is a ${u.role}; only teachers can be root.`); await pool.end(); process.exit(1); }
if (u.is_root) { console.log(email, 'is already a root teacher.'); await pool.end(); process.exit(0); }
await pool.query('UPDATE users SET is_root = 1 WHERE id = $1', [u.id]);
console.log('✓', email, 'is now a root teacher. Log out and back in to see the Teachers tab.');
await pool.end();
