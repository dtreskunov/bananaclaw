---
name: add-opencode
description: Use OpenCode as an agent provider (AGENT_PROVIDER=opencode). OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per-session and per-group via agent_provider; host passes OPENCODE_* and XDG mount when spawning containers.
---

# OpenCode agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `mock`).

Trunk ships with only the `claude` provider baked in. This skill copies the OpenCode provider files in from the `providers` branch, wires them into the host and container barrels, installs dependencies, and rebuilds the image.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/opencode.ts`
- `container/agent-runner/src/providers/opencode.ts`
- `src/providers/opencode-registration.test.ts`
- `container/agent-runner/src/providers/opencode-registration.test.ts`
- `import './opencode.js';` line in `src/providers/index.ts`
- `import './opencode.js';` line in `container/agent-runner/src/providers/index.ts`
- `@opencode-ai/sdk` in `container/agent-runner/package.json`
- `ARG OPENCODE_VERSION` and `"opencode-ai@${OPENCODE_VERSION}"` in `container/Dockerfile`
- `src/opencode-dockerfile.test.ts` (the Dockerfile install guard)

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the OpenCode source files

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show origin/providers:src/providers/opencode.ts                                     > src/providers/opencode.ts
git show origin/providers:container/agent-runner/src/providers/opencode.ts              > container/agent-runner/src/providers/opencode.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-opencode.ts       > container/agent-runner/src/providers/mcp-to-opencode.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-opencode.test.ts  > container/agent-runner/src/providers/mcp-to-opencode.test.ts
git show origin/providers:container/agent-runner/src/providers/opencode.factory.test.ts > container/agent-runner/src/providers/opencode.factory.test.ts
```

Also copy the two barrel-registration guards — one per tree. These import the real provider barrels and assert `opencode` is registered, so they go red the moment a barrel import line is deleted or drifts:

```bash
git show origin/providers:src/providers/opencode-registration.test.ts                          > src/providers/opencode-registration.test.ts
git show origin/providers:container/agent-runner/src/providers/opencode-registration.test.ts   > container/agent-runner/src/providers/opencode-registration.test.ts
```

### 3. Append the self-registration imports

Each barrel gets one line appended at the end — skip if the line is already present.

`src/providers/index.ts`:

```typescript
import './opencode.js';
```

`container/agent-runner/src/providers/index.ts`:

```typescript
import './opencode.js';
```

### 4. Add the agent-runner dependency

Pinned. Bump deliberately, not with `bun update`. Use `1.17.13` — must match the `opencode-ai` CLI version pinned in step 5. Keep the SDK and CLI on the same version: the provider talks to the local `opencode serve` over HTTP, and matched versions guarantee the request/response and event shapes line up.

```bash
cd container/agent-runner && bun add @opencode-ai/sdk@1.17.13 && cd -
```

### 5. Add `opencode-ai` to the container Dockerfile

Two edits to `container/Dockerfile`, both idempotent (skip if already present):

**(a)** In the "Pin CLI versions" ARG block (around line 22), add after `ARG VERCEL_VERSION=...`:

```dockerfile
ARG OPENCODE_VERSION=1.17.13
```

> **Do not use `latest`** — pin an exact version and keep the CLI and SDK in lockstep. `latest` lets the CLI drift independently of the pinned SDK; if their HTTP API/event shapes ever diverge across a major bump, the provider breaks silently at runtime.

