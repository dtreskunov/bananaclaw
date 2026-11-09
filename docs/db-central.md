# NanoClaw — Central DB Schema

Complete reference for `data/v2.db`, the host-owned admin-plane database. Start with [db.md](db.md) for the three-DB overview, the map, and the cross-mount rules.

Access layer: `src/db/`. Authoritative fresh-store schema:
`src/db/central-schema.ts`. `src/db/migrations/index.ts` initializes it directly
and applies future named migrations.
Maintained time instants below are INTEGER UTC epoch milliseconds, retained as
numbers by the DB access layer, host domain records and UI protocol 17.
Nullable instants remain `null`; epoch zero is a valid recorded instant.
Exported mutation APIs validate supplied instants as safe integer milliseconds
within the JavaScript Date range before binding SQLite, so invalid numbers
cannot be silently coerced to `NULL`.
The admin CLI formats public record dates as ISO strings at its response boundary
and parses user-supplied date arguments once. Archive rows contain numeric dates;
restore accepts only the current numeric archive format.
`archived_at` remains ISO archive metadata. No additional central schema migration
is required for numeric host records. `PRAGMA user_version=2` is required after the
[reply-suggestions cutover](reply-suggestions-cutover.md); existing
stores retain their data and historical migration ledger. Populated version-0
stores and future storage versions are refused; older stores need the
[offline cutover](db-storage-cutover.md), never startup conversion.

### Baseline integrity

The baseline validates configuration JSON shapes, CLI scope, routing enums,
boolean flags, and nonnegative safe-integer counters/watermarks on both insert
and update. No values are silently replaced. Routing columns have their documented
defaults when omitted, while explicit null or incomplete pattern rules fail.

Domain validation uses database triggers so it also protects installed module
writers and ad-hoc SQL.
Gateway reconciliation tombstones and cross-database references remain
deliberately unconstrained by user/session foreign keys.

Single-column text primary keys are explicitly non-null. Role values/global
owner scope and null-aware uniqueness for global roles, primary identities and
active routed sessions are enforced. Nullable global scope remains supported.
Primary-identity replacement is transactional.

Fresh initialization creates the full current schema atomically, with no
historical migrations, TEXT timestamp tables, table rebuilds or timestamp
conversion. It generates a new installation UUID and creates the summary and
unread readiness singleton with both flags set to 1. Reopening converted storage
does not recreate objects, reset readiness, replace the installation identity,
deduplicate roles, choose sessions or rewrite migration history.

Native provider connections also explicitly enforce foreign keys and refuse
existing orphaned messages. Repair native state only while its runner is
stopped; do not remove orphaned messages without deciding how to recover them.

---

## 1. Tables

### Maintained thread summary projection

`thread_summaries` is keyed by source
session, inbound/outbound side, summary kind and exact channel/platform/thread
route. JSON values contain route aggregates (counts, timestamps, fallback/title
metadata, first-owner hints and pending tasks), session usage or latest durable
turn headers. They never cache viewer authorization.

Process-local projection failures block affected readers, including when the
central DB is unable to write an error record. Dirty source markers survive
restart and are drained before readers are admitted. `thread_summary_meta.ready` gates
startup until existing sources have been explicitly backfilled. Central session
deletion cascades to summary rows.

