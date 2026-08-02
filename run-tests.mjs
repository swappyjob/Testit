// Runs the whole test suite against a throwaway database on a separate port,
// so the real data.db is never touched. Usage: node run-tests.mjs
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://localhost:${PORT}`;
const DB_FILES = ['test.db', 'test.db-wal', 'test.db-shm'];
const env = { ...process.env, TESTIT_DB: 'test.db', PORT: String(PORT) };

const rmDb = () => DB_FILES.forEach((f) => { try { fs.rmSync(path.join(__dirname, f)); } catch {} });
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const listUploads = () => { try { return new Set(fs.readdirSync(uploadsDir)); } catch { return new Set(); } };

const SUITES = ['teachers', 'e2e', 'edit', 'phone', 'search', 'disable', 'export', 'password', 'deadline', 'image', 'negmark'];

rmDb();
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
  console.log(`Test server up on ${BASE} (db: test.db)\n`);
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
  rmDb();
  // Remove any images the image-test created, so uploads/ stays clean.
  for (const f of listUploads()) if (!uploadsBefore.has(f)) { try { fs.rmSync(path.join(uploadsDir, f)); } catch {} }
}

console.log(failed ? `\n❌ ${failed} suite(s) failed.` : '\n✅ All suites passed (throwaway DB, real data untouched).');
process.exit(failed ? 1 : 0);
