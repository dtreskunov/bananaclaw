---
name: add-fx
description: Use fx (vercel-labs/fx) as an agent provider (AGENT_PROVIDER=fx). Talks ACP over a `fx acp` subprocess and reaches Vercel AI Gateway models through a loopback OneCLI credential shim. Per-session and per-group via agent_provider; host mounts per-session fx state and passes FX_* when spawning containers.
---

# fx agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `fx` | `mock`).

[fx](https://github.com/vercel-labs/fx) is a coding agent written in Zig, shipped as a single statically-linked binary (~12 MB). It speaks **ACP** (Agent Client Protocol) — newline-delimited JSON-RPC over stdin/stdout — and reaches models through Vercel AI Gateway.

> **fx is experimental.** Upstream self-describes as experimental and its stability policy is at <https://fx.sh/docs/stability>. Expect protocol churn across releases; the pinned commit and checksums exist so a bump is always a deliberate act.

## How this provider differs from the others

Two findings drove the design. Both were verified against the released binary, and both differ from what the fx docs imply:

1. **The embedded `libfx` NAPI addon is not usable here.** `libfx@0.0.3` crashes with **SIGILL** on its first `initialize` under both Node 22 and Bun 1.3 on a CPU without AVX-512 (tested: Intel N100). The released CLI binary runs fine on the same machine. So this provider drives a **`fx acp` subprocess**, not the in-process SDK.

2. **fx ignores every proxy and CA environment variable** (`HTTPS_PROXY`, `SSL_CERT_FILE`, and friends: zero references in the binary). OneCLI injects credentials by *being* an HTTPS proxy, so its normal transparent path cannot reach fx. Instead a **loopback shim** re-issues fx's requests from Bun's proxy-aware `fetch`. See "Credentials" below.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/fx.ts`
- `src/providers/fx-registration.test.ts`
- `src/fx-dockerfile.test.ts`
- `container/agent-runner/src/providers/fx.ts`
- `container/agent-runner/src/providers/fx-gateway-shim.ts`
- `container/agent-runner/src/providers/mcp-to-fx.ts`
- `import './fx.js';` line in `src/providers/index.ts`
- `import './fx.js';` line in `container/agent-runner/src/providers/index.ts`
- `ARG INSTALL_FX` + `ARG FX_VERSION` / `ARG FX_COMMIT` in `container/Dockerfile`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

fx needs **no** agent-runner dependency: the shim uses Bun's built-in `fetch` and `Bun.serve`, and the ACP transport uses `node:child_process`. There is nothing to `bun add`.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the fx source files

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show origin/providers:src/providers/fx.ts                                          > src/providers/fx.ts
git show origin/providers:container/agent-runner/src/providers/fx.ts                   > container/agent-runner/src/providers/fx.ts
git show origin/providers:container/agent-runner/src/providers/fx-gateway-shim.ts      > container/agent-runner/src/providers/fx-gateway-shim.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-fx.ts            > container/agent-runner/src/providers/mcp-to-fx.ts
git show origin/providers:container/agent-runner/src/providers/fx.test.ts              > container/agent-runner/src/providers/fx.test.ts
git show origin/providers:container/agent-runner/src/providers/fx-gateway-shim.test.ts > container/agent-runner/src/providers/fx-gateway-shim.test.ts
```

Also copy the two barrel-registration guards — one per tree. These import the real provider barrels and assert `fx` is registered, so they go red the moment a barrel import line is deleted or drifts:

```bash
git show origin/providers:src/providers/fx-registration.test.ts                        > src/providers/fx-registration.test.ts
git show origin/providers:container/agent-runner/src/providers/fx-registration.test.ts > container/agent-runner/src/providers/fx-registration.test.ts
```

### 3. Append the self-registration imports

Each barrel gets one line appended at the end — skip if the line is already present.

`src/providers/index.ts`:

```typescript
import './fx.js';
```

`container/agent-runner/src/providers/index.ts` — add `'./fx.js'` to `OPTIONAL_PROVIDER_MODULES` (optional, not required: a missing fx binary must not take the container down):

```typescript
const OPTIONAL_PROVIDER_MODULES = ['./opencode.js', './fx.js'];
```

### 4. Add the fx binary to the container Dockerfile

fx is a static binary, not an npm package — it does **not** belong in `container/cli-tools.json` (that file is npm-only) and must not be installed with `bun install -g`.

fx's GitHub releases lag its git tags badly (releases stopped at v0.0.4 while tags were at v0.4.5), and the newer tags carry the MCP fixes that matter. So fx is **built from source** in throw-away stages; only the ~12 MB binary is copied into the final image. Add these stages above the main `FROM node:22-slim`:

```dockerfile
ARG INSTALL_FX=false
ARG FX_VERSION=v0.4.5
ARG FX_COMMIT=14f00f6be246789496f987317cc5af28b81aad16
ARG ZIG_VERSION=0.16.0
ARG ZIG_SHA256_X86_64=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
ARG ZIG_SHA256_AARCH64=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17

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
    /opt/zig/zig build -Doptimize=ReleaseSafe -Dtarget="${zigarch}-linux"; \
    mkdir -p /fx-out; \
    install -m 0755 zig-out/bin/fx /fx-out/fx; \
    /fx-out/fx --version

FROM fx-build-${INSTALL_FX} AS fx-artifacts
```

Then, in the final image where the old download block sat:

```dockerfile
ARG INSTALL_FX=false
COPY --from=fx-artifacts /fx-out/ /usr/local/bin/
RUN if [ "$INSTALL_FX" = "true" ]; then fx --version; fi
```

`INSTALL_FX` defaults to `false` so installs that don't use fx keep a lean image.

> **Why `FROM fx-build-${INSTALL_FX}` instead of a shell `if`.** Stage selection happens in the build graph, so with fx off the toolchain is never downloaded and the Zig compile never runs — `fx-build-false` is just `mkdir /fx-out`. A shell guard inside one `RUN` would still pull the toolchain layer.
>
> **Why a commit hash, not just a tag.** A tag can be repointed at a different commit; the hash cannot. `FX_VERSION` is only the human-readable label for `FX_COMMIT`, and fetching by hash turns a moved tag into a hard error instead of a silent substitution. Get the pin with
> `git ls-remote --tags --refs https://github.com/vercel-labs/fx`.
>
> **Why the Zig tarball is pinned by digest.** There is no official Zig image — the usual community one (`euantorano/zig`) stopped tagging releases at 0.10.1 in 2023, and `alpine:edge`'s `zig` package is on a rolling branch that cannot be pinned. The official tarball plus its published `shasum` (from <https://ziglang.org/download/index.json>) is the only pinnable source. The required Zig version is `minimum_zig_version` in fx's `build.zig.zon`.
>
> **Why `-Dtarget` rather than a native build.** A native build bakes in the build host's CPU features, which then fault with SIGILL on older hardware running the same image. fx's own release workflow passes an explicit target too.
>
> fx vendors no dependencies (`.dependencies = .{}`), so the build needs no network access beyond the source fetch itself.

Then wire the flag through `container/build.sh` alongside the existing `INSTALL_CJK_FONTS` handling:

```bash
if [ -z "${INSTALL_FX:-}" ] && [ -f "../.env" ]; then
    INSTALL_FX="$(grep '^INSTALL_FX=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi
if [ "${INSTALL_FX:-false}" = "true" ]; then
    echo "fx provider: enabled (adds ~12MB)"
    BUILD_ARGS+=(--build-arg INSTALL_FX=true)
fi
```

### 5. Copy the Dockerfile install guard

The fx binary is not importable or typed, so a structural test guards the Dockerfile install — including that the checksum verification is still there:

```bash
cp .claude/skills/add-fx/fx-dockerfile.test.ts src/fx-dockerfile.test.ts
```

### 6. Enable and build

```bash
grep -q '^INSTALL_FX=' .env && sed -i.bak 's/^INSTALL_FX=.*/INSTALL_FX=true/' .env && rm -f .env.bak || echo 'INSTALL_FX=true' >> .env
```

```bash
pnpm run build                                                  # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit  # container typecheck
pnpm exec vitest run src/providers/fx-registration.test.ts      # host registration guard
pnpm exec vitest run src/fx-dockerfile.test.ts                  # Dockerfile install guard
cd container/agent-runner && bun test src/providers/ && cd -    # container tests + registration guard
./container/build.sh                                            # agent image
```

All must be clean before proceeding. Each guards a distinct integration point:

- **`src/providers/fx-registration.test.ts`** (host, vitest) imports the real host barrel and asserts `fx` appears in `listProviderContainerConfigNames()`. Goes red if the `import './fx.js';` line in `src/providers/index.ts` is deleted or that barrel stops evaluating.
- **`container/agent-runner/src/providers/fx-registration.test.ts`** (container, bun:test) imports the real container barrel and asserts `fx` appears in `listProviderNames()`. Goes red if `'./fx.js'` leaves `OPTIONAL_PROVIDER_MODULES`.
- **`src/fx-dockerfile.test.ts`** parses the Dockerfile and asserts the version is pinned (rejecting `latest`), both per-arch SHA256 ARGs are present, and `sha256sum -c -` still runs. The binary is not importable, so this structural test plus the container build are its only guards.
- **`pnpm run build`** type-checks the host provider against the container-config registry; the container typecheck does the same for the provider and shim.

> **Build cache gotcha:** the container buildkit caches COPY steps aggressively. If you see "Unknown provider: fx" after a build, `docker builder prune -f && ./container/build.sh`.

### 7. Propagate to existing per-group overlays

Each agent group has a live source overlay at `data/v2-sessions/<group-id>/agent-runner-src/providers/` that **overrides the image at runtime**. It is created when the group is first wired and never auto-updated by image rebuilds, so pre-existing groups need the new files copied in:

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/fx.ts "$overlay"
  cp container/agent-runner/src/providers/fx-gateway-shim.ts "$overlay"
  cp container/agent-runner/src/providers/mcp-to-fx.ts "$overlay"
  cp container/agent-runner/src/providers/index.ts "$overlay"
  echo "Updated: $overlay"
done
```

## Configuration

### Switch a group to fx

```bash
ncl groups config update --id <agent-group-id> --provider fx
ncl groups config update --id <agent-group-id> --model anthropic/claude-sonnet-4.5
```

Model IDs are AI Gateway IDs in `provider/model` form. fx's own default is `zai/glm-5.2`. List what your key can reach:

```bash
curl -s https://ai-gateway.vercel.sh/coding-agent/v1/models \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" | jq -r '.data[].id' | sort
```

### Host `.env` (all optional)

Read on the host and passed into the container only when the effective provider is `fx`. They do not switch the provider by themselves — the DB still needs `agent_provider` set (above).

- `FX_MODEL` — fleet-wide default model. A per-group `--model` wins over it.
- `FX_MAX_AGENT_STEPS` — caps the agent loop. Worth setting: it is the only guard against a runaway turn burning gateway credits.
- `FX_GATEWAY_BASE_URL` / `FX_GATEWAY_CHAT_URL` — **only** for a self-hosted gateway. Setting either one **disables the OneCLI credential shim** and passes your values straight through. Leave both unset for normal operation.
- `FX_UPSTREAM_GATEWAY_URL` — where the shim forwards to. Defaults to `https://ai-gateway.vercel.sh`.

### Credentials

Register the AI Gateway key in OneCLI with host pattern `ai-gateway.vercel.sh`:

```bash
onecli secrets create --name ai-gateway --host-pattern ai-gateway.vercel.sh --header Authorization --value-prefix "Bearer "
onecli agents grants attach-secret --id <agent-id> --secret-id <secret-id>
```

Because fx ignores `HTTPS_PROXY`, the container provider starts a loopback shim and points fx's two gateway knobs at it. The shim re-issues each request through Bun's `fetch` — which *is* proxy-aware — so OneCLI substitutes the real credential on the way out. fx only ever sees `AI_GATEWAY_API_KEY=placeholder`.

**Both knobs are required.** Redirecting only `FX_GATEWAY_BASE_URL` moves the model catalog (`/coding-agent/v1/*`) but leaves inference pointed at the real gateway, which then 401s on the placeholder key. Inference uses a separate URL (`/v3/ai/language-model`).

```
fx ──http──▶ 127.0.0.1 shim ──https+HTTPS_PROXY──▶ OneCLI ──▶ ai-gateway.vercel.sh
   placeholder key                                  real key injected here
```

**`NO_PROXY` must cover loopback.** OneCLI sets `HTTP_PROXY` and `NODE_USE_ENV_PROXY`, and Bun then routes *even 127.0.0.1* requests at the proxy, which resets them — the shim never gets called. The host provider adds `127.0.0.1,localhost` to `NO_PROXY` for this reason; OneCLI sets no `NO_PROXY` of its own, so that value survives. If you see `ECONNRESET` reaching the shim, check this first.

If you would rather not run the shim, put the key in `.env` as `AI_GATEWAY_API_KEY` — it is then visible in the container environment, which is exactly what OneCLI exists to avoid.

## Known limitations

- **No image input.** fx reports `promptCapabilities.image === false`, so image attachments cannot be sent as content blocks. The provider passes them as a filesystem path manifest appended to the prompt; the agent can read them with its own file tools, but the model does not see them as images.
- **No token usage.** The ACP stream carries no usage counts, so `TurnUsage` is unavailable and per-turn cost reporting will be empty for fx groups.
- **No native slash commands.** `supportsNativeSlashCommands = false`; NanoClaw's memory scaffold is used instead (`usesMemoryScaffold = true`).
- **Session state is per-session and local.** fx keeps auth/session state under `$HOME`, which the host pins to a per-session mount at `/fx-state`. Deleting a session directory discards its fx history.

## Verify end to end

```bash
ncl groups restart --id <agent-group-id> --message "reply with just: fx online"
```

Then watch the session's `outbound.db` for the reply. If nothing arrives, check `logs/nanoclaw.error.log` and look for `[fx-provider]` / `[fx-gateway-shim]` lines — the shim logs its listen address and upstream on start, and returns `502` with a `fx gateway shim:` message when the upstream is unreachable.