The host-owned source DBs hold transactional dirty markers; the projector commits
central values before acknowledging those markers. See
[upgrade and recovery](ui.md#thread-summary-upgrade). These are rebuildable
derived summaries, not a durable UI event log.

### Durable conversation reads

The baseline includes:

- `conversation_publications`: a current-content index keyed by session, item
  kind/ID and exact route. Its non-reused integer position is internal; clients
  receive only a random opaque key. Inactive tombstones preserve identity across
  deletion/replay. Messages, question cards and approval cards share this order.
  Payloads stay in their canonical host journals/current-state interaction rows.
- `conversation_reads`: monotonic per-user, per-session, channel/platform/thread
  read watermarks. User/session deletion cascades to these rows.
- `users.unread_baseline`: private rollout/account-creation baseline, omitted
  from public user records.
- `thread_summary_meta.unread_ready`: an explicit bootstrap gate. The first
  offline rebuild baselines existing content; later repairs preserve read state.

Ordinary output publication follows dirty-source projection, with final
responses gated on turn settlement. Interaction publication is part of the
interaction mutation transaction; its validated origin route is retained in
the existing routing columns rather than reconstructed on every UI read.
Authorization is still evaluated for the current viewer on every metadata,
conversation and acknowledgement operation. Read changes notify only that
user's sync subscribers. See [the upgrade procedure](ui.md#durable-unread-upgrade).

### 1.1 `agent_groups`

Agent workspaces. Each maps 1:1 to a `groups/<folder>/` directory containing `CLAUDE.md` and skills. Container config lives in `container_configs` (see §1.x below); a `container.json` file is materialized at spawn time for the container runner to read.

```sql
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY NOT NULL,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       INTEGER NOT NULL
);
```

- **Readers:** `src/session-manager.ts`, `src/delivery.ts`, `src/router.ts`
- **Writers:** `src/db/agent-groups.ts`

### 1.2 `messaging_groups`

One row per platform chat (one WhatsApp group, one Slack channel, one 1:1 DM, etc.) per adapter instance.

```sql
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY NOT NULL,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  instance              TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  created_at            INTEGER NOT NULL,
  denied_at             INTEGER,
  UNIQUE(channel_type, platform_id, instance)
);
```

- `instance`: adapter-instance name — N adapters of one platform (e.g. three Slack apps in one workspace) each own their rows. The default instance IS the channel type: `createMessagingGroup` stamps `instance = channel_type` when omitted, so single-instance installs never see the dimension. Raw SQL writers must supply it explicitly. Inbound lookups are exact-on-instance (an unknown named instance auto-creates its own row); outbound lookups resolve default-instance-first.
- `unknown_sender_policy`: `strict` (drop), `request_approval` (ask admin), `public` (allow).
- **Readers:** `src/router.ts`, `src/delivery.ts`, `src/session-manager.ts`
- **Writers:** `src/db/messaging-groups.ts`, channel setup flows

### 1.3 `messaging_group_agents`

Wiring: which agent group handles which messaging group. Many-to-many — the same channel can route to multiple agents (see [isolation-model.md](isolation-model.md)).

```sql
CREATE TABLE messaging_group_agents (
  id                 TEXT PRIMARY KEY NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  session_mode       TEXT DEFAULT 'shared',
  priority           INTEGER DEFAULT 0,
  created_at         INTEGER NOT NULL,
  engage_mode        TEXT NOT NULL DEFAULT 'mention',
  engage_pattern     TEXT,
  sender_scope       TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
  UNIQUE(messaging_group_id, agent_group_id)
);
```

- `session_mode`: `shared` (one session per channel), `per-thread` (one per thread), `agent-shared` (one per agent group across all channels).
- `engage_mode`: `pattern`, `mention` or `mention-sticky`. Pattern mode requires a nonblank `engage_pattern`.
- `sender_scope`: `all` or `known`; `ignored_message_policy`: `drop` or `accumulate`.
- **Side effect:** creating a wiring must also populate `agent_destinations` — don't mutate one without the other (see §1.10).

### 1.4 `users`

A person. `id` is an opaque UUID v4 generated server-side; never construct it
from a channel handle. Channel handles live in the separate `identities`
table (§1.4a) and may be many-to-one against a single user.

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY NOT NULL,   -- UUID v4
  kind         TEXT NOT NULL,      -- primary channel type (informational)
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  onboarded_at INTEGER,
  unread_baseline INTEGER NOT NULL DEFAULT 0
);
```

- **Writers/readers:** `src/db/users.ts`; channel auth flows

### 1.4a `identities`

The (channel, handle) → user mapping. Adding a row links a platform handle
to a user; multiple rows let the same human be reached over many channels.
`getOrCreateUserByIdentity()` in `src/modules/permissions/db/identities.ts`
is the canonical write path.

```sql
CREATE TABLE identities (
  channel              TEXT NOT NULL,
  handle               TEXT NOT NULL,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at          INTEGER NOT NULL,
  primary_for_channel  INTEGER NOT NULL DEFAULT 0 CHECK(primary_for_channel IN (0,1)),
  metadata_json        TEXT,
  PRIMARY KEY (channel, handle)
);
CREATE INDEX idx_identities_user ON identities(user_id);
CREATE UNIQUE INDEX identities_primary_unique ON identities(user_id,channel)
  WHERE primary_for_channel=1;
