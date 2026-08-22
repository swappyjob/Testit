// Runs the whole test suite against a separate 'testit_test' Postgres database
// on a separate port, so the real 'testit' database is never touched.
//   node run-tests.mjs
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://localhost:${PORT}`;
const PGPASSWORD = process.env.PGPASSWORD || 'postgres';
const env = { ...process.env, PGDATABASE: 'testit_test', PGPASSWORD, PORT: String(PORT) };

const uploadsDir = path.join(__dirname, 'public', 'uploads');
const listUploads = () => { try { return new Set(fs.readdirSync(uploadsDir)); } catch { return new Set(); } };

const SUITES = ['admin', 'teachers', 'e2e', 'edit', 'phone', 'search', 'disable', 'access', 'student-edit', 'export', 'password', 'reset', 'deadline', 'timer', 'image', 'negmark', 'multi', 'section', 'subscription', 'proctor', 'student-review', 'draft', 'resume', 'leaderboard', 'bank', 'audit', 'mathdraw', 'multiorg', 'support', 'bulkstudents', 'summary'];

// Reset the test database to a clean schema-less state; the server recreates the schema.
const admin = new pg.Client({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: PGPASSWORD,
  database: 'testit_test',
});
await admin.connect();
await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
await admin.end();

const uploadsBefore = listUploads();
const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: 'ignore' });

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/api/me')).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('test server did not start');
}

let failed = 0;
try {
  await waitUp();
  console.log(`Test server up on ${BASE} (db: testit_test)\n`);
  for (const s of SUITES) {
    console.log(`===== ${s} =====`);
    try {
      execSync(`"${process.execPath}" "${path.join(__dirname, s + '-test.mjs')}"`,
        { env: { ...env, TEST_BASE: BASE }, stdio: 'inherit' });
    } catch { failed++; console.log(`  ✗ ${s} FAILED\n`); }
  }
} finally {
  server.kill();
  await sleep(500);
  for (const f of listUploads()) if (!uploadsBefore.has(f)) { try { fs.rmSync(path.join(uploadsDir, f)); } catch {} }
}

console.log(failed ? `\n❌ ${failed} suite(s) failed.` : '\n✅ All suites passed (testit_test DB, real data untouched).');
process.exit(failed ? 1 : 0);
