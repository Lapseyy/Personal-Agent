#!/bin/sh
# Part 2, step 5: OpenClaw config. Use your exact URL (https://, machine name and tailnet, no trailing slash). Restart the gateway afterwards.
# Source: Assignment3_local_Gemma.pdf. Replace the example values (my-a3-project, a3-agent, ...) with your own.
# Run the commands one section at a time; read the matching step in the PDF first.

openclaw config set gateway.auth.allowTailscale true
openclaw config set gateway.controlUi.allowedOrigins '["https://a3-cloud-agent.tail1a2b3c.ts.net"]' --strict-json
openclaw config validate
