# Build & Runtime

NanoClaw runs a split stack: the host is Node + pnpm, the agent container is
Bun. All host/runner communication uses the acknowledged per-session Unix
socket; host SQLite stores are not mounted into the container. There are no
shared code modules between the runtimes.

The host requires Node 22 or newer (including the host-side AI SDK streaming
speech-to-text integration). The host and container pin their own AI SDK
versions independently; installing the container dependency does not make it
available to the host.

## Why the split

- **Host stays on Node** because Baileys (WhatsApp) depends on `libsignal-node` native bindings and a long-tested WebSocket/HTTP stack. Bun's Node-API compat has improved, but this isn't where we want risk.
- **Container runs Bun** because `bun:sqlite` is built-in (no native compile of `better-sqlite3` per image rebuild), source runs directly (no tsc build step at image build or session wake), and `bun install` is ~5-10× faster than `npm install`.

Host and container each have their own package tree:

```
/                             pnpm + Node 22
  pnpm-lock.yaml              host deps (channels, Chat SDK, Baileys, better-sqlite3, etc.)
  pnpm-workspace.yaml         minimumReleaseAge + onlyBuiltDependencies policy

/container/agent-runner/      Bun 1.3+
  bun.lock                    agent-runner runtime deps (Claude Agent SDK, MCP SDK, zod, etc.)
  package.json                @types/bun, typescript devDeps for type-checking
```

The container image also has pnpm + Node inside for global CLIs (`@anthropic-ai/claude-code`, `agent-browser`, `vercel`). Those are Node binaries the agent invokes at runtime, not library deps. Keeping them on pnpm preserves the supply-chain policy for CLI versions.

## Lockfiles

| Tree | Lockfile | Manager | Regenerate after dep change |
|------|----------|---------|----------------------------|
| Host | `pnpm-lock.yaml` | pnpm 10 | `pnpm install` |
| Agent-runner | `container/agent-runner/bun.lock` | Bun 1.3+ | `cd container/agent-runner && bun install` |

Both are committed. CI and the Dockerfile run `--frozen-lockfile` variants — any drift between `package.json` and lockfile fails the build.

## Supply chain

- **Host + global CLIs** (pnpm): `minimumReleaseAge: 4320` (3-day hold on new versions), `onlyBuiltDependencies` allowlist for postinstall scripts. See `pnpm-workspace.yaml` and `docs/SECURITY.md`.
- **Agent-runner** (Bun): no release-age policy — Bun doesn't have an equivalent today. The defenses are `bun.lock` pinning plus version-pinned CLIs/Bun itself via Dockerfile ARGs. When bumping `@anthropic-ai/claude-agent-sdk` or any runtime dep, review the release date on npm and bump deliberately, not via `bun update`.

## Image build surface

`container/Dockerfile` is a single-stage build on `node:22-slim`:

