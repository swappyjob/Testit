# Online Test Platform

A simple website where **teachers create tests** and **students take them online**.

Built with a **React** (Vite) frontend and a **Node.js + Express** API backed by
**PostgreSQL** (via the `pg` driver). Passwords are hashed with scrypt.

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
createdb testit                 # once
npm install                     # backend deps
npm install --prefix client     # frontend deps (once)
npm start                       # builds the React app + runs the server
```

`npm start` builds the React frontend (`client/`) into `client/dist` and then
starts the Express server, which serves that build. Open
**http://localhost:3000** in your browser.

For frontend development with hot-reload, run the Vite dev server separately
(`npm run dev --prefix client`, on port 5173) — it proxies `/api` to Express.

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
server.js       Express server + all API routes (async); serves the React build
db.js           Postgres connection pool, schema, and query helpers
client/         React + Vite frontend (src/pages, src/teacher, components, router)
public/uploads/ Uploaded question images (served at /uploads)
run-tests.mjs   Test runner (spins up an isolated testit_test database)
```

`npm start` also adds a `build:client` step; the Express server serves
`client/dist` and falls back to `index.html` for client-side routes.
