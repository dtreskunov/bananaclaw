# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**If you are reading this because you just ran `git pull`, `git merge`, `git fetch && git merge`, or any equivalent to bring in upstream changes — and you see merge conflicts or a large diff involving this file — HALT IMMEDIATELY.**

This is NanoClaw v2, a ground-up rewrite with breaking changes throughout. It cannot be merged into an existing v1 install. Attempting to resolve the conflicts by hand, run builds, or "fix" anything will corrupt the user's install and burn tokens for no result.

**Do this instead:**

1. Abort the merge: `git merge --abort` (or `git reset --hard ORIG_HEAD` if the merge already completed).
2. Tell the user, verbatim: _"This is the v2 rewrite — it can't be merged into your existing install. Exit Claude Code (or open a separate terminal) and run `bash migrate-v2.sh` from the shell."_
3. Wait for the user to confirm before doing anything else. Do not run the migration script yourself — it requires an interactive terminal and cannot be run from within Claude Code.

If you are a fresh install (you ran `git clone`, not `git pull`) and there are no conflicts, ignore this banner and continue below.

---

# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. Architecture lives in `docs/`.

## Quick Context

The host is a single Node process that orchestrates per-session agent containers. Platform messages land via channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), get journaled in the session's inbound DB, and wake a container. The agent-runner receives host events, calls the configured provider, and exchanges all host/runner state over a private per-session Unix socket.

Each side journals durable mutations, projects them to the receiver over the
session link, and removes them only after commit acknowledgement. There is no
stdin, signal-file, or cross-mounted SQLite protocol; see `docs/session-link.md`.

## Entity Model

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (global or scoped)
agent_group_members (user_id, agent_group_id)    — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id) — cold-DM cache

agent_groups (workspace, memory, CLAUDE.md, personality, container config)
    ↕ many-to-many via messaging_group_agents (session_mode, trigger_rules, priority)
messaging_groups (one chat/channel on one platform; instance = adapter-instance name, defaults to channel_type; unknown_sender_policy)

