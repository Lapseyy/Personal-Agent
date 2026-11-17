# A3 hybrid agent: OpenClaw gateway + router plugin + Tailscale (userspace) + gog.
# Pinned versions; pin the two base images by digest once the first build succeeds.
FROM tailscale/tailscale:v1.104.7 AS tailscale

FROM node:24.22.1-bookworm-slim

ARG OPENCLAW_VERSION=2026.10.9
ARG GOG_VERSION=0.48.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# Tailscale binaries only; the daemon runs in userspace mode as a non-root user.
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale

# gog (gogcli) for Gmail/Calendar, verified against the release checksum file.
RUN cd /tmp \
 && curl -fsSLO "https://github.com/openclaw/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_linux_amd64.tar.gz" \
 && curl -fsSLO "https://github.com/openclaw/gogcli/releases/download/v${GOG_VERSION}/checksums.txt" \
 && grep " gogcli_${GOG_VERSION}_linux_amd64.tar.gz\$" checksums.txt | sha256sum -c - \
 && mkdir /tmp/gog \
 && tar -xzf "gogcli_${GOG_VERSION}_linux_amd64.tar.gz" -C /tmp/gog \
 && find /tmp/gog -type f \
 && mkdir -p /usr/local/libexec \
 && install -m 0755 "$(find /tmp/gog -type f \( -name gog -o -name gogcli \) | head -n 1)" /usr/local/libexec/gog-real \
 && /usr/local/libexec/gog-real --version \
 && rm -rf /tmp/gog /tmp/gogcli_* /tmp/checksums.txt

RUN npm install -g "openclaw@${OPENCLAW_VERSION}" && npm cache clean --force

# The command named `gog` is our wrapper (src/approval/gogWrapper.ts). It checks every call
# against the send-approval policy and only then starts the real binary above.
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /opt/a3/src/approval/gogWrapper.ts "$@"\n' > /usr/local/bin/gog \
 && chmod 0755 /usr/local/bin/gog \
 && printf '#!/bin/sh\nexec sh /opt/a3/container/jobs.sh "$@"\n' > /usr/local/bin/a3job \
 && chmod 0755 /usr/local/bin/a3job

# OpenClaw looks for the Tailscale socket here; it must be writable by `node`.
RUN mkdir -p /var/run/tailscale /opt/a3 /mnt/agent-state \
 && chown node:node /var/run/tailscale /opt/a3 /mnt/agent-state

WORKDIR /opt/a3
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node openclaw.plugin.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config
COPY --chown=node:node container ./container

# A build context uploaded from Windows arrives with loose file modes. OpenClaw refuses to
# load a plugin from world-writable paths, so normalise: owner rw, everyone else read-only.
RUN chmod -R u=rwX,go=rX /opt/a3

USER node
ENV HOME=/home/node
ENV OPENCLAW_STATE_DIR=/home/node/.openclaw
ENV OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json
ENV A3_STATE_MOUNT=/mnt/agent-state
ENV A3_OLLAMA_BASE_URL=http://127.0.0.1:11435
ENV A3_RATE_LIMIT_FLAG_FILE=/mnt/agent-state/flags/simulate-429
ENV OLLAMA_API_KEY=ollama-local
# gog keeps its client and encrypted token store inside the OpenClaw state directory, so
# the Google sign-in is captured by the same snapshot. The password comes from Secret Manager.
ENV GOG_HOME=/home/node/.openclaw/gogcli
ENV GOG_KEYRING_BACKEND=file
ENV A3_GOG_REAL=/usr/local/libexec/gog-real
ENV NODE_ENV=production

EXPOSE 18789
# Invoked through sh: a build context uploaded from Windows has no executable bits.
ENTRYPOINT ["tini", "--", "sh", "/opt/a3/container/entrypoint.sh"]
