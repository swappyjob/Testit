// Shared test helper. Org creation is admin-only (no public self-signup), so
// tests can't just POST /api/register-teacher anonymously anymore. This logs in
// as a throwaway platform admin (created via make-admin.mjs, once per process),
// creates the org + root teacher through the admin-gated endpoint, then logs in
// as that teacher and returns their cookie jar — a one-line drop-in for tests.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let adminJar = null; // cached per test process

async function ensureAdmin(makeJar, call) {
  if (adminJar) return adminJar;
  const email = `bootadmin_${Math.floor(Math.random() * 1e9)}@x.com`;
  execSync(`"${process.execPath}" "${path.join(__dirname, 'make-admin.mjs')}" BootAdmin ${email} bootpass1`, { stdio: 'ignore' });
  const jar = makeJar();
  await call(jar, '/api/login', 'POST', { email, password: 'bootpass1' });
  adminJar = jar;
  return jar;
}

// body: { name, email, password }. Returns a cookie jar logged in as the teacher.
export async function registerTeacher(BASE, makeJar, call, body) {
  const admin = await ensureAdmin(makeJar, call);
  await call(admin, '/api/register-teacher', 'POST', body); // admin-gated create
  const jar = makeJar();
  await call(jar, '/api/login', 'POST', { email: body.email, password: body.password });
  return jar;
}
