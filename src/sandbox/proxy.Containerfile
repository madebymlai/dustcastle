# dustcastle's egress-proxy image (ADR 0005/0010).
#
# The dual-homed filtering proxy is Node plus pino for structured stderr JSON. We
# COPY rather than bind-mount so the container is self-contained and
# host-path-independent, preserving ADR 0005's "host-OS-agnostic, podman-only"
# property (the same image runs on Linux/macOS/Windows podman). Built once,
# dustcastle-owned (ensureImage of PROXY_SPEC), the way dustcastle owns the agent image.
#
# Deliberately NO ENTRYPOINT: proxyContainerRunArgs (confine.ts) runs the proxy as
# `node /opt/dustcastle/proxy-main.js`, passing the allowlist + port via env. The
# base image's docker-entrypoint.sh execs that command unchanged.
FROM node:20-alpine

WORKDIR /opt/dustcastle
RUN npm install --omit=dev --no-audit --no-fund pino@10.3.1

# The build context is this file's own directory (buildArgs → dirname): in the
# shipped CLI that is dist/sandbox/, which holds the compiled proxy files.
COPY proxy.js proxy-main.js proxy-logger.js /opt/dustcastle/