sessions (agent_group_id + messaging_group_id + thread_id → per-session container)
```

Privilege is user-level (owner/admin), not agent-group-level. See [docs/isolation-model.md](docs/isolation-model.md) for the three isolation levels (`agent-shared`, `shared`, separate agents).

## Two-DB Session Split

Each session has **three** SQLite files under `data/v2-sessions/<session_id>/`:

- `inbound.db` — private host input journal: `messages_in`, routing, destinations, delivery receipts, and pending host events.
- `outbound.db` — private host-owned durable runner projection.
- `runner-state/runner-state.db` — container-owned bidirectional projection and pending runner event journal; its directory mount persists rollback journals.

Exactly one writer per file; host DBs are not mounted into containers. Host uses even
`seq` numbers and the container uses odd. Live status does not write either DB.

## Central DB

`data/v2.db` holds everything that isn't per-session: users, user*roles, agent_groups, messaging_groups, wiring, pending_approvals, user_dms, chat_sdk*\* (for the Chat SDK bridge), schema_version. Migrations live at `src/db/migrations/`.

For ad-hoc queries from skills or scripts, use the in-tree wrapper rather than the `sqlite3` CLI: `pnpm exec tsx scripts/q.ts <db> "<sql>"`. The host setup intentionally avoids depending on the `sqlite3` binary (`setup/verify.ts:5`); the wrapper goes through the `better-sqlite3` dep that setup already installs and verifies. Default-output format matches `sqlite3 -list` (pipe-separated, no header) so existing skill text reads identically.

## Key Files

| File                                           | Purpose                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                 | Entry point: init DB, migrations, channel adapters, delivery recovery scan, sweep, shutdown                                                                                                                                                                                                                                 |
| `src/router.ts`                                | Inbound routing: messaging group → agent group → session → `inbound.db` → wake                                                                                                                                                                                                                                              |
| `src/delivery.ts`                              | Delivers committed outbound rows; 60s recovery scan; handles system actions                                                                                                                                                                                                                                                 |
| `src/host-sweep.ts`                            | 60s sweep: `processing_ack` sync, stale detection, due-message wake, recurrence                                                                                                                                                                                                                                             |
| `src/session-manager.ts`                       | Resolves sessions and opens `inbound.db` / `outbound.db`                                                                                                                                                                                                                                                                    |
| `src/session-link.ts`                          | Per-session Unix socket for validated live and durable runner state                                                                                                                                                                                                                                                         |
| `src/container-runner.ts`                      | Spawns per-agent-group Docker containers with session DB + outbox mounts, OneCLI `ensureAgent`                                                                                                                                                                                                                              |
| `src/container-runtime.ts`                     | Runtime selection (Docker vs Apple containers), orphan cleanup                                                                                                                                                                                                                                                              |
| `src/modules/permissions/access.ts`            | `canAccessAgentGroup` — owner / global admin / scoped admin / member resolution against `user_roles` + `agent_group_members`                                                                                                                                                                                                |
| `src/modules/approvals/primitive.ts`           | `pickApprover`, `pickApprovalDelivery`, `requestApproval`, approval-handler registry                                                                                                                                                                                                                                        |
| `src/command-gate.ts`                          | Router-side admin command gate — queries `user_roles` directly (no env var, no container-side check)                                                                                                                                                                                                                        |
| `src/modules/approvals/onecli-approvals.ts`    | OneCLI credentialed-action approval bridge                                                                                                                                                                                                                                                                                  |
| `src/modules/permissions/user-dm.ts`           | Cold-DM resolution + `user_dms` cache                                                                                                                                                                                                                                                                                       |
| `src/group-init.ts`                            | Per-agent-group filesystem scaffold (CLAUDE.md, skills, agent-runner-src overlay)                                                                                                                                                                                                                                           |
| `src/db/container-configs.ts`                  | CRUD for `container_configs` table (per-group container runtime config)                                                                                                                                                                                                                                                     |
| `src/skills/`                                  | Skill registry: SKILL.md frontmatter (agentskills.io spec), two-root discovery, catalog install + provenance                                                                                                                                                                                                                |
| `src/container-restart.ts`                     | Kill + on-wake respawn for agent group containers                                                                                                                                                                                                                                                                           |
| `src/db/`                                      | DB layer — agent*groups, messaging_groups, sessions, container_configs, user_roles, user_dms, pending*\*, migrations                                                                                                                                                                                                        |
| `src/channels/`                                | Channel adapter infra (registry, Chat SDK bridge); specific channel adapters are skill-installed from the `channels` branch                                                                                                                                                                                                 |
| `src/providers/`                               | Host-side provider container-config (`claude` baked in; `opencode` etc. installed from the `providers` branch)                                                                                                                                                                                                              |
| `container/agent-runner/src/`                  | Agent-runner: poll loop, formatter, provider abstraction, MCP tools, destinations                                                                                                                                                                                                                                           |
| `container/skills/`                            | Container skills mounted into every agent session (`onecli-gateway`, `welcome`, `self-customize`, `agent-browser`, `slack-formatting`)                                                                                                                                                                                      |
| `groups/<folder>/`                             | Per-agent-group filesystem (CLAUDE.md, skills, per-group `agent-runner-src/` overlay)                                                                                                                                                                                                                                       |
| `scripts/init-first-agent.ts`                  | Bootstrap the first DM-wired agent (used by `/init-first-agent` skill)                                                                                                                                                                                                                                                      |
| `migrate-v2.sh` + `setup/migrate-v2/`          | v1→v2 migration. Standalone script: `bash migrate-v2.sh`. Seeds DB, copies groups/sessions, installs channels, builds container, offers service switchover, then hands off to `/migrate-from-v1` skill for owner setup and CLAUDE.md cleanup. See [docs/migration-dev.md](docs/migration-dev.md).                           |
| `nanoclaw.sh --uninstall` + `setup/uninstall/` | Uninstall this copy only (slug-scoped): service, containers + image, `data/`, `logs/`, `groups/`, this copy's OneCLI agents. Confirms per group; `--dry-run` previews, `--yes` skips prompts. Other copies and the shared OneCLI app are untouched. Bypasses bootstrap entirely; `uninstall.sh` is a pointer that execs it. |

## Admin CLI (`ncl`)

`ncl` queries and modifies the central DB — agent groups, messaging groups, wirings, users, roles, and more. On the host it connects via Unix socket (`src/cli/socket-server.ts`); inside containers it uses the session DB transport (`container/agent-runner/src/cli/ncl.ts`).

```
ncl <resource> <verb> [<id>] [--flags]
ncl <resource> help
ncl help
```

| Resource         | Verbs                                                                                                                                                                   | What it is                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| groups           | list, get, create, update, delete, restart, config get/update, config add-mcp-server/remove-mcp-server, config add-package/remove-package, config set-param/unset-param | Agent groups (workspace, personality, container config)            |
| messaging-groups | list, get, create, update, delete                                                                                                                                       | A single chat/channel on one platform                              |
| wirings          | list, get, create, update, delete                                                                                                                                       | Links a messaging group to an agent group (session mode, triggers) |
| users            | list, get, create, update                                                                                                                                               | Platform identities (`<channel>:<handle>`)                         |
| roles            | list, grant, revoke                                                                                                                                                     | Owner / admin privileges (global or scoped to an agent group)      |
| members          | list, add, remove                                                                                                                                                       | Unprivileged access gate for an agent group                        |
| destinations     | list, add, remove                                                                                                                                                       | Where an agent group can send messages                             |
| sessions         | list, get                                                                                                                                                               | Active sessions (read-only)                                        |
| user-dms         | list                                                                                                                                                                    | Cold-DM cache (read-only)                                          |
| dropped-messages | list                                                                                                                                                                    | Messages from unregistered senders (read-only)                     |
| approvals        | list, get                                                                                                                                                               | Pending approval requests (read-only)                              |

Key files: `src/cli/dispatch.ts` (dispatcher + approval handler), `src/cli/crud.ts` (generic CRUD registration), `src/cli/resources/` (per-resource definitions).

## Channels and Providers (skill-installed)

Trunk does not ship any specific channel adapter or non-default agent provider. The codebase is the registry/infra; the actual adapters and providers live on long-lived sibling branches and get copied in by skills:

- **`channels` branch** — Discord, Slack, Telegram, WhatsApp, Teams, Linear, GitHub, iMessage, Webex, Resend, Matrix, Google Chat, WhatsApp Cloud (+ helpers, tests, channel-specific setup steps). Installed via `/add-<channel>` skills.
- **`providers` branch** — OpenCode (and any future non-default agent providers). Installed via `/add-opencode`.

Each `/add-<name>` skill is idempotent: `git fetch origin <branch>` → copy module(s) into the standard paths → append a self-registration import to the relevant barrel → `pnpm install <pkg>@<pinned-version>` → build.

## Self-Modification

One tier of agent self-modification today:

1. **`install_packages` / `add_mcp_server`** — changes to the per-agent-group container config in the DB (apt/npm deps, wire an existing MCP server). Single admin approval per request; on approve, the handler in `src/modules/self-mod/apply.ts` rebuilds the image when needed (`install_packages` only), writes an `on_wake` message, kills the container, and respawns via `onExit` callback. The on-wake message is only picked up by the fresh container's first poll — dying containers can never steal it. `container/agent-runner/src/mcp-tools/self-mod.ts`.

A second tier (direct source-level self-edits via a draft/activate flow) is planned but not yet implemented.

## Container Config

Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, `model_params`, etc.) lives in the `container_configs` table in the central DB. Materialized to `groups/<folder>/container.json` at spawn time so the container runner can read it. Managed via `ncl groups config get/update`, `set-param`/`unset-param` (for `model_params`), and the self-mod MCP tools.

**`model_params`** — JSON bag of per-group model behavior knobs (`max_tokens`, `temperature`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `seed`, `stop` on OpenCode; `max_tokens`, `thinking_budget_tokens` on Claude). The provider warns once on container start about any key it doesn't recognize. Set via `ncl groups config set-param --key <k> --value <v>` (value parsed as JSON first, then string fallback); clear via `ncl groups config unset-param --key <k>`. Both require admin approval; on approve the container restarts. UI patch endpoint: `PATCH /api/groups/<id>/config/model-params` (full-replacement). Wire surfaces: `src/container-config.ts` (`parseModelParams`), `src/cli/resources/groups.ts` (`set-param`/`unset-param`), `src/ui/server/chat/group-admin.ts` (`handlePatchModelParams`), `container/agent-runner/src/providers/opencode.ts` (`pickModelOptionsForOpenCode`), `container/agent-runner/src/providers/claude.ts` (`paramsToClaudeEnv`, `paramsToClaudeThinking`).

**`cli_scope`** — controls what the agent can do with `ncl` from inside the container:

| Value             | Behavior                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `disabled`        | Agent never learns about ncl (instructions excluded from CLAUDE.md). Host dispatch rejects any `cli_request`.                                                                                          |
| `group` (default) | Agent can access `groups`, `sessions`, `destinations`, `members` only, scoped to its own agent group. `--id` and group args are auto-filled. Cross-group access rejected. `cli_scope` changes blocked. |
| `global`          | Unrestricted. Set automatically for owner agent groups via `init-first-agent`.                                                                                                                         |

Key files: `src/db/container-configs.ts`, `src/container-config.ts`, `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts` (instructions exclusion).

## Container Restart

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`. Kills running containers; if `--message` is provided, writes an `on_wake` message and respawns via `onExit` callback. Without `--message`, containers come back on the next user message. From inside a container, `--id` is auto-filled and only the calling session is restarted.

