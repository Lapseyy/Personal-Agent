#!/bin/sh
# Part 1, step 7: create your API_SERVER_KEY and store it in Secret Manager. Never put the key in the image, repo, README or video.
# Source: Assignment3_local_Gemma.pdf. Replace the example values (my-a3-project, a3-agent, ...) with your own.
# Run the commands one section at a time; read the matching step in the PDF first.

# --- Generate a key ---
# Generate a random key
python3 -c "import secrets; print(secrets.token_hex(24))"


# --- Store it in Secret Manager ---
printf '%s' 'PASTE_YOUR_KEY' | gcloud secrets create api-server-key --data-file=- --project=my-a3-project
gcloud secrets add-iam-policy-binding api-server-key --project=my-a3-project \
  --member=serviceAccount:a3-agent@my-a3-project.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
