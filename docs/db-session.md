# NanoClaw — Per-Session DB Schema

Reference for the three SQLite files in each session: host-owned `inbound.db`
and `outbound.db`, plus runner-owned `runner-state.db`. Start with [db.md](db.md).

Schemas live in `src/db/schema.ts` as the `INBOUND_SCHEMA` and `OUTBOUND_SCHEMA` constants. Both files are created by `ensureSchema()` in `src/session-manager.ts` when a new session folder is provisioned.

---

## 1. Session folder layout

```
data/v2-sessions/<agent_group_id>/<session_id>/
  inbound.db              ← private host input + pending host event journal
  outbound.db             ← private host projection of runner output
  runner-state/           ← mounted runner-owned SQLite directory
    runner-state.db       ← projection + pending runner journal
  inbox/<message_id>/     ← user attachments, mounted read-only
  outbox/<message_id>/    ← attachments the agent produced
```

One session = one folder = one pair of DBs. The `agent_group_id` parent directory also holds per-group state (`.claude-shared/`, `agent-runner-src/`) that is shared across every session of that agent group.

DB path helpers in `src/session-manager.ts`: `sessionDir()`, `inboundDbPath()`,
and `outboundDbPath()`. The container mounts neither host database; durable
events and live status share the per-session socket described in
[session-link.md](session-link.md).

---

## 2. Inbound DB (`inbound.db`)

Host-owned and host-private. Schema constant: `INBOUND_SCHEMA` in `src/db/schema.ts`.

### 2.1 `messages_in`

Every message landing in the session: user chat, scheduled task, recurring task, question response, internal system message.

```sql
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,           -- EVEN only (host assigns) — see §3
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',   -- pending|completed|failed|paused
  process_after  TEXT,
  recurrence     TEXT,                     -- cron expr for recurring
  series_id      TEXT,                     -- groups occurrences of a recurring task
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1, -- 0 = context only (don't wake), 1 = wake agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,            -- JSON; shape depends on kind
  source_session_id TEXT,                  -- exact agent-to-agent return path
  sender_user_id TEXT,                     -- canonical users.id attribution
  sender_identity TEXT,                    -- observed namespaced identity
  on_wake        INTEGER NOT NULL DEFAULT 0 -- 1 = only deliver on a fresh container
);
CREATE INDEX idx_messages_in_series ON messages_in(series_id);
```