The `on_wake` column on `messages_in` ensures wake messages are only picked up by a fresh container's first poll iteration. This prevents the race where a dying container (still in its SIGTERM grace period) could steal the message. `killContainer` accepts an optional `onExit` callback that fires after the process exits, guaranteeing the old container is gone before the new one spawns.

Key files: `src/container-restart.ts`, `src/container-runner.ts` (`killContainer`), `container/agent-runner/src/db/messages-in.ts` (`getPendingMessages`).

## Secrets / Credentials / OneCLI

API keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway. Secrets are injected into per-agent containers at request time — none are passed in env vars or through chat context. The container agent sees this via the `onecli-gateway` container skill (`container/skills/onecli-gateway/SKILL.md`), which teaches it how the proxy works, how to handle auth errors, and to never ask for raw credentials. Host-side wiring: `src/modules/approvals/onecli-approvals.ts`, `ensureAgent()` in `container-runner.ts`. Run `onecli --help`.

### Agent credential grants

New OneCLI agents start with no credential grants. NanoClaw can attach an
operator allow-list at creation time: set `ONECLI_NEW_AGENT_SECRET_IDS` in
`.env` to comma-separated IDs from `onecli secrets list`. This affects only
agents created afterward and never reconciles or removes existing grants.

For an existing agent, use the OneCLI web UI or the current grants CLI:

