# Source: Assignment3_local_Gemma.pdf, Part 2, step 5: add to your startup script, after `tailscale up` succeeds.

# OpenClaw checks the grader's identity with `tailscale whois` on the default socket path.
# If you use a private --socket (non-root container), link it there:
mkdir -p /var/run/tailscale
ln -sf "$SOCK" /var/run/tailscale/tailscaled.sock

# HTTPS on your tailnet name -> the gateway (18789 is an example port)
tailscale --socket="$SOCK" serve --bg --https=443 http://127.0.0.1:18789
