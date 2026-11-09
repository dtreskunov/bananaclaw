# Reply suggestions: completed offline cutover

## Current contract

Conversational questions have been replaced by optional editable reply drafts.
`[label](reply:URI-encoded%20draft)` links in final Markdown need no tool call
or separate state record. Lists at the end of the message serve as follow-up
choices too. The former suggestion tool and metadata pipeline are removed.
Approvals remain explicit, separately authorized workflows.

Central, host-session and runner-state stores require `PRAGMA user_version=2`.
Native-provider stores remain version 1, search remains version 2, archives use
format 4, and browser conversations use protocol 17. Empty stores initialize the
current schemas directly. Populated older stores and unsupported archives are
refused, never converted during startup or ordinary reads.

The offline cutover is complete. Its converter, database-rewriting helpers and
conversion fixtures have been retired from this checkout. Runtime validation,
normal history tests, source instructions, and rollback backups remain.

## Older installations

The complete converter, tests and original guide are archived at Git revision
`faca92d40`:

```sh
git show faca92d40:docs/reply-suggestions-cutover.md
git worktree add --detach ../nanoclaw-reply-cutover faca92d40
```

Use that separate checkout and its documented dependencies with a private,
consistent offline copy. Follow the archived inventory, stopped-writer
attestations, candidate verification, supported-event limits and rollback
procedure. The converter produces candidates only; it has no install operation.
Use bounded execution and progress monitoring. Rehearse while the old live
installation remains available, then take a fresh snapshot with the host and
every runner stopped for the final coordinated switchover.

Historical questions and answers become ordinary conversation content, with
message identities, ordering, delivery receipts, read cursors and approval
outcomes preserved. Native provider memory is retained; unresolved retired tool
calls are rejected. The opt-in canonical-host projection policy requires explicit
operator approval and never discards unmatched runner conversation outputs.
Rebuild summaries and search before exposing converted history.

Legacy platform approval buttons require a separately authorized reissue using
`nca:<approvalId>:<option-index>`. Old callbacks are not translated. Reissuing
must preserve the request, option order and approver authority.

Archives predating numeric storage were already unsupported before this
cutover. Preserve them unchanged for a separate historical migration; neither
relabel them nor add a runtime compatibility reader. The archived converter
supports complete numeric v3/v4 exports only.

## Verify and roll back

Verify every inventoried database's storage version, `PRAGMA integrity_check`
and `PRAGMA foreign_key_check`. Expect integrity `ok`, zero FK violations and
no executable conversational question records or replayable old payloads in
active session stores. Verify history/read positions, approval decisions,
archive round trips, ordinary input, and optional draft buttons after reload.

Retain the complete private backup and candidate manifests. Removing migration
code does not delete these backups. Rollback requires stopping the host and
every runner and restoring the complete matching inventory and old runtime
source/images, not just the central DB or one side of a session journal.
Restoring an old snapshot discards newer traffic; preserve the current files
separately before attempting recovery.

## Retiring tool-generated suggestions

The later Markdown-only simplification removes the redundant suggestion tool
and response metadata without changing storage versions. Before deploying to
an installation that used it:

1. With host and affected runners stopped, back up each affected `outbound.db`
   and `runner-state.db`. Require settled turns, drained runner journals, no
   `runner:suggested-responses:*` rows, and matching `response-suggestions:*`
   values and associated output content in both projections.
2. Append each saved reply as a normal `[escaped label](reply:URI-encoded%20draft)`
   list item to its associated message. Preserve IDs, sequences, timestamps,
   routes, turn references and all other JSON fields.
3. Remove the converted metadata rows in both stores. This is offline
   normalization, not runner activity: prevent journal triggers from generating
   replay events during the transaction, then restore the triggers unchanged.
4. Verify SQLite integrity, matching message content, no remaining suggestion
   metadata and unchanged receipts/read positions. Refresh the affected thread
   summaries/search, deploy matching host/UI code, and recycle idle runners to
   refresh tool catalogs. Do not interrupt an active turn.

No normal read path translates old metadata. Historical tool trace entries and
provider history remain inert records. Retain the paired backups for rollback.
