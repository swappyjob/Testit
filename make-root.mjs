// Promote an existing teacher account to a root teacher.
//   node make-root.mjs someone@example.com
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.TESTIT_DB || 'data.db';
const db = new DatabaseSync(path.isAbsolute(DB_FILE) ? DB_FILE : path.join(__dirname, DB_FILE));

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.log('Usage: node make-root.mjs <teacher-email>');
  process.exit(1);
}
const u = db.prepare('SELECT id, role, is_root FROM users WHERE email = ?').get(email);
if (!u) { console.log('No user found with email:', email); process.exit(1); }
if (u.role !== 'teacher') { console.log(`That account is a ${u.role}; only teachers can be root.`); process.exit(1); }
if (u.is_root) { console.log(email, 'is already a root teacher.'); process.exit(0); }
db.prepare('UPDATE users SET is_root = 1 WHERE id = ?').run(u.id);
console.log('✓', email, 'is now a root teacher. Log out and back in to see the Teachers tab.');
