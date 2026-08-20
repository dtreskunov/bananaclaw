# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

# ---- fx build stages (optional agent provider) -------------------------------
# fx publishes GitHub releases well behind its git tags, so it is built from
# source in a throw-away stage; only the resulting ~12MB binary is copied out.
#
# FX_COMMIT is the pin that matters — a tag can be moved, a commit hash cannot,
# and FX_VERSION is only the human-readable label for it. There is no official
# Zig image (the community one stopped at 0.10.1 in 2023, and alpine:edge's zig
# package is unpinnable), so the toolchain is the official tarball checked
# against its published digest.
ARG INSTALL_FX=false
ARG FX_VERSION=v0.4.5
ARG FX_COMMIT=14f00f6be246789496f987317cc5af28b81aad16
ARG ZIG_VERSION=0.16.0
ARG ZIG_SHA256_X86_64=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
ARG ZIG_SHA256_AARCH64=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17

# Selected by `FROM fx-build-${INSTALL_FX}`, so the toolchain is never even
# downloaded unless fx was asked for.
FROM node:22-slim AS fx-build-false
RUN mkdir -p /fx-out

FROM node:22-slim AS fx-build-true
ARG FX_VERSION
ARG FX_COMMIT
ARG ZIG_VERSION
ARG ZIG_SHA256_X86_64
ARG ZIG_SHA256_AARCH64
RUN --mount=type=cache,target=/root/.cache/zig,sharing=locked \
    set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    case "$(uname -m)" in \
      x86_64) zigarch=x86_64; zigsha="$ZIG_SHA256_X86_64" ;; \
      aarch64|arm64) zigarch=aarch64; zigsha="$ZIG_SHA256_AARCH64" ;; \
      *) echo "unsupported arch for fx: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/zig.tar.xz \
      "https://ziglang.org/download/${ZIG_VERSION}/zig-${zigarch}-linux-${ZIG_VERSION}.tar.xz"; \
    echo "${zigsha}  /tmp/zig.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/zig; \
    tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1; \
    mkdir -p /tmp/fx-src; cd /tmp/fx-src; \
    git init -q .; \
    git remote add origin https://github.com/vercel-labs/fx; \
    git fetch -q --depth 1 origin "$FX_COMMIT"; \
    git checkout -q FETCH_HEAD; \
    # Explicit target rather than native: native bakes in the build host's CPU
    # features, which then fault on older hardware running the same image.
    /opt/zig/zig build -Doptimize=ReleaseSafe -Dtarget="${zigarch}-linux"; \
    mkdir -p /fx-out; \
    install -m 0755 zig-out/bin/fx /fx-out/fx; \
    /fx-out/fx --version

FROM fx-build-${INSTALL_FX} AS fx-artifacts

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin versions for reproducibility. Bump deliberately — unpinned installs mean
# every rebuild silently picks up the latest and can break in lockstep across
# all users. The global Node CLIs (claude-code, agent-browser, vercel, opencode)
# are pinned in cli-tools.json so a skill can add one with a json-merge; Bun (the
# runtime) is pinned here because it installs from a different source.
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
        python3 \
        python3-venv \
        python3-pip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Shared Python venv so per-group `pip install` at image-rebuild time goes
# into an isolated, world-readable location (no PEP 668 --break-system-packages).
# Put its bin on PATH so installed console scripts (yt-dlp, etc.) resolve.
RUN python3 -m venv /opt/agent-venv && \
    /opt/agent-venv/bin/pip install --no-cache-dir --upgrade pip
ENV PATH="/opt/agent-venv/bin:$PATH"

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- fx CLI (optional agent provider) ---------------------------------------
# Only installed when INSTALL_FX=true so the default image stays lean. fx is a
# statically linked Zig binary (~12 MB unpacked) with no glibc dependency, so
# it is dropped straight into /usr/local/bin rather than going through pnpm.
# It is NOT in cli-tools.json — that file is npm-only.
#
# Built from source above; when fx is off, fx-artifacts is an empty directory.
ARG INSTALL_FX=false
COPY --from=fx-artifacts /fx-out/ /usr/local/bin/
RUN if [ "$INSTALL_FX" = "true" ]; then fx --version; fi

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Global Node CLIs the agent invokes at runtime live in cli-tools.json so a
# skill can add one with a json-merge instead of editing this Dockerfile.
# install-cli-tools.sh installs each via pnpm (pinned), writing the per-tool
# only-built-dependencies opt-ins it reads from the manifest.
COPY cli-tools.json install-cli-tools.sh /tmp/
RUN --mount=type=cache,target=/root/.cache/pnpm \
    sh /tmp/install-cli-tools.sh /tmp/cli-tools.json

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
