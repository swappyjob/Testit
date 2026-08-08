# Deploying to Google Cloud (Cloud Run + Cloud SQL)

This runs the same Docker image on **Cloud Run** (serverless), with **Cloud SQL
for PostgreSQL** as the database and a **Cloud Storage bucket** for uploaded
question images. No application code changes are needed — everything is
configured through environment variables.

> Tip: run all of this from **Google Cloud Shell** (open https://shell.cloud.google.com).
> It has `gcloud`, `psql`, and `pg_dump` preinstalled — no local install needed.
> Clone your repo there with `git clone https://github.com/swappyjob/Testit.git`
> and `cd Testit`.

---

## 0. Set your variables (edit these)

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="asia-south1"              # Mumbai; pick the region nearest you
export INSTANCE="testit-db"
export DB_NAME="testit"
export DB_USER="testit"
export DB_PASS="CHANGE-ME-strong-db-password"
export BUCKET="testit-uploads-$PROJECT_ID"   # must be globally unique
export SERVICE="testit"

gcloud config set project "$PROJECT_ID"
```

## 1. Enable the required APIs

```bash
gcloud services enable \
  run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com storage.googleapis.com
```

## 2. Create the Cloud SQL (PostgreSQL) instance, database, and user

```bash
gcloud sql instances create "$INSTANCE" \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region="$REGION" \
  --storage-size=10GB

gcloud sql databases create "$DB_NAME" --instance="$INSTANCE"
gcloud sql users create "$DB_USER" --instance="$INSTANCE" --password="$DB_PASS"

# The instance connection name, e.g. myproject:asia-south1:testit-db
export CONN="$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')"
echo "CONN=$CONN"
```

## 3. Create the uploads bucket

```bash
gcloud storage buckets create "gs://$BUCKET" \
  --location="$REGION" --uniform-bucket-level-access
```

## 4. Grant the service accounts access

```bash
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

# Cloud Run's service account -> connect to Cloud SQL + read/write the bucket
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="roles/cloudsql.client"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"
```

## 5. (Migrating from Render) Import your existing data — BEFORE the first deploy

Do this while the Cloud SQL database is still empty. Skip this whole step if you
chose to start fresh.

```bash
# a) Dump the Render database to a plain-SQL file.
#    Get the EXTERNAL connection string from Render > testit-db > Connections.
pg_dump "postgres://USER:PASS@RENDER_HOST/DBNAME" \
  --no-owner --no-acl --format=plain --file=testit.sql

# b) Let Cloud SQL read the file from the bucket, then import it.
export SQL_SA="$(gcloud sql instances describe "$INSTANCE" --format='value(serviceAccountEmailAddress)')"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SQL_SA" --role="roles/storage.objectViewer"
gcloud storage cp testit.sql "gs://$BUCKET/testit.sql"
gcloud sql import sql "$INSTANCE" "gs://$BUCKET/testit.sql" --database="$DB_NAME"
```

The app's startup migrations are idempotent (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`), so they run harmlessly on top of the imported data.

## 6. Create the environment file for Cloud Run

Create `gcp-env.yaml` (already git-ignored). Point `PGHOST` at the Cloud SQL
unix socket — the app connects with no SSL over that socket automatically.

```yaml
NODE_ENV: "production"
PGHOST: "/cloudsql/REPLACE_WITH_CONN"     # the $CONN value from step 2
PGUSER: "testit"
PGPASSWORD: "CHANGE-ME-strong-db-password"
PGDATABASE: "testit"
UPLOAD_DIR: "/mnt/uploads"
# Only needed if you are NOT migrating data (creates the first admin):
ADMIN_EMAIL: "you@example.com"
ADMIN_PASSWORD: "a-strong-admin-password"
```

## 7. Deploy to Cloud Run (builds the Dockerfile from source)

```bash
gcloud run deploy "$SERVICE" \
  --source . \
  --region="$REGION" \
  --allow-unauthenticated \
  --add-cloudsql-instances="$CONN" \
  --add-volume=name=uploads,type=cloud-storage,bucket="$BUCKET" \
  --add-volume-mount=volume=uploads,mount-path=/mnt/uploads \
  --env-vars-file=gcp-env.yaml
```

The first deploy takes a few minutes (it builds the image). When it finishes,
gcloud prints your **Service URL** (e.g. `https://testit-xxxx.a.run.app`).

## 8. Verify

- Open the Service URL — the landing page should load over HTTPS.
- Log in as admin. If you migrated data, use your existing admin. If you started
  fresh, use `ADMIN_EMAIL`/`ADMIN_PASSWORD`, then change the password in-app.
- Create a test with an image question; confirm the image displays (verifies the
  bucket mount).

## 9. Retire Render (after you're happy with GCP)

- Point any custom domain at the Cloud Run service instead.
- In Render, suspend or delete the `testit` web service and `testit-db` database
  to stop billing. Export a final backup first if you want one.

---

## Uploaded images already on Render (optional)

Cloud SQL migration covers the database, not the image files. If production has
question images you want to keep, copy them into the bucket, e.g.:

```bash
# From a machine that has the files (or download each from
# https://YOUR-RENDER-URL/uploads/<filename>), then:
gcloud storage cp ./uploads/* "gs://$BUCKET/"
```

New uploads after cutover go straight to the bucket automatically.

## Custom domain

Cloud Run → your service → **Manage Custom Domains** → add your domain and create
the shown DNS record. TLS is provisioned automatically.

## Notes & cost

- Cloud Run **scales to zero** when idle, so you mostly pay for Cloud SQL. The
  `db-f1-micro` tier is the cheapest; upgrade the tier later if needed.
- To avoid cold starts, add `--min-instances=1` to the deploy (costs more).
- Deploys are **manual**: re-run the step-7 command whenever you want to ship.
- Secrets are in `gcp-env.yaml` (git-ignored). For stronger security, move
  `PGPASSWORD`/`ADMIN_PASSWORD` to **Secret Manager** and reference them with
  `--set-secrets` instead.
