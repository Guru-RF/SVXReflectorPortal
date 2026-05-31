#!/bin/bash
set -euo pipefail

# ── Example deploy script for Google Cloud Run ────────────────────────────────
# Copy to deploy.sh and fill in your own project / region / service name:
#   cp deploy-example.sh deploy.sh
# deploy.sh is gitignored so your infra details are never committed.

# ── Precheck: validate env.yaml before deploying ──────────────────────────────
# Catches typos like trailing commas in TG_INFO_JSON / CALLSIGN_INFO_JSON that
# would otherwise deploy silently and leave the portal falling back to defaults.

if ! command -v yq >/dev/null 2>&1; then
  echo "✗ yq not found — install with: brew install yq" >&2
  exit 1
fi

if ! yq eval '.' env.yaml >/dev/null 2>&1; then
  echo "✗ env.yaml is not valid YAML" >&2
  exit 1
fi

exports=$(yq eval '
  to_entries
  | .[]
  | "export \(.key)=\(.value | @sh)"
' env.yaml)
eval "${exports}"

for key in TG_INFO_JSON CALLSIGN_INFO_JSON; do
  raw="${!key:-}"
  if [[ -z "${raw}" ]]; then
    echo "✗ ${key} is empty in env.yaml" >&2
    exit 1
  fi
  if ! count=$(node -e "
    const obj = JSON.parse(process.env.${key});
    if (!obj || typeof obj !== 'object') throw new Error('not an object');
    console.log(Object.keys(obj).length);
  " 2>&1); then
    echo "✗ ${key} is not valid JSON:" >&2
    echo "  ${count}" >&2
    exit 1
  fi
  echo "✓ ${key}: ${count} entries"
done

echo "✓ env.yaml precheck passed — deploying"

# ── Deploy ────────────────────────────────────────────────────────────────────
# Replace the placeholders below with your own values.

PROJECT="YOUR_PROJECT_ID"
REGION="YOUR_REGION"          # e.g. europe-west1, us-central1
SERVICE="YOUR_SERVICE_NAME"   # e.g. svx-reflector-portal

gcloud config set project "${PROJECT}"
gcloud config set run/region "${REGION}"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com

gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --allow-unauthenticated \
  --env-vars-file env.yaml
