// One-time migration: copy all data from the old SQLite data.db into Postgres.
// Preserves ids and fixes the auto-increment sequences afterward.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, init } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlite = new DatabaseSync(path.join(__dirname, 'data.db'), { readOnly: true });

await init(); // ensure the Postgres schema exists

// Insert in FK-dependency order. (sessions are skipped — users just log in again.)
const TABLES = ['users', 'signup_tokens', 'tests', 'questions', 'assignments', 'attempts', 'answers'];

for (const table of TABLES) {
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) { console.log(`${table}: 0 rows`); continue; }
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
  let n = 0;
  for (const row of rows) {
    await pool.query(
      `INSERT INTO ${table} (${colList}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
      cols.map((c) => row[c])
    );
    n++;
  }
  // Reset the SERIAL sequence so new inserts don't collide with migrated ids.
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT MAX(id) FROM ${table}), 1))`
  );
  console.log(`${table}: migrated ${n} rows`);
}

console.log('\n✅ Migration complete.');
await pool.end();
