gcloud services enable run.googleapis.com cloudbuild.googleapis.com

gcloud run deploy YOUR_SERVICE_NAME \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars UPSTREAM_WS_URL=wss://feed.example.org/,UI_TITLE="SVX Reflector • Live"

