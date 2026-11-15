# Source: Assignment3_local_Gemma.pdf, Part 2, step 4: keep Tailscale's identity across restarts.
# In your container's startup script, change the first form to the second.

# before (state lost on every restart)
tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --state=mem: --socket="$SOCK" &

# after (state kept in the bucket; /mnt/agent-state is an example mount path)
mkdir -p /mnt/agent-state/tailscale
tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 \
  --state=/mnt/agent-state/tailscale/tailscaled.state --socket="$SOCK" &
