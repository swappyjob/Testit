// Run SQL queries against the Postgres database from the command line.
//
//   node query.mjs                          -> lists all tables and row counts
//   node query.mjs "SELECT * FROM users"    -> runs the query and prints results
import { pool } from './db.js';

const sql = process.argv.slice(2).join(' ').trim();

if (!sql) {
  const tables = (await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  )).rows;
  console.log('\nTables in the database:\n');
  for (const { table_name } of tables) {
    const c = (await pool.query(`SELECT COUNT(*)::int AS c FROM "${table_name}"`)).rows[0].c;
    console.log(`  ${table_name.padEnd(16)} ${c} row(s)`);
  }
  console.log('\nRun a query like:  node query.mjs "SELECT id, name, email, role FROM users"\n');
} else {
  try {
    const r = await pool.query(sql);
    if (r.rows.length === 0) console.log('(no rows)');
    else console.table(r.rows);
    console.log(`\n${r.rows.length} row(s).`);
  } catch (err) {
    console.error('SQL error:', err.message);
    await pool.end();
    process.exit(1);
  }
}
await pool.end();
