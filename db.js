// Database setup using Node's built-in SQLite (no native compiler needed).
// The whole database lives in a single file: data.db
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, 'data.db'));

// Recommended pragmas for a small web app.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// --- Schema -----------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time signup links teachers hand out to students.
CREATE TABLE IF NOT EXISTS signup_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used        INTEGER NOT NULL DEFAULT 0,
  student_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  negative_marking INTEGER NOT NULL DEFAULT 0,  -- 1 = deduct marks for wrong answers
  penalty          INTEGER NOT NULL DEFAULT 0,  -- marks deducted per wrong auto-graded answer
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id        INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('mcq', 'truefalse', 'short')),
  prompt         TEXT NOT NULL,
  options_json   TEXT NOT NULL DEFAULT '[]',  -- array of choices for mcq
  correct_answer TEXT NOT NULL DEFAULT '',    -- index for mcq, 'true'/'false', '' for short
  image_url      TEXT NOT NULL DEFAULT '',    -- optional image attached to the question
  points         INTEGER NOT NULL DEFAULT 1,
  position       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id     INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (test_id, student_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  test_id       INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at  TEXT,
  auto_score    INTEGER NOT NULL DEFAULT 0,  -- points from auto-graded questions
  manual_score  INTEGER NOT NULL DEFAULT 0,  -- points teacher awarded for short answers
  max_score     INTEGER NOT NULL DEFAULT 0,
  needs_grading INTEGER NOT NULL DEFAULT 0,  -- 1 if any short answers await grading
  UNIQUE (assignment_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id     INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  response       TEXT NOT NULL DEFAULT '',
  is_correct     INTEGER,          -- 1/0 for auto-graded, NULL for ungraded short
  points_awarded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- Lightweight migrations for databases created before a column existed ----
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('tests', 'negative_marking', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tests', 'penalty', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('questions', 'image_url', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'phone', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('signup_tokens', 'phone', "TEXT NOT NULL DEFAULT ''");

export default db;