```

- **Lookup keys:** `(channel, handle)` is unique (one user per handle on a
  given channel); `getIdentitiesForUser(userId)` returns all handles for a
  user.
- **Teams gotcha:** Teams handles include their own `29:` prefix; that goes
  in `handle` as-is, channel is `'teams'`. No string-splitting.

### 1.5 `user_roles`

Permissions. **Privilege is user-level, never agent-group-level.**

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id),
  CHECK(role IN ('owner','admin')),
  CHECK(role != 'owner' OR agent_group_id IS NULL)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
CREATE UNIQUE INDEX user_roles_global_unique ON user_roles(user_id,role)
  WHERE agent_group_id IS NULL;
```

Invariants:

- `role = 'owner'` → must be global (`agent_group_id IS NULL`). Enforced in SQL and `grantRole()`.
- `role = 'admin'` → global (NULL) or scoped to one agent group.
- Admin @ A implies membership in A — no `agent_group_members` row required.

Access layer: `src/db/user-roles.ts`, `src/access.ts`.

### 1.6 `agent_group_members`

Explicit membership for non-privileged users. Owner and admins don't need rows here — they're implicit members.

```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

### 1.7 `user_dms`

Cache of DM channel discovery. Lets the host send a cold DM (approval card, pairing code) without hitting the platform's `openConversation` API every time.

```sql
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

Populated lazily by `ensureUserDm()` in `src/user-dm.ts`. Cold DMs resolve via the channel's default adapter instance — `PRIMARY KEY (user_id, channel_type)` is per-platform, not per-instance.

### 1.8 `sessions`

Session registry. One row per (agent group, messaging group, thread) tuple subject to `session_mode`. Stores lifecycle metadata only — no messages.

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY NOT NULL,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        INTEGER,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup     ON sessions(messaging_group_id, thread_id);
```

- **Resolved by:** `resolveSession()` in `src/session-manager.ts`.
- Creating a session also provisions the session folder and both session DBs via `initSessionFolder()` — see [db-session.md](db-session.md).
- Session-bound approval requests require explicit cancellation consent: the chat
  delete dialogs explain this, and `DELETE /api/groups/:id/chat/:threadId` requires
  `cancelApprovals=1` when such requests exist (otherwise `409
approval_cancellation_required`, with no deletion side effects). Cascading
  deletes apply consent to all removed branches; cleanup of central rows is atomic.
  Confirmed requests are cancelled by removing their outstanding approval rows, so
  later card clicks cannot execute them. The response reports `cancelledApprovals`,
  and cancellations are logged and shown in a toast. Unrelated requests, including
  sessionless Agent Vault approvals, remain untouched; already applied actions are not undone.
  Approvals being processed hold a process-local session guard through their
  handler, resolution callbacks, and container wake. Deletion returns `409
