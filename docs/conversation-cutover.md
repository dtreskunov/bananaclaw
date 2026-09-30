# Conversation synchronization: coordinated offline cutover

This is a **breaking, all-peers upgrade**: host/runner link v4, explicit durable
turns and settlement, and browser conversation protocol v1. There is no old-frame
adapter, runtime backfill, live migration, or mixed-version deployment mode.
Fresh sessions initialize the new schemas normally; this procedure is for
existing session stores.

## Detect

- Old stores lack `messages_out.turn_id`, `turns`, or the `schema:1` marker in
  `conversation_sync_migrations`. An imported store also needs `backfill:1`;
  a migrated runner needs `journal:2`. Fresh stores need not have `backfill:1`.
- A runner requiring `migrateTurnSchema()` or `migrateRunnerTurnJournal()` is
  deliberately refusing an old store, not requesting a restart loop.
- A `.conversation-cutover/manifest.json` with anything other than
  `phase: "verified"` blocks **new host startup before central DB initialization**.
  `backing-up`, `applying`, `verifying`, `failed`, `restoring`, and `rolled-back`
  are not permission to start either new peer.
- Run the preflight below against an independent offline copy, not the deployed
  `DATA_DIR`. It reports only phase and file/session counts, never credentials or
  message contents.

## Why

Messages, activity, usage, and input dispositions now refer to an immutable
logical turn. Its durable `settled` event is the response-visibility barrier.
A lost live signal, runner exit, elapsed time, or successor turn is **not**
evidence of settlement. The browser consumes authorized atomic projections,
with new snapshots after reconnect or a revision gap.

Old journal events cannot express these invariants. Draining them before
upgrading is mandatory. Deleting journal rows, reseeding an existing runner
from the host, or deriving turns from timestamps would lose state.

## Fix

### 1. Arrange the offline boundary (operator-controlled)

1. Retain the old code, host build, runner image, and browser assets. Pause new
   ingress and scheduling by your installation's normal maintenance procedure.
   With **old, mutually compatible peers**, finish/drain durable events in both
   directions. Then stop the host and every runner, including adopted containers,
   sidecars, supervisors, and automatic restarters.
2. Independently confirm that this installation's host/admin/session sockets
   have no listener, its service is inactive, and no host, container, SQLite
   reader/writer, or external backup job accesses these files. The migrator does
   **not** stop processes, inspect credentials, drain events, or deploy anything.
3. Retain an offline full installation snapshot, including the central DB,
   session tree, attachments, runner state, and configuration. If SQLite
   rollback/WAL sidecars exist, recover the original installation with its old
   SQLite runtime under operator control and repeat the drain/snapshot. Do not
   unlink journals or checkpoint a live database to make preflight pass.
4. Prepare an **independent regular-file staging copy** of the complete
   configured `DATA_DIR/v2-sessions` tree, for example
   `./cutover/data/v2-sessions`. No hard links, symlinks, bind mounts, shared
   volumes, or live writers. Do not put staging inside the deployed `DATA_DIR`.
   Keep source permissions and secrets private. Do not dereference unknown
   symlinks into unrelated directories.

`--attest-offline-copy` is the operator's explicit attestation that steps 1–4
are true: this root is an isolated, complete, unmounted copy, no process can
restart against it during the operation, and the old installation stays offline
through verification and replacement. It is **not** an override for live data.
The tool rejects the configured live `DATA_DIR`, aliases beneath it, links,
non-DELETE journal modes, SQLite sidecars, and any conflicting SQLite lock.
It holds exclusive locks on all original stores during preflight and backup.
Filesystem locks alone cannot prove a container will not start later; the
staging-copy attestation is required even for dry-run.

### 2. Preflight (default, no persistent writes)

Run from the checkout containing the new code and its already-installed Bun
and package dependencies:

```bash
bun scripts/conversation-cutover.ts \
  --staging-data-dir ./cutover/data --attest-offline-copy
```

Discovery is limited to the staging root's `v2-sessions`:

- `<session>/inbound.db`, `<session>/outbound.db`
- `<agent>/<session>/inbound.db`, `<agent>/<session>/outbound.db`
- each existing `<session-directory>/runner-state/runner-state.db`

It includes all sessions, not just currently active central-DB entries.
Orphaned/incomplete pairs and unexpected store depths fail. Missing runner state
is allowed for a session that has never spawned; no runner is silently reseeded.
Attachment and per-group source/cache subtrees (`inbox`, `outbox`,
`.claude-shared`, `agent-runner-src`) are not database-discovery roots.

Preflight checks SQLite integrity and foreign keys, empty
`pending_runner_events` **and** `pending_host_events`, and consistent overlapping
peer evidence. Unequal message counts are valid: the host may have private
direct outputs and the runner may contain only a subset. Conflicting records,
undrained journals, corrupt files, and untracked completed/partial backfills
fail closed. Resolve them using the retained old peers or restore a consistent
pre-cutover snapshot; never discard events or override the checks.

### 3. Apply explicitly

```bash
bun scripts/conversation-cutover.ts \
  --staging-data-dir ./cutover/data --attest-offline-copy --apply
```

Before any schema mutation, the tool creates
`./cutover/data/.conversation-cutover/` with mode `0700`:

- `snapshot/<original-relative-path>`: consistent raw copies of **every actual
  session database**, verified against SHA-256 hashes while exclusive locks
  are held. The inbound store is backed up but never migrated.
