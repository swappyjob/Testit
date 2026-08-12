// PostgreSQL data layer. Exposes small async helpers (get/all/run/tx) so the
// rest of the app can use `?` placeholders and simple calls, close to how the
// old SQLite layer worked — but everything is async now.
import pg from 'pg';

const { Pool } = pg;

// Return integer/bigint counts as JS numbers instead of strings.
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8/bigint

// In production (Render/Railway/Fly/Cloud SQL/Neon/Supabase, etc.) the host
// hands you a single DATABASE_URL. Locally we fall back to the individual PG*
// vars. Managed Postgres almost always requires SSL; set PGSSLMODE=disable to
// turn it off (e.g. a self-hosted DB on a private network).
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PGPOOL_MAX || 10),
    })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'testit',
      max: Number(process.env.PGPOOL_MAX || 10),
    });

// Without this handler, an idle client dropped by Postgres would crash the
// whole process. Log it and let the pool recover on the next query.
pool.on('error', (err) => {
  console.error('Postgres pool error (recovering):', err.message);
});

// Translate '?' placeholders into Postgres '$1, $2, ...'. Our SQL never
// contains a literal '?', so a plain sequential replace is safe.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function all(sql, params = [], client = pool) {
  return (await client.query(toPg(sql), params)).rows;
}
async function get(sql, params = [], client = pool) {
  return (await client.query(toPg(sql), params)).rows[0];
}
// run() returns { changes, rows }. For inserts that need the new id, add
// "RETURNING id" to the SQL and read rows[0].id.
async function run(sql, params = [], client = pool) {
  const r = await client.query(toPg(sql), params);
  return { changes: r.rowCount, rows: r.rows };
}