approval_in_progress` until processing finishes, even with cancellation consent.
  The guard releases on success or failure and adds no persistent status or schema.

### 1.9 `interactions` — explicit approval workflows

The current-state table admits three kinds: `confirmation`, `account_setup`
and `access_grant`. `src/db/interactions.ts` owns canonical serialization;
`src/db/approvals.ts` specializes creation and revision-checked status changes.
Request IDs, input/response JSON, actor/timing fields, outcomes and route
provenance retain authorization and audit context. IDs are globally unique.

Conversational reply drafts are not interactions and create no pending-answer
or waiting state. Suggested replies live only in final message Markdown;
there is no separate state or protocol field. Sending a suggestion is ordinary
chat input. Historical questions were converted by the
[archived offline cutover](reply-suggestions-cutover.md).

### 1.10 `agent_destinations`

Permission ACL _and_ name-resolution map for outbound sending. An agent asking to `send_message(to="dev-channel")` must have a row here with `local_name = 'dev-channel'`, or the send is rejected as `unknown destination`.

```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id      TEXT NOT NULL,   -- messaging_group_id | agent_group_id
  created_at     INTEGER NOT NULL,
  created_by     TEXT REFERENCES users(id),
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
```

**Projection invariant (load-bearing).** The central table is the source of
truth. `writeDestinations()` writes one atomic snapshot event to the session's
host journal, and the session link applies it to `runner-state.db` (see
[db-session.md §2.3](db-session.md#23-destinations)). Every mutation call site
must still invoke `writeDestinations()` so a running agent sees the update.

Access layer: `src/db/agent-destinations.ts`.

### 1.11 `interactions` — confirmations/accounts and private progress

`src/db/central-schema.ts` defines the canonical schema; `src/db/approvals.ts` owns mutations.
One retained row contains request identity, kind, session/group and immutable
origin, input/presentation, current status/revision, decision, responder,
optional note, outcome and timestamps. There is no separate history snapshot.

Kinds are `confirmation`, `account_setup` and `access_grant`. All support
`pending`, `applying`, `rejected`, `failed`, `cancelled` and `expired`;
confirmations finish as `approved`, while accounts finish as `completed`.
An active dedupe key is unique across pending/applying rows. Revision checks
claim account operations atomically. Generic applying effects never replay
automatically after a crash; uncertain effects require operator review.

`interaction_progress` is a private sidecar keyed by the interaction ID: selection/recovery JSON, submission
aliases, restart flag and notification acknowledgement. It owns neither
lifecycle nor copied request metadata. Public/CLI projections never select
its private fields.

Authorized conversation interactions and polling use the same approval
projection. Session deletion cascades records. Group archives cancel pending
approvals, refuse applying effects and restore finalized records as audit-only,
without private recovery or retry. See the
[offline cutover](user-requests-refactor-plan.md#offline-cutover-detect--why--fix--verify--rollback).

### 1.12 `unregistered_senders`

Audit trail: every time a message gets dropped (unknown sender, strict policy), we increment a counter here so admins can see who's been trying to knock.

```sql
CREATE TABLE unregistered_senders (
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  user_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
  sender_name        TEXT,
  reason             TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id     TEXT,
  message_count      INTEGER NOT NULL DEFAULT 1,
  first_seen         INTEGER NOT NULL,
  last_seen          INTEGER NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
```

Writer: `recordDroppedMessage()` in `src/db/dropped-messages.ts`. On conflict, bumps `message_count` + `last_seen`.

### 1.13 Chat SDK bridge tables

State backing the `SqliteStateAdapter` used by the Chat SDK bridge (see [api-details.md](api-details.md)). NanoClaw code rarely touches these directly — they're owned by `src/state-sqlite.ts`.

```sql
CREATE TABLE chat_sdk_kv (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER                    -- UTC epoch milliseconds, nullable
);

CREATE TABLE chat_sdk_subscriptions (
  thread_id     TEXT PRIMARY KEY NOT NULL,
  subscribed_at INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s','now') AS INTEGER)*1000
    + CAST(substr(strftime('%f','now'),4,3) AS INTEGER)
  )
);

CREATE TABLE chat_sdk_locks (
  thread_id  TEXT PRIMARY KEY NOT NULL,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE chat_sdk_lists (
  key        TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, idx)
);
```

### 1.14 `schema_version`

Migration ledger, written by the migration runner (§2).

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied INTEGER NOT NULL
);
```

### 1.15 `container_configs`

Per-agent-group container runtime config. Source of truth for provider, model, packages, MCP servers, mounts, CLI scope, etc. Materialized to `groups/<folder>/container.json` at spawn time.