```bash
onecli agents grants list --id <agent-id>
onecli agents grants attach-secret --id <agent-id> --secret-id <secret-id>
onecli agents grants detach-secret --id <agent-id> --secret-id <secret-id>
```

Grant changes take effect immediately; no container restart is needed. The
retired `set-secret-mode` and `set-secrets` commands return `410 Gone` on
current gateways.

### Requiring approval for credential use

Approval-gating credentialed actions is a **two-sided** flow:

- **Server-side** (OneCLI gateway): decides _when_ to hold a request and emit a pending approval. As of `onecli@1.3.0`, the CLI does **not** expose this — `rules create --action` only accepts `block` or `rate_limit`, and `secrets create` has no approval flag. Approval policies must be configured via the OneCLI web UI at `http://127.0.0.1:10254`. If/when the CLI grows an `approve` action, this section needs updating.
- **Host-side** (nanoclaw): receives pending approvals and routes them to a human. `src/modules/approvals/onecli-approvals.ts` registers a callback via `onecli.configureManualApproval(cb)` (long-polls `GET /api/approvals/pending`). The callback uses `pickApprover` + `pickApprovalDelivery` from `src/modules/approvals/primitive.ts` to DM an approver. Approvers are resolved from the `user_roles` table — preference order: scoped admins for the agent group → global admins → owners. There is no env var like `NANOCLAW_ADMIN_USER_IDS`; roles are persisted in the central DB only.

If approvals are configured server-side but the host callback isn't running (or throws), every credentialed call hangs until the gateway times out. Conversely, if the gateway has no rule asking for approval, the host callback never fires regardless of how it's wired.

## Skills

Four types of skills. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy.

