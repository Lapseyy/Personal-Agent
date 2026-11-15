#!/bin/sh
# Part 3: routing log command for the video.
# Source: Assignment3_local_Gemma.pdf. Replace the example values (my-a3-project, a3-agent, ...) with your own.
# Run the commands one section at a time; read the matching step in the PDF first.

# --- Once: sign in ---
gcloud auth login
gcloud config set project my-a3-project

# --- Routing log (Hermes reference build; your filter and field names may differ) ---
gcloud logging read \
  'jsonPayload.kind="route_decision" OR jsonPayload.kind="route_result" OR jsonPayload.kind="model_call"' \
  --project="my-a3-project" --freshness=30m --order=desc --limit=30 \
  --format='table(timestamp.date("%H:%M:%S"), jsonPayload.kind, jsonPayload.requestId, jsonPayload.target, jsonPayload.servedModel, jsonPayload.reason, jsonPayload.succeeded, jsonPayload.latencyMs)'