// Transaction: fn receives {all,get,run} bound to a single dedicated client.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bound = {
      all: (s, p = []) => all(s, p, client),
      get: (s, p = []) => get(s, p, client),
      run: (s, p = []) => run(s, p, client),
    };
    const result = await fn(bound);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Create the schema if it does not exist. Safe to call on every startup.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      role          TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      phone         TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      disabled      INTEGER NOT NULL DEFAULT 0,
      is_root       INTEGER NOT NULL DEFAULT 0,
      access_until  TEXT NOT NULL DEFAULT '',   -- student access end date (YYYY-MM-DD); '' = no expiry
      org_id        INTEGER REFERENCES organizations(id) ON DELETE SET NULL,  -- NULL for the platform admin
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS signup_tokens (
      id          SERIAL PRIMARY KEY,
      token       TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      phone       TEXT NOT NULL DEFAULT '',
      invite_role TEXT NOT NULL DEFAULT 'student',
      is_root     INTEGER NOT NULL DEFAULT 0,
      access_until TEXT NOT NULL DEFAULT '',
      org_id      INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      used        INTEGER NOT NULL DEFAULT 0,
      student_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tests (
      id               SERIAL PRIMARY KEY,
      teacher_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title            TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      negative_marking INTEGER NOT NULL DEFAULT 0,
      penalty          INTEGER NOT NULL DEFAULT 0,
      due_date         TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS questions (
      id             SERIAL PRIMARY KEY,
      test_id        INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      type           TEXT NOT NULL CHECK (type IN ('mcq', 'truefalse', 'short', 'multi')),
      prompt         TEXT NOT NULL,
      options_json   TEXT NOT NULL DEFAULT '[]',
      correct_answer TEXT NOT NULL DEFAULT '',
      image_url      TEXT NOT NULL DEFAULT '',
      points         INTEGER NOT NULL DEFAULT 1,
      position       INTEGER NOT NULL DEFAULT 0,
      section        TEXT NOT NULL DEFAULT '',
      archived       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id          SERIAL PRIMARY KEY,
      test_id     INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (test_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id            SERIAL PRIMARY KEY,
      assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      test_id       INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      submitted_at  TIMESTAMPTZ,
      auto_score    INTEGER NOT NULL DEFAULT 0,
      manual_score  INTEGER NOT NULL DEFAULT 0,
      max_score     INTEGER NOT NULL DEFAULT 0,
      needs_grading INTEGER NOT NULL DEFAULT 0,
      UNIQUE (assignment_id)
    );

    CREATE TABLE IF NOT EXISTS answers (
      id             SERIAL PRIMARY KEY,
      attempt_id     INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      response       TEXT NOT NULL DEFAULT '',
      is_correct     INTEGER,
      points_awarded INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plans (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      max_students  INTEGER,               -- NULL = unlimited
      price_monthly INTEGER NOT NULL DEFAULT 0,  -- in rupees; 0 shown as Free/Custom
      sort_order    INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Forward-compatible column additions for databases created earlier.
  await pool.query('ALTER TABLE tests ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 0');
  await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT ''");
  // Optional teacher explanation of the correct answer, shown to students in review.
  await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS explanation TEXT NOT NULL DEFAULT ''");
  // Proctoring: per-test lockdown + how many tab-switch/fullscreen-exit violations
  // are allowed before the attempt auto-submits. Per-attempt violation count.
  await pool.query('ALTER TABLE tests ADD COLUMN IF NOT EXISTS proctored INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE tests ADD COLUMN IF NOT EXISTS max_violations INTEGER NOT NULL DEFAULT 3');
  await pool.query('ALTER TABLE attempts ADD COLUMN IF NOT EXISTS violations INTEGER NOT NULL DEFAULT 0');
  // In-progress answers + position, so a student can resume a test after a
  // disconnect. Cleared/ignored once the attempt is submitted.
  await pool.query("ALTER TABLE attempts ADD COLUMN IF NOT EXISTS draft_answers TEXT NOT NULL DEFAULT ''");
  await pool.query('ALTER TABLE attempts ADD COLUMN IF NOT EXISTS current_index INTEGER NOT NULL DEFAULT 0');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS access_until TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE signup_tokens ADD COLUMN IF NOT EXISTS access_until TEXT NOT NULL DEFAULT ''");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL');
  await pool.query('ALTER TABLE signup_tokens ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL');
  // Allow the new 'admin' role on databases created before it existed.
  await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
  await pool.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'teacher', 'student'))");
  // Allow the new 'multi' (multiple correct answers) question type on older DBs.
  await pool.query('ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_type_check');
  await pool.query("ALTER TABLE questions ADD CONSTRAINT questions_type_check CHECK (type IN ('mcq', 'truefalse', 'short', 'multi'))");
  // Convert legacy single-answer MCQs into checkbox (multi) questions so students
  // see checkboxes everywhere. A single index like "2" becomes the set "[2]".
  // Idempotent: once converted the rows are 'multi' and won't match again.
  await pool.query("UPDATE questions SET type = 'multi', correct_answer = '[' || correct_answer || ']' WHERE type = 'mcq' AND correct_answer ~ '^[0-9]+$'");

  // Pricing plans: organizations reference a plan.
  await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans(id)');
  // Subscription expiry (YYYY-MM-DD). '' = no expiry / always active. Once past,
  // the organization's teachers drop to read-only until an admin renews it.
  await pool.query("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_expires_at TEXT NOT NULL DEFAULT ''");
  const { rows: [{ c }] } = await pool.query('SELECT COUNT(*)::int AS c FROM plans');
  if (c === 0) {
    await pool.query(`INSERT INTO plans (name, max_students, price_monthly, sort_order) VALUES
      ('Free',        15,   0,     1),
      ('Basic',       100,  10000, 2),
      ('Standard',    300,  24000, 3),
      ('Pro',         750,  52500, 4),
      ('Enterprise',  NULL, 0,     5)`);
  }
  // The free trial (Free plan) allows up to 15 students. Migrate databases
  // seeded at the earlier 5-student cap up to 15.
  await pool.query("UPDATE plans SET max_students = 15 WHERE name = 'Free' AND max_students = 5");

  // Organization-wide audit log: who changed what (tests, assignments, students,
  // teachers) and when — for transparency across an org's teachers.
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id           SERIAL PRIMARY KEY,
    org_id       INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_name   TEXT NOT NULL DEFAULT '',
    action       TEXT NOT NULL,
    entity_type  TEXT NOT NULL DEFAULT '',
    entity_id    INTEGER,
    entity_label TEXT NOT NULL DEFAULT '',
    details      TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS audit_logs_org_idx ON audit_logs (org_id, created_at DESC)');

  // Organization-wide question bank: reusable questions any teacher in the org
  // can pull into a test. Mirrors the questions shape + topic/difficulty tags.
  await pool.query(`CREATE TABLE IF NOT EXISTS bank_questions (
    id             SERIAL PRIMARY KEY,
    org_id         INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type           TEXT NOT NULL,
    prompt         TEXT NOT NULL,
    options_json   TEXT NOT NULL DEFAULT '[]',
    correct_answer TEXT NOT NULL DEFAULT '',
    points         INTEGER NOT NULL DEFAULT 1,
    image_url      TEXT NOT NULL DEFAULT '',
    explanation    TEXT NOT NULL DEFAULT '',
    topic          TEXT NOT NULL DEFAULT '',
    difficulty     TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Auto-saved, resumable drafts of a test being created (JSON of builder state).
  await pool.query(`CREATE TABLE IF NOT EXISTS test_drafts (
    id          SERIAL PRIMARY KEY,
    teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',
    data        TEXT NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Existing organizations default to Basic.
  await pool.query("UPDATE organizations SET plan_id = (SELECT id FROM plans WHERE name = 'Basic') WHERE plan_id IS NULL");
}

export { pool, all, get, run, tx, init };