- **Channel/provider install skills** — copy the relevant module(s) in from the `channels` or `providers` branch, wire imports, install pinned deps (e.g. `/add-discord`, `/add-slack`, `/add-whatsapp`, `/add-opencode`).
- **Utility skills** — ship code files alongside `SKILL.md` (e.g. a `scripts/` CLI or helper).
- **Operational skills** — instruction-only workflows (`/setup`, `/debug`, `/customize`, `/init-first-agent`, `/manage-channels`, `/init-onecli`, `/update-nanoclaw`).
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`: `onecli-gateway`, `welcome`, `self-customize`, `agent-browser`, `slack-formatting`).

### Container skills: roots, spec, catalogs

Container skills come from two roots, both mounted read-only:

| Root      | Host                     | Container               | Managed by                  |
| --------- | ------------------------ | ----------------------- | --------------------------- |
| built-in  | `container/skills/`      | `/app/skills`           | the repo                    |
| installed | `data/skills/installed/` | `/app/skills-installed` | skill catalogs (gitignored) |

`src/skills/registry.ts` is the only place that enumerates them — the admin UI, the spawn-time symlink sync, and the CLAUDE.md composer all call `listSkills()`. Directory checks follow symlinks (`statSync`, not `Dirent.isDirectory()`), so a skill folder symlinked in from another checkout is visible everywhere.

SKILL.md frontmatter follows the [Agent Skills spec](https://agentskills.io/specification): only `name`, `description`, `license`, `allowed-tools`, `metadata`, `compatibility` are spec keys. Env gating lives at `metadata.requires_env`; the pre-spec top-level `requires_env` still works but warns.

A **catalog** is a git repo, either a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) or any repo of `SKILL.md` folders. Catalogs are cloned shallow to `data/skills/cache/<id>` and only read; installing is a validated file copy that records repo/ref/commit/path plus a tree digest in `data/skills/installed.json` (so "update available" is real, and every version is re-reviewable). Installs refuse symlinks in the source tree and refuse to shadow a built-in slug. Owner / global admin only, via `GET|POST /api/skills`, `POST /api/skills/catalogs[/:id/refresh]`, `DELETE /api/skills/catalogs/:id`, `DELETE /api/skills/:slug`.

| Skill               | When to Use                                                                           |
| ------------------- | ------------------------------------------------------------------------------------- |
| `/setup`            | First-time install, auth, service config                                              |
| `/init-first-agent` | Bootstrap the first DM-wired agent (channel pick → identity → wire → welcome DM)      |
| `/manage-channels`  | Wire channels to agent groups with isolation level decisions                          |
| `/customize`        | Adding channels, integrations, behavior changes                                       |
| `/debug`            | Container issues, logs, troubleshooting                                               |
| `/update-nanoclaw`  | Bring upstream updates into a customized install                                      |
| `/init-onecli`      | Install OneCLI Agent Vault and migrate `.env` credentials                             |
| `/migrate-memory`   | Carry a group's agent memory across a provider switch (operator-run, both directions) |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, `SKILL.md` format rules, and the pre-submission checklist.

## PR Hygiene

Before creating a PR, run these checks:

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

Show the output and wait for approval. Installation-specific files (group files, .claude/settings.json, local configs) should not be included.

## Development

Run commands directly — don't tell the user to run them.

```bash
# Host (Node + pnpm)
pnpm run dev          # Host with hot reload
pnpm run build        # Compile host TypeScript (src/)
./container/build.sh  # Rebuild agent container image (nanoclaw-agent:latest)
pnpm test             # Host tests (vitest)

# Agent-runner (Bun — separate package tree under container/agent-runner/)
cd container/agent-runner && bun install   # After editing agent-runner deps
cd container/agent-runner && bun test      # Container tests (bun:test)
```

Container typecheck is a separate tsconfig — if you edit `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root (or `bun run typecheck` from `container/agent-runner/`).

Service management:

```bash
# macOS (launchd)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start|stop|restart nanoclaw
```

## Troubleshooting

Check these first when something goes wrong:

