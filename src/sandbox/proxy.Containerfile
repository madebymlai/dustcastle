# dustcastle's egress-proxy image (ADR 0005/0010).
#
# The dual-homed filtering proxy is pure Node — proxy.js uses only node builtins
# (http/net), no npm deps — so a stock Node base plus the two compiled files is the
# whole image. We COPY rather than bind-mount so the container is self-contained and
# host-path-independent, preserving ADR 0005's "host-OS-agnostic, podman-only"
# property (the same image runs on Linux/macOS/Windows podman). Built once,
# dustcastle-owned (ensureProxyImage), the way dustcastle owns the agent image.
#
# Deliberately NO ENTRYPOINT: proxyContainerRunArgs (confine.ts) runs the proxy as
# `node /opt/dustcastle/proxy-main.js`, passing the allowlist + port via env. The
# base image's docker-entrypoint.sh execs that command unchanged.
FROM node:20-alpine

# The build context is this file's own directory (proxyBuildArgs → dirname): in the
# shipped CLI that is dist/sandbox/, which holds the compiled proxy.js + proxy-main.js.
COPY proxy.js proxy-main.js /opt/dustcastle/
