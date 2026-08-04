// Seed sample students into an organization, owned by its root teacher.
//   node seed-students.mjs ["Organisation 1"] [count]
import crypto from 'node:crypto';
import { pool } from './db.js';

const ORG_NAME = process.argv[2] || 'Organisation 1';
const COUNT = Number(process.argv[3]) || 10;
const PASSWORD = 'Student@123';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
const randomToken = () => crypto.randomBytes(24).toString('hex');

const org = (await pool.query('SELECT id FROM organizations WHERE name = $1', [ORG_NAME])).rows[0];
if (!org) { console.log('No organization named:', ORG_NAME); await pool.end(); process.exit(1); }

// Owner = a root teacher in that org (fall back to any teacher in the org).
const owner = (await pool.query(
  "SELECT id, name FROM users WHERE role = 'teacher' AND org_id = $1 ORDER BY is_root DESC, id LIMIT 1", [org.id]
)).rows[0];
if (!owner) { console.log('No teacher exists in', ORG_NAME, '- add one first.'); await pool.end(); process.exit(1); }

let created = 0;
for (let i = 1; i <= COUNT; i++) {
  const nn = String(i).padStart(2, '0');
  const name = `Student ${nn}`;
  const email = `org1.student${nn}@tet.com`;
  const phone = `90000000${nn}`;
  if ((await pool.query('SELECT 1 FROM users WHERE email = $1', [email])).rows[0]) {
    console.log(`- skip ${email} (already exists)`);
    continue;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uid = (await client.query(
      "INSERT INTO users (role, name, email, phone, password_hash, org_id) VALUES ('student', $1, $2, $3, $4, $5) RETURNING id",
      [name, email, phone, hashPassword(PASSWORD), org.id]
    )).rows[0].id;
    await client.query(
      "INSERT INTO signup_tokens (token, name, email, phone, invite_role, org_id, teacher_id, used, student_id) VALUES ($1, $2, $3, $4, 'student', $5, $6, 1, $7)",
      [randomToken(), name, email, phone, org.id, owner.id, uid]
    );
    await client.query('COMMIT');
    created++;
    console.log(`✓ ${name}  <${email}>`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

console.log(`\nDone — created ${created} student(s) in "${ORG_NAME}", owned by ${owner.name}. Password for all: ${PASSWORD}`);
await pool.end();