| What        | Where                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host logs   | `logs/nanoclaw.error.log` first (delivery failures, crash-loop backoff, warnings), then `logs/nanoclaw.log` for the full routing chain                                              |
| Setup logs  | `logs/setup.log` (overall), `logs/setup-steps/*.log` (per-step: bootstrap, environment, container, onecli, mounts, service, etc.)                                                   |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db` (`messages_in`: did the message reach the container?), `outbound.db` (`messages_out`: did the agent produce a response?) |

Note: container logs are lost after the container exits (`--rm` flag). If the agent silently failed inside the container, there's no persistent log to inspect.

## Supply Chain Security (pnpm)

This project uses pnpm with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them.

**Rules — do not bypass without explicit human approval:**

- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

| Doc                                                          | Purpose                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                 | Full architecture writeup                                                                          |
| [docs/api-details.md](docs/api-details.md)                   | Host API + DB schema details                                                                       |
| [docs/db.md](docs/db.md)                                     | DB architecture overview: three-DB model, cross-mount rules, readers/writers map                   |
| [docs/db-central.md](docs/db-central.md)                     | Central DB (`data/v2.db`) — every table + migration system                                         |
| [docs/db-session.md](docs/db-session.md)                     | Per-session `inbound.db` + `outbound.db` schemas + seq parity                                      |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) | Agent-runner internals + MCP tool interface                                                        |
| [docs/isolation-model.md](docs/isolation-model.md)           | Three-level channel isolation model                                                                |
| [docs/setup-wiring.md](docs/setup-wiring.md)                 | What's wired, what's open in the setup flow                                                        |
| [docs/architecture-diagram.md](docs/architecture-diagram.md) | Diagram version of the architecture                                                                |
| [docs/build-and-runtime.md](docs/build-and-runtime.md)       | Runtime split (Node host + Bun container), lockfiles, image build surface, CI, key invariants      |
| [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md)         | v1→v2 architecture diff — vocabulary for where v1 things moved                                     |
| [docs/migration-dev.md](docs/migration-dev.md)               | Migration development guide — testing, debugging, dev loop                                         |
| [docs/pages.md](docs/pages.md)                               | Per-group public static websites (Pages) + Traefik / reverse-proxy config                          |
| [docs/agent-email.md](docs/agent-email.md)                   | Per-group Resend addresses, inbound reply routing, and settings behavior                           |
| [docs/provider-migration.md](docs/provider-migration.md)     | Switching a live agent group between providers (e.g. Claude → Codex) — what carries over, rollback |
| [docs/customizing.md](docs/customizing.md)                   | Short intro to customizing via skills                                                              |
| [docs/skills-model.md](docs/skills-model.md)                 | The skills model in full: recipes, tests, upgrades, migrations                                     |
| [docs/skill-guidelines.md](docs/skill-guidelines.md)         | Authoritative checklist for writing a skill                                                        |

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Container Runtime (Bun)

The agent container runs on **Bun**; the host runs on **Node** (pnpm). They communicate only via session DBs — no shared modules. Details and rationale: [docs/build-and-runtime.md](docs/build-and-runtime.md).

**Gotchas — trigger + action:**

- **Adding or bumping a runtime dep in `container/agent-runner/`** → edit `package.json`, then `cd container/agent-runner && bun install` and commit the updated `bun.lock`. Do not run `pnpm install` there — agent-runner is not a pnpm workspace.
- **Bumping `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, or any agent-runner runtime dep** → no `minimumReleaseAge` policy applies to this tree. Check the release date on npm, pin deliberately, never `bun update` blindly.
- **Writing a new named-param SQL insert/update in the container** → use `$name` in both SQL and JS keys: `.run({ $id: msg.id })`. `bun:sqlite` does not auto-strip the prefix the way `better-sqlite3` does on the host. Positional `?` params work normally.
- **Adding a test in `container/agent-runner/src/`** → import from `bun:test`, not `vitest`. Vitest runs on Node and can't load `bun:sqlite`. `vitest.config.ts` excludes this tree.
- **Adding a Node CLI the agent invokes at runtime** (like `agent-browser`, `claude-code`, `vercel`) → put it in the Dockerfile's pnpm global-install block, pinned to an exact version via a new `ARG`. Don't use `bun install -g` — that bypasses the pnpm supply-chain policy.
- **Changing the Dockerfile entrypoint or the dynamic-spawn command** (`src/container-runner.ts` line ~301) → keep `exec bun ...` so signals forward cleanly. The image has no `/app/dist`; don't reintroduce a tsc build step.
- **Changing session-DB pragmas** (`container/agent-runner/src/db/connection.ts`) → `journal_mode=DELETE` is load-bearing for cross-mount visibility. Read the comment block at the top of the file first.

## CJK font support

Agent containers ship without CJK fonts by default (~200MB saved). If you notice signals the user works with Chinese/Japanese/Korean content — conversing in CJK, CJK timezone (e.g., `Asia/Tokyo`, `Asia/Shanghai`, `Asia/Seoul`, `Asia/Taipei`, `Asia/Hong_Kong`), system locale hint, or mentions of needing to render CJK in screenshots/PDFs/scraped pages — offer to enable it:

```bash
# Ensure .env has INSTALL_CJK_FONTS=true (overwrite or append)
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env

# Rebuild and restart so new sessions pick up the new image
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

`container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through as a Docker build-arg. Without CJK fonts, Chromium-rendered screenshots and PDFs containing CJK text show tofu (empty rectangles) instead of characters.