```sql
CREATE TABLE container_configs (
  agent_group_id         TEXT PRIMARY KEY NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  provider               TEXT,
  model                  TEXT,
  effort                 TEXT,
  image_tag              TEXT,
  assistant_name         TEXT,
  max_messages_per_prompt INTEGER,
  skills                 TEXT NOT NULL DEFAULT '"all"',
  mcp_servers            TEXT NOT NULL DEFAULT '{}',
  packages_apt           TEXT NOT NULL DEFAULT '[]',
  packages_npm           TEXT NOT NULL DEFAULT '[]',
  packages_pip           TEXT NOT NULL DEFAULT '[]',
  additional_mounts      TEXT NOT NULL DEFAULT '[]',
  model_params           TEXT NOT NULL DEFAULT '{}',
  small_model            TEXT,
  upstream_provider      TEXT,
  disabled_skills        TEXT NOT NULL DEFAULT '[]',
  voice_input_backend    TEXT,
  voice_input_enabled    INTEGER NOT NULL DEFAULT 1 CHECK(voice_input_enabled IN (0,1)),
  credential_backend     TEXT NOT NULL DEFAULT 'agent-vault' CHECK(credential_backend='agent-vault'),
  cli_scope              TEXT NOT NULL DEFAULT 'group',   -- disabled | group | global
  updated_at             INTEGER NOT NULL
);
```

- **Readers:** `src/container-config.ts`, `src/container-runner.ts`, `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts`
- **Writers:** `src/db/container-configs.ts`, `src/modules/self-mod/apply.ts`

### 1.16 Credential gateway identity and reconciliation

`credential_gateway_identity` has exactly one initialization row (`id=1`):
its unique `installation_id` is a random UUID generated only for a fresh store.
`credential_gateway_sync` is a durable per-user reconciliation outbox, with
a positive safe-integer `revision`. Triggers on users, roles, membership and
group creation/deletion advance revisions. User deletion retains its outbox
tombstone intentionally; there is no user foreign key on that table.

---

## 2. Baseline and future migrations

Runner: `runMigrations()` in `src/db/migrations/index.ts`.

1. Refuses unsupported storage versions and populated version-0 stores before
   writing. Migration execution cannot be nested inside another transaction.
2. For an empty version-0 store only, creates `CENTRAL_SCHEMA_SQL`, seeds the
   installation identity and readiness row, records the 49 covered historical
   migration names plus `central-baseline-v1`, and
   sets `PRAGMA user_version=2` in one transaction.
3. Reads applied migration **names**. Existing version-2 stores keep all historical
   names and applied-order numbers; they do not need a baseline ledger row.
4. For each unapplied future name in the `migrations` array, executes `up(db)`
   transactionally and appends an applied-order `schema_version` row with an
   INTEGER-millisecond `applied` instant. Repeated names are applied only once.

Covered names are baseline metadata, not executable historical migrations.
Recording them on fresh stores prevents skill-installed modules from replaying
already-included table/column additions when they re-register their old names.
This initialization never adds or rewrites history on existing converted stores.

Future migrations have `{ name, up, disableForeignKeys? }`. Append them in
application order; names, not file numbers, are their durable identity. Update
the canonical schema when adding a schema change, and make its migration
safe for a fresh store that already has that shape. There are currently no
post-baseline migrations.

Foreign-key enforcement is enabled by the runner. A migration needing a table
rebuild can request `disableForeignKeys`; the runner toggles it outside the
transaction and rejects newly introduced violations before commit, restoring
enforcement even on failure. Pre-existing violations are not silently repaired.
Historical migration implementations are retired; their existing ledger rows
remain audit metadata, not startup compatibility behavior.

Session DB schemas (`INBOUND_SCHEMA`, `OUTBOUND_SCHEMA`) use their own
`PRAGMA user_version`, not the central migration ledger. They describe the
complete fresh-store shape. See [db-session.md](db-session.md).