- **Pinned ARGs** — `BUN_VERSION`, `CLAUDE_CODE_VERSION`, `AGENT_BROWSER_VERSION`, `VERCEL_VERSION`. Bump deliberately in PRs.
- **CJK fonts** — `ARG INSTALL_CJK_FONTS=false`. `container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through. Default build saves ~200MB; opt in when the user works with Chinese/Japanese/Korean content.
- **BuildKit cache mounts** — `/var/cache/apt`, `/var/lib/apt`, `/root/.bun/install/cache`, `/root/.cache/pnpm`. Rebuilds where `package.json`/`bun.lock` haven't changed are fast. Requires BuildKit (default on Docker 23+, Apple Container-compat).
- **`tini` as init** — reaps Chromium zombies, forwards signals so in-flight `outbound.db` writes finalize on SIGTERM.
- **`ffmpeg` / `ffprobe`** — inspect and normalize eligible native-provider audio attachments; installed by the image's system package block.
- **`entrypoint.sh`** (extracted) — `exec bun run /app/src/index.ts` under tini. Readable and diffable.
- **No compiled `/app/dist`** — Bun runs TS directly. The host also mounts fresh source over `/app/src` at session start, so host edits take effect without rebuilding the image.

## Audio attachment preparation

Only native-provider models with catalog `audio` input capability and the
OpenAI-compatible Chat adapter enter media preparation. Other adapters and
unknown/text-only models receive the original filesystem reference, without
running media tools. This is independent of browser streaming dictation.

Preparation keeps the original attachment intact and inspects its actual
container/codec using `ffprobe`. Compatible MP3 or signed 16-bit PCM WAV is
embedded directly. Common audio containers (OGG/Opus, WebM, M4A/AAC, FLAC, and
other supported WAV encodings) are converted to MP3. Declaring an arbitrary
file `audio/*` does not make it valid audio. Audio capability metadata does not
specify endpoint codec acceptance; normalization targets the adapter's MP3/WAV
wire formats, not a universal promise that the endpoint will accept them.
The conversion preset is `libmp3lame`, 128 kbit/s, stereo, 48 kHz, with
metadata stripped and one encoder thread. Direct embedding accepts mono/stereo
audio up to 48 kHz; otherwise eligible content is normalized.

Resource policy:

- Original file: at most **20 MiB** and **10 minutes**.
- Each probe: **10 seconds**; conversion: **30 seconds**, with cancellation.
  Duration-less browser WebM gets an additional bounded full PCM decode to
  measure duration, rather than accepting a silently truncated prefix.
- Inline audio output: at most **10 MiB** per file.
- Aggregate inline attachment budget: **16 MiB of base64**, including prior
  user attachment parts replayed into the request. New attachments that do not
  fit remain file references; existing conversation history is not discarded.
- Failed inspection, unsupported content, unavailable tools, and exceeded
  limits produce a reason in the prompt and logs, not automatic transcription.
  A rejected model request is not reissued with altered attachment content.

Conversions are not cached. Each preparation uses a private temporary directory
in the container's temporary filesystem for inspection snapshots and output
validation. It is removed after success, failure, or cancellation; files left
by a forcibly killed process disappear with the container. Nothing is written
to the persistent runner-state mount for conversion reuse. Already-embedded
audio remains in conversation history as base64, so replay does not require
the original file or another conversion.

**Upgrading an existing install:** rebuild the base agent image using
`./container/build.sh`, rebuild any per-group derivative images, and recycle
affected containers so they use the new image. A host restart alone adopts
existing containers and does not install media tools. Old images continue to
work, but eligible audio falls back with a missing-tool reason. Verify
`ffmpeg -version` and `ffprobe -version` inside the selected agent image.
Local media tests also require these binaries on `PATH`.

## Session wake (two paths)

1. **Base image ENTRYPOINT** — used for stdin-piped test invocations like the sample in `container/build.sh`: `tini --> entrypoint.sh` captures stdin to `/tmp/input.json`, then `exec bun run src/index.ts`.
2. **Host-spawned session** — `src/container-runner.ts` at line ~301 uses `--entrypoint bash` with `-c 'exec bun run /app/src/index.ts'`. Bypasses tini (Docker's default PID 1 handling applies). Stdin is unused; durable IO uses the mounted session DBs and live runner status uses the per-session Unix socket.

Both paths end with Bun running the same source file from `/app/src/index.ts`.

## CI shape

`.github/workflows/ci.yml` installs both Node (with pnpm cache) and Bun, then runs in order:

1. `pnpm install --frozen-lockfile` (host)
2. `bun install --frozen-lockfile` in `container/agent-runner/` (container)
3. `pnpm run format:check`
4. `pnpm exec tsc --noEmit` (host typecheck)
5. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (container typecheck)
6. `pnpm exec vitest run` (host tests)
7. `bun test` in `container/agent-runner/` (container tests)

Any failure fails the PR.

## Key invariants

- **Session DBs must use `journal_mode=DELETE`.** WAL's `-shm` memory-map doesn't cross VirtioFS between host and guest. See the doc comment at the top of `container/agent-runner/src/db/connection.ts` and `src/session-manager.ts`.
- **Named SQL parameters in the container require the prefix in JS object keys.** `bun:sqlite` does not auto-strip `@`/`$`/`:` the way `better-sqlite3` does on the host. Use `$name` in both SQL and keys: `.run({ $id: msg.id })`. Positional `?` params work normally.
- **Agent-runner tests run under `bun:test`, not vitest.** `vitest.config.ts` excludes the `container/agent-runner/` tree because vitest runs on Node and can't load `bun:sqlite`.
- **No tsc build step in the container image.** Re-adding one would reintroduce the ~200-500ms per-session-wake cost we removed.
- **Global container CLIs stay on pnpm, not Bun.** `agent-browser`, `@anthropic-ai/claude-code`, `vercel` and any future Node CLIs the agent invokes should be pinned versions under the Dockerfile's pnpm global-install block. `bun install -g` would bypass the pnpm supply-chain policy.

## Migration history

This structure replaced a uniform npm-on-Node stack across both host and container. The pnpm migration landed first (PR #1771) to bring the host under supply-chain policy, then the container moved to Bun to eliminate native-module compilation and the per-wake tsc step. The split was chosen over going full-Bun because Baileys' native deps are the main risk surface on the host — the container has no such deps, so it benefits from Bun without taking the risk.