Content shapes: see [api-details.md §Session DB Schema Details](api-details.md#session-db-schema-details).

`sender_user_id` is canonical attribution when the host can resolve the sender to a current user. `sender_identity` preserves the observed namespaced identity (for example, `telegram:123`) even when no canonical user link exists. Either may be `NULL`; missing provenance remains explicitly unknown and is never reconstructed from `content` by the agent-runner.

For agent-to-agent rows, `source_session_id` is an exact return route. A reply to that agent must use the recorded active session or fail. Unthreaded messages and explicitly targeted sends whose inherited reply reference came from another origin are group-level sends and use the target agent group's normal `agent-shared` session policy.

**Writers (host):** `insertMessage()`, `insertTask()`, `insertRecurrence()` — all in `src/db/session-db.ts`. Each calls `nextEvenSeq()`.
Message mutations are journaled into `pending_host_events`, projected into the
runner's local `messages_in`, and consumed by
`container/agent-runner/src/db/messages-in.ts` after socket notification.

### 2.2 `delivered`

Host writes here after handing a `messages_out` row to the channel adapter. Edit
and reaction operations retain a stable NanoClaw message ID; the host resolves
that ID to `platform_message_id` immediately before adapter delivery.

```sql
CREATE TABLE delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',  -- delivered|failed
  delivered_at        TEXT NOT NULL
);
```

Writer: `markDelivered()` / `markDeliveryFailed()` in `src/db/session-db.ts`.

### 2.3 `destinations`

Host projection of the central `agent_destinations` table (see [db-central.md §1.10](db-central.md#110-agent_destinations)) for this session's agent. Each replacement is journaled as one atomic snapshot and applied to the runner-local table. The container resolves `to="name"` there.

```sql
CREATE TABLE destinations (
  name           TEXT PRIMARY KEY,
  display_name   TEXT,
  type           TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type   TEXT,            -- for type='channel'
  platform_id    TEXT,            -- for type='channel'
  agent_group_id TEXT             -- for type='agent'
);
```

Rewritten wholesale (DELETE + INSERT in a transaction) by `writeDestinations()` on every container wake and on demand when wiring changes mid-session. The comment on the table in `src/db/schema.ts` is the canonical statement of the refresh semantics.

### 2.4 `session_routing`

Single-row (`id=1`) default routing: where outbound messages go when the agent doesn't specify a destination.

```sql
CREATE TABLE session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
```

Written by `writeSessionRouting()` on every container wake, journaled, and
projected into runner state before `host.ready`.

### 2.5 `pending_host_events`

Ordered host-to-runner journal. Message/sequence/fork triggers and explicit
routing/destination helpers append rows. The host sends one row at a time and
deletes it only after `host.ack`; reconnect replays the retained head.

---

## 3. Sequence numbering invariant

Every message (in or out) gets a monotonic integer `seq`, unique _within the session_ across both tables.

- **Host writes even seq** (2, 4, 6, …) to `messages_in` — `nextEvenSeq()` at `src/db/session-db.ts:75`.
- **Runner assigns odd seq** (1, 3, 5, …) in its projection. The host validates
  and applies that exact odd seq to `outbound.db`.

Why disjoint? `seq` is the agent-facing message ID. When the agent calls `edit_message(seq=5)` or `add_reaction(seq=6)`, `getMessageIdBySeq()` uses the parity to route the lookup: odd → `messages_out`, even → `messages_in`. The parity alone disambiguates without a join. Collisions would break editing.

If you add a code path that writes to either table, preserve parity — the invariant isn't enforced by a constraint, only by the two helper functions.

---

## 4. Outbound DB (`outbound.db`)

Host-owned durable projection. It is not mounted into the container. Schema
constant: `OUTBOUND_SCHEMA` in `src/db/schema.ts`.

### 4.1 `messages_out`

Everything the agent produces: chat replies, edits, reactions, cards, question sends, agent-to-agent messages, system actions.

```sql
CREATE TABLE messages_out (
  id            TEXT PRIMARY KEY,
  seq           INTEGER UNIQUE,   -- ODD only (container assigns) — see §3
  in_reply_to   TEXT,
  timestamp     TEXT NOT NULL,
  deliver_after TEXT,
  recurrence    TEXT,
  kind          TEXT NOT NULL,    -- chat|chat-sdk|system|…
  platform_id   TEXT,
  channel_type  TEXT,
  thread_id     TEXT,
  content       TEXT NOT NULL,    -- JSON; operation lives inside (edit/reaction/card/…)
  turn_id       TEXT REFERENCES turns(id) -- nullable; conversation-sync storage foundation
);
```

Content shapes: see [api-details.md §Session DB Schema Details](api-details.md#session-db-schema-details).

**Writer (host):** `src/session-link-durable.ts`, after validating a journaled runner event.
**Readers:** host delivery, UI, and forking. Runner sequence/reference lookups
use its local projection.

### 4.2 `processing_ack`

Projected status for each `messages_in.id` the runner has touched. A
`batch.persisted` event wakes host reconciliation.

```sql
CREATE TABLE processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,      -- processing|completed|failed
  status_changed TEXT NOT NULL
);
```

Crash recovery: runner startup clears stale local `processing` entries and
journals their deletion. Host-side sync remains in `src/host-sweep.ts`.

### 4.3 `session_state`

Host projection of runner persistent KV state. The runner reads and mutates its
local copy; acknowledged events keep this host copy current for forks and recovery.

```sql
CREATE TABLE session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Access: `container/agent-runner/src/db/session-state.ts`.

### 4.4 Durable logical turns

The host projection and runner state have matching, runtime-local definitions
in `src/db/turns.ts` and `container/agent-runner/src/db/turns.ts` (a host test
asserts the schema text is identical). There are no cross-runtime imports. Both
DB openers create this schema for every store; there is no migration path.

`turns` has these columns:

| Columns | Contract |
| --- | --- |
| `id` | Nonempty stable text primary key, scoped to the session |
| `origin_channel_type`, `origin_platform_id`, `origin_thread_id`, `origin_source_session_id` | Nullable original input route, not an outbound destination |
| `started_at`, `ended_at` | Nullable timestamps; historical turns have none |
| `phase` | `running`, `stopping`, `settling`, `settled` |
| `outcome` | `pending`, `replied`, `warning`, `silent`, `stopped`, `failed`, `unknown`, `interrupted` |
| `provenance` | `native`, `fork`, or `backfill` (historical turns imported at the v4 cutover; never written now) |
| `imported_from_session_id`, `imported_from_turn_id` | Nullable fork source identifiers (provenance, not local foreign keys) |

Associations are explicit:

- `turn_inputs(turn_id, message_in_id, association)` has composite primary key
  `(turn_id, message_in_id)`. `association` is `consumed` (future live writes),
  `applied` (confirmed steering receipt), or `reply` (an explicit reply anchor).
  An input may participate in multiple turns, including retries. `turn_id`
  references `turns`; the input ID cannot have a host-side foreign key because
  the input journal is a separate file. The writer must validate input existence.
- `messages_out.turn_id`, `turn_usage.turn_id`, and `turn_activity.turn_id` are
  nullable references to `turns`. Existing output IDs and usage accounting IDs
  are unchanged. Multiple outputs, usage records, and activity records can
  belong to one turn; a turn need not produce any output.
- `turn_activity` preserves the legacy `(message_out_id, ordinal)` key.
  `message_out_id` can now be null **only if** `turn_id` is present; a partial
  unique index on `(turn_id, ordinal) WHERE message_out_id IS NULL` identifies
  unanchored activity. Legacy ordinals are not renumbered, even when multiple
  output anchors share a turn. Timestamps never determine association/order.
  Required positive `timeline_position` records first emission on the runner's existing
  logical clock, shared with input consumption and output writes. Lifecycle
  reduction retains a step's first position; final output reanchoring never
  changes it. The offline activity-order migration assigns historical positions
  from saved output associations and ordinal order, never activity timestamps.
  Runtime code rejects missing positions instead of accepting old payloads.
- Historical usage/activity rows that point at an existing output but no turn
  remain stored and unattributed; nothing is attributed by time proximity.
  Rows reachable from neither a turn nor an output are not kept.

Historical (`backfill`) turns are settled with null start/end times. Their
outcome is `stopped`/`replied` only when an output said so, otherwise
`unknown`, and their origin route is null unless evidence existed. Some of their
activity rows are plain text rather than JSON steps; readers accept both.

Storage APIs (both runtimes): `getTurn`, `putTurn`, `getTurnInputs`,
`linkTurnInput`, `getTurnAssociations`, and `linkTurnRecord`. `TurnRow`,
`TurnInputRow`, `TurnAssociations`, and `TurnAssociationTarget` define their
contracts. `linkTurnRecord(db, turnId, target)` accepts an output/usage ID or
an existing activity `(message_out_id, ordinal)` and rejects missing turns,
missing records, and reassignment to a different turn.

Forks retain IDs only for turns associated with included inputs/outputs/sidecars.
The origin is rewritten to the fork's route and provenance records the parent.
An active or partially included source turn becomes a **settled, unknown
historical snapshot**, with unknown lifecycle timestamps, never an active turn
in the child. Only included inputs and output-anchored sidecars are copied.
Turn-only activity/usage requires a fully included, settled source turn; unlinked
accounting is not copied. Missing referenced turns are cleared from copied
relational links. The source is read-only, and the fresh runner seed inherits the
same metadata as the fork's host projection.

---

## 5. Runner State (`runner-state/runner-state.db`)

Native execution now writes `turns` and `turn_inputs` before producing output.
The final `turn.upsert` journal event (`phase=settled`) is the ordered settlement
barrier; no response message is required to persist the turn. `turn_activity`
is initially turn-owned with a null output anchor and can be re-anchored at
settlement. The turn-local ordinal and emit time do not change.

Additional metadata uses the existing `session_state` table, not new columns:
`turn-metadata:<id>` contains `{turnId,durationMs,model,usageId,status,final}`.
`status` is `provisional|partial|final|unavailable`; a settled record may remain
`partial`, and no usage report means `usageId=null` rather than fabricated
tokens. Native billing uses one stable `turn_usage.id = 'tu-' + turn_id` across
corrective/stale-session attempts. Historical usage IDs and totals are unchanged.
See [session-link.md](session-link.md#lifecycle-and-metadata) for lifecycle and
post-commit hooks.

The DB-backed `runner:turn-context`, `runner:tools:<id>` and `runner:sends:<id>`
state keys coordinate runner/MCP sidecars, captured reply ownership, outstanding
tool calls and duplicate-send detection. They are internal runner metadata,
not evidence that a turn completed.

Runner-owned and the only database mounted into the container. Its parent
directory is mounted so SQLite rollback journals survive container crashes. It contains the
runner's writable output/state tables, `pending_runner_events`, and local copies
of host-owned `messages_in`, `destinations`, `session_routing`, and `fork_origin`.

`applied_host_events.last_sequence` advances in the same transaction that
applies each `host.event`. Replayed sequences at or below that cursor are ACKed
without reapplying; gaps fail closed. `host_state.sequence_floor` tracks even
host-only output rows so odd runner sequence allocation remains collision-free
without reading `outbound.db`.

The host never opens this file. The runner never opens either host DB.

---

## 6. Schema evolution

Unlike the central DB, session DBs do **not** automatically run upgrade migrations. Both `INBOUND_SCHEMA` and `OUTBOUND_SCHEMA` create the complete current shape for fresh sessions. Existing session files are normalized as an explicit data operation before runtime code starts requiring a newly added table or column.

Before deploying a new required table or column, stop both peers, back up the session directory, and normalize every existing session DB explicitly. Verify every file against the new schema and run integrity/foreign-key checks before starting matching peers. Prefer nullable columns or defaulted values when the historical value cannot be reconstructed. There is no mixed-version compatibility.

### Downgrading

Session stores cannot be converted back to link v3. Rollback is a full
snapshot restore together with the v3 code; see
[downgrade-to-v3.md](downgrade-to-v3.md).