- `manifest.json`: exact scope, original file hashes and original-table
  counts/digests, phase, per-file commit progress, and verified final hashes.
  Snapshot files are mode `0600`. They contain private data; protect them.

The Bun CLI runs the mirrored `backfillTurns` implementation on both projections
and `migrateRunnerTurnJournal` only on the runner. Both backfill implementations
accept a shared evidence snapshot. The tool unions proven input routes, output
identities, applied-input receipts, existing turns and links **before** changing
either peer. This also reserves host-only explicit turn IDs when choosing
deterministic IDs for shared outputs. It adds the same turn/input metadata to
both projections, never copies peer-only messages or accounting rows.

Historical turns remain `settled`/`unknown`, with **null start/end times**;
equal timestamps do not combine turns. Missing/conflicting origin evidence
stays unknown. Orphan accounting remains unassociated. Original message content,
usage IDs and numeric values, activity timestamps/text, and prior non-null turn
associations are preserved. Backfill suppresses journal emission, then the
runner's v4 triggers are explicitly installed. No old events are translated.

Each database commits independently. **This is not a globally atomic migration.**
The full original snapshot and manifest phase are the recovery boundary.
An error after one store commits leaves the installation blocked, never
silently marked successful.

## Verify

```bash
bun scripts/conversation-cutover.ts \
  --staging-data-dir ./cutover/data --attest-offline-copy --verify
```

Verification reopens the actual files; it does not trust an in-memory success
flag. It repeats integrity/FK/journal checks, compares all original table
records (including input content, usage IDs/values/totals, and activity), verifies
prior turn identities/associations, new output links, identical peer turn/input
metadata, and all required markers. Overlapping output/usage/activity rows must
agree; nonoverlapping messages are not treated as corruption.
Partial historical accounting records retain their original IDs and only their
reported fields in the browser protocol. Missing cost/counters remain unavailable,
not zero, and associated accounting is not duplicated onto each response.

`--apply` on an already verified copy and repeated `--verify` are read-only
checks. The final file hashes must still match. A later write is **not** blessed
by a rerun. This is cutover verification, not a reconciliation command for an
installation that has resumed operation.

Only after all stores report `verified`, with the old deployment still stopped:

1. Replace the complete session tree **and its `.conversation-cutover` directory**
   together using the installation's controlled offline restore/replacement
   procedure. Never selectively install just host or runner files.
2. Install the matching new host build, runner image/source overlays, and browser
   assets together; do not adopt old runner processes. Preserve the unchanged
   central DB, attachments, and configuration from the same offline boundary.
3. Recheck permissions/mounts and the verified manifest, then separately authorize
   startup and ingress. Reload cached browser clients; old protocol clients must
   not continue. This tooling never starts, restarts, or deploys the installation.

If updates are missed after startup, reconnect/resubscribe to obtain a fresh
authorized projection. Do not synthesize settlement or add usage locally.
Confirmed runner exit disables controls but does not settle a turn; replacement
runner recovery journals the interrupted outcome.

## Failure, retry, and rollback

- After an ordinary partial failure, keep both deployed peers stopped. Inspect
  the manifest phase/committed-file list. Correct the external cause, then use
  `--retry` **on staging only**. It validates the entire original snapshot,
  restores every original file, and reapplies/fully verifies from that same
  boundary. It never continues from independently migrated peer states.
- An interrupted `backing-up` phase can resume only if **every source** still
  matches its recorded original hash. Existing snapshot files must also match;
  they are never overwritten. A truncated/damaged snapshot is not a valid backup.
- To undo a staged migration:

  ```bash
  bun scripts/conversation-cutover.ts \
    --staging-data-dir ./cutover/data --attest-offline-copy --rollback
  ```

  All backup hashes are checked before any restore; all files are restored and
  hashed again. The manifest becomes `rolled-back`, which intentionally blocks
  the **new** host. Restore old code, runner images, browser assets, and the full
  pre-cutover installation snapshot together before separately authorizing old
  startup. Do not remove a tripwire just to run new code on old databases.
- A hard crash can leave hot SQLite journals. The tool refuses them even on
  retry/rollback, rather than recovering or deleting unknown state automatically.
  Retain the failed tree for inspection. Use the verified immutable snapshot
  files (or the full external snapshot) to construct a **new independent staging
  root**, without hot sidecars, and begin again. Do not overlay a hot file.
- A scope mismatch, new session, changed verified file, corrupt backup, or
  untracked backfill requires investigation/a coherent original snapshot, not
  `--force`. There is no force mode and no broad-delete recovery command.
- After new production writes exist, do not run this rollback on deployed data.
  Restoring the original snapshot would discard them. Keep both generations
  offline and design a separate, explicitly approved recovery plan.

## Development validation

`scripts/tsconfig.conversation-cutover.json` explicitly typechecks the Bun CLI
and imported modules; the host tsconfig alone does not cover scripts.
`container/agent-runner/src/db/conversation-cutover.test.ts` tests isolated real
SQLite fixtures, locks, refusal paths, backups/retry and preservation.
`src/ui/server/chat/conversation-convergence.test.ts` drives the real durable
host projector, live socket, authorized reader, ordered stream, and browser
parser/reducer against fresh snapshots. No live deployment is used by these tests.
