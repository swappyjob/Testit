// One-time: put all existing teachers/students (and pending invites) that have
// no organization into a "Default Organization".
import { pool, init } from './db.js';

await init();

let org = (await pool.query("SELECT id FROM organizations WHERE name = $1", ['Default Organization'])).rows[0];
if (!org) org = (await pool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", ['Default Organization'])).rows[0];
const orgId = org.id;

const u = await pool.query("UPDATE users SET org_id = $1 WHERE role IN ('teacher','student') AND org_id IS NULL", [orgId]);
const s = await pool.query("UPDATE signup_tokens SET org_id = $1 WHERE org_id IS NULL", [orgId]);

console.log(`Default Organization (id ${orgId}): assigned ${u.rowCount} user(s) and ${s.rowCount} invite(s).`);
await pool.end();