**(b)** Add a new standalone `RUN` block for the OpenCode CLI, after the existing per-CLI install blocks (around line 111, right after the `@anthropic-ai/claude-code` block). The Dockerfile splits each global CLI into its own layer for cache granularity — keep that pattern; do not collapse them into a single combined `pnpm install -g` call:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "opencode-ai@${OPENCODE_VERSION}"
```

### 6. Copy the Dockerfile install guard

The `opencode-ai` CLI is a globally-installed binary — not importable or typed — so a structural test guards the Dockerfile install. Copy it into the host test tree:

```bash
cp .claude/skills/add-opencode/opencode-dockerfile.test.ts src/opencode-dockerfile.test.ts
```

### 7. Build and validate

```bash
pnpm run build                                                    # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit    # container typecheck
pnpm exec vitest run src/providers/opencode-registration.test.ts  # host registration guard
pnpm exec vitest run src/opencode-dockerfile.test.ts              # Dockerfile install guard
cd container/agent-runner && bun test src/providers/opencode-registration.test.ts && cd -  # container registration guard
./container/build.sh                                              # agent image
```

All four must be clean before proceeding. Each guards a distinct integration point:

- **`src/providers/opencode-registration.test.ts`** (host, vitest) imports the real host barrel (`./index.js` → `listProviderContainerConfigNames`) and asserts `opencode` is present. It goes red if the `import './opencode.js';` line in `src/providers/index.ts` is deleted or drifts, or if that barrel fails to evaluate.
- **`container/agent-runner/src/providers/opencode-registration.test.ts`** (container, bun:test) imports the real container barrel (`./index.js` → `listProviderNames`) and asserts `opencode` is present. It goes red if the `import './opencode.js';` line in `container/agent-runner/src/providers/index.ts` is deleted or drifts. Because the barrel is imported unmocked, it also pulls in `opencode.ts`, which imports **`@opencode-ai/sdk`** — so this test implicitly guards the step-4 dependency too: if the package isn't installed, the import throws and the test goes red.
- **`src/opencode-dockerfile.test.ts`** parses `container/Dockerfile` and asserts both the `ARG OPENCODE_VERSION=...` (rejecting `latest`) and the `pnpm install -g "opencode-ai@${OPENCODE_VERSION}"` line are present. The `opencode-ai` CLI binary is not importable, so it is guarded by this structural test plus the container build — not the registration test.
- **`pnpm run build`** type-checks the host provider's consumption of the host-side container-config registry; the container typecheck does the same for the container provider against the agent-runner core APIs.

The pre-existing `opencode.factory.test.ts` imports `opencode.ts` directly and self-registers, so it stays green even if a barrel import is removed — it is a unit test of `createProvider('opencode')`, not the registration guard. Keep it; it adds factory coverage but does not stand in for the registration tests above.

> **Build cache gotcha:** The container buildkit caches COPY steps aggressively. If provider files were already present in the build context before, the new files may not be picked up. If you see "Unknown provider: opencode" after the build, prune the builder and rebuild:
> ```bash
> docker builder prune -f && ./container/build.sh
> ```

### 8. Propagate to existing per-group overlays

Each agent group has a live source overlay at `data/v2-sessions/<group-id>/agent-runner-src/providers/` that **overrides the image at runtime**. This overlay is created when the group is first wired and never auto-updated by image rebuilds. Any group that already existed before this skill ran needs the new files copied in manually.

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/opencode.ts "$overlay"
  cp container/agent-runner/src/providers/mcp-to-opencode.ts "$overlay"
  cp container/agent-runner/src/providers/index.ts "$overlay"
  echo "Updated: $overlay"
done
```

## Configuration

### Host `.env` (typical)

Set model/provider strings in the form OpenCode expects (often `provider/model-id`). **Put comments on their own lines** — a `#` inside a value is kept verbatim and breaks model IDs.

These variables are read **on the host** and passed into the container only when the effective provider is `opencode`. They do not switch the provider by themselves; the DB still needs `agent_provider` set (below).

- `OPENCODE_PROVIDER` — OpenCode provider id, e.g. `openrouter`, `anthropic`, `deepseek`.
- `OPENCODE_MODEL` — full model id in `provider/model` form, e.g. `deepseek/deepseek-chat`.
- `OPENCODE_SMALL_MODEL` — optional second model for lighter tasks; defaults to `OPENCODE_MODEL` if unset.
- `ANTHROPIC_BASE_URL` — **required for non-`anthropic` providers.** The opencode container provider passes this as the `baseURL` for the upstream provider config so requests route through Agent Vault's credential proxy or directly to the provider's API. Set it to the provider's API base URL (e.g. `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`).

Credentials belong to a NanoClaw user’s personal Agent Vault library. Configure
the exact HTTPS endpoint and documented authentication recipe in Credentials,
then grant only the intended groups. Values arrive through the write-only UI or
host stdin, never provider env or chat. A grant covers the whole credential,
including future URL rules.

Use `ncl credentials list --user <owner-id>` and
`ncl credentials grant --user <owner-id> --id <connection-id> --group <group-id>`.
For DeepSeek/OpenRouter use their documented bearer recipe; OpenCode Zen uses
`x-api-key`. Do not guess the header or broaden another owner’s grants.
Keep the socket gateway and CA enabled; there is no direct-network fallback.


### Per group / per session

Set the group provider with `ncl groups config update --id <group-id>
--provider opencode`. `container.json` is materialized from central
configuration on spawn; hand edits do not persist. Preserve approved credentials
and memory when switching providers.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and OpenCode providers.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared runtime reset to avoid MCP/zombie hangs.
- Session continuation uses UUID format (SDK 1.4.x / CLI 1.4.x). Stale sessions are cleared by `isSessionInvalid` on OpenCode-specific error patterns. If you see UUID-related errors after an accidental CLI upgrade, clear `session_state` in `outbound.db` and wipe the `opencode-xdg` directory under the session folder.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)_PROXY is set (e.g. Agent Vault).

## Next Steps

The registration and Dockerfile guards in step 7 verify the wiring. To confirm an end-to-end round-trip, set `agent_provider = 'opencode'` (or `"provider": "opencode"` in the group's `container.json`) on a test group, register the matching provider key in Agent Vault, and send a message. A clean exchange returns the model's reply with no `Unknown provider: opencode` error and no UUID/session warnings in the logs.

To remove this provider, see [REMOVE.md](REMOVE.md).
