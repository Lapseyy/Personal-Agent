#!/bin/sh
# Part 2, step 3: store the Tailscale auth key in Secret Manager.
# Source: Assignment3_local_Gemma.pdf. Replace the example values (my-a3-project, a3-agent, ...) with your own.
# Run the commands one section at a time; read the matching step in the PDF first.

# --- First time: create the secret ---
printf '%s' 'tskey-auth-k1AbCdEf...' | gcloud secrets create tailscale-authkey --data-file=- --project=my-a3-project
gcloud secrets add-iam-policy-binding tailscale-authkey --project=my-a3-project \
  --member=serviceAccount:a3-agent@my-a3-project.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor

# --- If the secret already exists: add a new version instead ---
printf '%s' 'tskey-auth-...' | gcloud secrets versions add tailscale-authkey --data-file=- --project=my-a3-project
