# dustcastle's agent sandbox image (ADR 0002/0008).
#
# Deliberately NOT a copy of agentstack's image: it ships NO toolchain manager (no
# mise, no per-language caches). The language Toolchain comes from the Nix Store
# mounted read-only at /nix/store (ADR 0008), so this image only hosts the agent
# HARNESS — git (the agent branches/commits/merges), bd (the implement phase reads
# issues in-container via `bd show`), and pi (the coding agent sandcastle drives) —
# plus a writable, keep-id-aligned `agent` user. Built once, dustcastle-owned
# (ensureImage of AGENT_SPEC), the way dustcastle owns nix-portable.
FROM node:22-bookworm

# git: sandcastle runs `git config --global` + the agent commits/diffs in-container.
# libicu72: the bd binary links it at runtime. ca-certificates: the bd install fetch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates libicu72 \
    && rm -rf /var/lib/apt/lists/*

# beads (bd): the implement phase reads its issue in-container (`bd show <ID>`).
RUN curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

# pi: the coding agent. A global npm install lands `pi` on PATH for every user.
# Retries/timeout harden the one network-heavy layer against transient registry hiccups.
RUN npm install -g @mariozechner/pi-coding-agent \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=300000

# Rename node:22's stock `node` user (uid/gid 1000) to `agent` with a writable
# /home/agent. sandcastle maps the host user onto uid 1000 via `--userns=keep-id`
# (its default containerUid/Gid), so /home/agent is writable and bind-mounts share
# an owner without a runtime chown. THIS is what lets `git config --global` write
# ~/.gitconfig — the exact step a stock image (no `agent` user, no writable home)
# died on with "could not lock config file /home/agent/.gitconfig: Permission denied".
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node \
    && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# sandcastle bind-mounts the per-issue git worktree at /home/agent/workspace and
# overrides the working dir there at start; nothing to copy in at build time.
ENTRYPOINT ["sleep", "infinity"]
