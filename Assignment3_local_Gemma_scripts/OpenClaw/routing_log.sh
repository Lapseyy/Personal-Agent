#!/bin/sh
# Part 3: routing log command for the video.
# Source: Assignment3_local_Gemma.pdf. Replace the example values (my-a3-project, a3-agent, ...) with your own.
# Run the commands one section at a time; read the matching step in the PDF first.

# --- Once: sign in ---
gcloud auth login
gcloud config set project my-a3-project

# --- Routing log (OpenClaw reference build; your filter and field names may differ) ---
gcloud logging read 'jsonPayload.component="a3-router"' --project=my-a3-project --freshness=30m --order=desc \
  --format="table(timestamp.date('%H:%M:%S'),jsonPayload.rule,jsonPayload.target,jsonPayload.model,jsonPayload.ok)"
