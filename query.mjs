// Run SQL queries against the database from the command line.
//
//   node query.mjs                          -> lists all tables and row counts
//   node query.mjs "SELECT * FROM users"    -> runs the query and prints results
//
// Opens the database read-only, so it is safe to run while the server is up.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, 'data.db'), { readOnly: true });

const sql = process.argv.slice(2).join(' ').trim();

if (!sql) {
  // No query given: show the tables and how many rows each has.
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  console.log('\nTables in data.db:\n');
  for (const { name } of tables) {
    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get();
    console.log(`  ${name.padEnd(16)} ${c} row(s)`);
  }
  console.log('\nRun a query like:  node query.mjs "SELECT id, name, email, role FROM users"\n');
} else {
  try {
    const rows = db.prepare(sql).all();
    if (rows.length === 0) console.log('(no rows)');
    else console.table(rows);
    console.log(`\n${rows.length} row(s).`);
  } catch (err) {
    console.error('SQL error:', err.message);
    process.exit(1);
  }
}
