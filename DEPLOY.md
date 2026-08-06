# Deploying to production

This app is a Node/Express server that serves a built React client and talks to
PostgreSQL. It is configured entirely through environment variables and ships
with a `Dockerfile`, so it runs the same on Render, Railway, Fly.io, Google
Cloud Run, or a plain Linux VM.

The recommended path below is **Render** (managed Postgres, free auto-HTTPS,
deploy from GitHub). Because everything is containerized, moving to another host
later is mostly re-pointing a new platform at the same repo/image.

---

## What the code already does for production

- Reads a single `DATABASE_URL` (with SSL) when present; falls back to local
  `PG*` vars otherwise.
- Sends **Secure**, httpOnly session cookies and trusts the proxy when
  `NODE_ENV=production`.
- Stores uploaded question images under `UPLOAD_DIR` (point it at a persistent
  disk so images survive redeploys).
- Creates the first admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on first boot
  (idempotent — never resets an existing account).

## Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `NODE_ENV` | yes | Set to `production`. |
| `DATABASE_URL` | yes | Managed Postgres connection string. |
| `UPLOAD_DIR` | yes | Persistent path for uploads, e.g. `/data/uploads`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first boot | Creates the platform admin. |
| `ADMIN_NAME` | no | Defaults to `Administrator`. |
| `PORT` | no | Injected by most hosts; defaults to 3000. |
| `SMTP_*` / `SMTP_FROM` | no | Enable "forgot password" emails; otherwise links are logged. |
| `PGSSLMODE=disable` | no | Only for a DB on a private network without SSL. |

---

## Option A — Render (one-click Blueprint)

1. Push this repo to GitHub (already done).
2. In Render: **New +** → **Blueprint** → select this repository. Render reads
   `render.yaml` and proposes a web service + a Postgres database + a 1 GB disk.
3. When prompted, fill the secret values (marked `sync: false`):
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` (choose a strong password), optional `ADMIN_NAME`.
   - Optional `SMTP_*` if you want password-reset emails.
   `DATABASE_URL` and `UPLOAD_DIR` are wired automatically.
4. Click **Apply**. First build runs the Dockerfile (builds the React client,
   then starts the server); the database schema is created automatically on boot.
5. Open the service URL (e.g. `https://testit.onrender.com`) and log in as the
   admin. **Change the admin password in-app** (⚙ Profile → Change password).

> The `starter` web plan + `basic-256mb` database are the smallest paid tiers
> and are needed for the persistent disk. Adjust plans in the Render UI anytime.

### Custom domain
Render → your service → **Settings → Custom Domains** → add your domain, then
create the shown CNAME (or A/ALIAS) record at your DNS provider. TLS is issued
automatically.

---

## Option B — Any Docker host (Railway, Fly.io, Cloud Run, a VM)

```bash
docker build -t testit .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://user:pass@host:5432/testit" \
  -e UPLOAD_DIR=/data/uploads \
  -e ADMIN_EMAIL=admin@yourdomain.com \
  -e ADMIN_PASSWORD='a-strong-password' \
  -v testit-uploads:/data/uploads \
  testit
```

Put a TLS-terminating proxy (the platform's, or nginx + certbot on a VM) in
front so traffic is HTTPS. The schema is created automatically on first boot.

---

## Bringing existing local data (optional)

To move your current local database to the production one:

```bash
# 1) Dump your local DB
pg_dump "postgres://postgres:postgres@localhost:5432/testit" -Fc -f testit.dump

# 2) Restore into the production DB (get the URL from your host)
pg_restore --no-owner --clean --if-exists \
  -d "postgres://USER:PASS@PROD_HOST:5432/testit" testit.dump
```

Then copy your local `public/uploads/` files to the production `UPLOAD_DIR`
(e.g. via the host's disk shell or an `scp`/rsync to the VM).

---

## Post-launch checklist

- [ ] Logged in as admin over **https://** and changed the admin password.
- [ ] Created/verified organizations and their plans.
- [ ] Set up `SMTP_*` (or confirmed reset links appear in logs) so teachers/
      students can reset passwords.
- [ ] Confirmed uploaded question images persist across a redeploy.
- [ ] Enabled automatic database backups in your host's dashboard.
