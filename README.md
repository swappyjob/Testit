# Online Test Platform

A simple website where **teachers create tests** and **students take them online**.

Built with Node.js + Express and **PostgreSQL** (via the `pg` driver). Passwords
are hashed with scrypt.

## Features

- 👩‍🏫 **Teachers** can register, log in, and:
  - Create tests with **multiple-choice**, **true/false**, and **short-answer** questions
  - Create students and get a **unique signup link** to send them
  - **Assign** tests to specific students
  - View **results** and **grade** written (short-answer) responses
- 🎓 **Students** sign up via their link, log in, take assigned tests, and see auto-graded scores instantly.

## Run it locally

Requires a running **PostgreSQL** server and a database named `testit`:

```bash
createdb testit          # once
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

### Database connection

The app reads standard Postgres environment variables, with local defaults:

| Variable | Default |
|----------|---------|
| `PGHOST` | `localhost` |
| `PGPORT` | `5432` |
| `PGUSER` | `postgres` |
| `PGPASSWORD` | `postgres` |
| `PGDATABASE` | `testit` |

### Tests

`npm test` runs the full suite against a separate `testit_test` database (create it
once with `createdb testit_test`), so your real data is never touched.

## How to use

1. Open the site and choose **I'm a Teacher → Create account**.
2. Under **Create Test**, add questions and save.
3. Under **Students**, add a student — copy the signup link and send it to them
   (WhatsApp, email, etc.).
4. The student opens the link, sets a password, and lands on their dashboard.
5. Back as the teacher, open a test → **Assign** → tick the student.
6. The student logs in, takes the test, and submits. Multiple-choice and true/false
   are graded instantly; short answers wait for you.
7. As the teacher, open the test → **Results** → **View / Grade** to score written answers.

## Project structure

```
server.js      Express server + all API routes (async)
db.js          Postgres connection pool, schema, and query helpers
public/        Frontend (HTML/CSS/JS, no build step)
run-tests.mjs  Test runner (spins up an isolated testit_test database)
```
