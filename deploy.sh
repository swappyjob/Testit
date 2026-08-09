#!/usr/bin/env bash
# One-command deploy to Cloud Run. Run from the repo root in Cloud Shell:
#   bash deploy.sh
#
# Cloud Run keeps the env vars, Cloud SQL connection and uploads bucket from the
# previous deploy, so this only needs to rebuild + ship the latest code.
set -e

REGION="asia-south1"
SERVICE="testit"
INSTANCE="testit-db"

echo "==> Pulling latest code..."
git pull

echo "==> Making sure the database is running..."
gcloud sql instances patch "$INSTANCE" --activation-policy=ALWAYS --quiet || true

echo "==> Deploying to Cloud Run (this builds the image, ~3-7 min)..."
gcloud run deploy "$SERVICE" --source . --region="$REGION" --quiet

echo "==> Done. Your site: https://testit-611427721600.asia-south1.run.app"
