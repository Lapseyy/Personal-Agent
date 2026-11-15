#!/bin/sh
# Part 1, step 6: Tailscale Serve (only if you use it) -> web_ui.py on $PORT.
# Source: Assignment3_local_Gemma.pdf. Replace the example values (my-a3-project, a3-agent, ...) with your own.
# Run the commands one section at a time; read the matching step in the PDF first.

tailscale serve --bg --https=443 http://127.0.0.1:$PORT
