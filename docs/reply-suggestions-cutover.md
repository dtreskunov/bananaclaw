# Reply suggestions: offline candidate cutover

`ask_user_question` is removed, not deprecated. `suggest_responses` attaches
draft reply text to an explicitly completed response; it is not an interaction,
does not end a turn, and does not backfill historical suggestions. There is no
runtime compatibility reader for old questions, callbacks, or archives.

## Detect / why

Old installations have host/runner storage version 1, `interactions.kind =
'question'`, question publications, `ask_question` outputs, conversational
`interactive_response` inputs, or system `question_response` inputs. The new
central, inbound, outbound and runner schemas are **storage version 2**;
complete archives are **version 4**. Native-provider stores remain **version 1**
when no structural conversion is needed.

Do not open old stores with the new host/runners and do not restore a v3 archive
directly. The version gates intentionally refuse them. No startup migration,
network replay, approval application, provider invocation or service bootstrap
is part of this tool.

## Prepare

1. Stop the host **and every runner**, including orphaned containers. The two
   flags below are explicit operator attestations, not a process detector.
2. Keep an independent, untouched backup. Prepare a consistent, isolated offline
   copy of `data/v2.db`, all referenced `data/v2-sessions/<group>/<session>/`
   trees, `groups/`, and archived group/session trees. Never point the converter
   at the running checkout, its `data`, or its `groups`.
3. Obtain a clean SQLite snapshot without `-wal`, `-shm`, or `-journal` files.
   This prototype refuses even empty sidecars. It never checkpoints a source.
4. If preflight reports an unsupported durable mutation, converge it with the
   **old** runtime in an independently restored/controlled installation before
   stopping and taking another snapshot. Do not delete queues or edit receipts
   to bypass refusal.
5. Choose a **nonexistent** output directory with an existing parent, entirely
   separate from the source. Neither root nor descendants may be symlinks.
   A source/output equality, nesting, existing output, hard link or special file
   is refused.

From this code checkout, using only the prepared offline copy:

```sh
pnpm exec tsx scripts/migrate-reply-suggestions.ts \
  --source-root "$PWD/offline-copy" \
  --output-root "$PWD/private-candidate" \
  --host-stopped --runners-stopped
```

There is deliberately no `--install`, `--force`, overwrite, implicit source,
service, environment-file or credential-bootstrap operation. Preflight works
on private working copies and creates no candidate until all conversions are proven. Candidate
directories are mode 0700 and files are 0600. An I/O failure while writing can
leave an incomplete candidate; without a successfully written manifest it is
not a verified result.

## Supported conversion

- Fresh canonical schemas are imported from the current host and runner DDL.
  Source CHECK constraints and triggers are **not** copied. Rows are inserted
  strictly in foreign-key order; collisions and unknown tables fail.
- Live and complete archived session inventories include `inbound.db`,
  `outbound.db`, and `runner-state/runner-state.db`. All three are required.
  Archives must have the complete v3/v4 wrapper, including interaction dumps,
  session dumps and all relationship arrays. Archived trees use `<group>~`
  or the numbered archive suffix and must be unambiguous.
- A conversational question becomes ordinary static chat containing the
  original question and option labels. Pending/cancelled questions include
  state prose. No user response is invented and no suggestions are attached.
- An answered question requires the deterministic `question-response:<id>`
  row in both converged inbound projections, with matching response type,
  recorded value, timestamp and available author evidence. Missing/conflicting
  evidence fails explicitly: there is no trustworthy new sequence, input state,
  author or turn to invent. A queued host upsert can recover a missing runner
  copy before this check.
- Existing conversational answers become ordinary chat with quoted question
  context. Skips are explicitly stated. Choice replies retain the recorded
  value and the selected label when they differ; the static question retains
  the original option label. Known sender display metadata is included without
  inventing a canonical author.
- Approval output payloads become
  `{type:'approval_request',approvalId,title,body,options}`. Options and approval
  rows retain their values/status/results; no approval is applied. System
  `question_response` payloads become `system_response`, replacing `questionId`
  with `requestId` and retaining status/result and other fields.
- Message IDs, sequences, routes, dates, processing/input states, claimed
  inputs, turn references, checkpoints and delivery receipts are preserved.
  A receipted output remains receipted; an undelivered static output remains
  eligible. The tool does not send either.
- Question publications become message publications **in place**, anchored to
  the existing output ID. Position, key, visibility, read cursors and user
  unread baselines remain unchanged. A conflicting message publication fails
  rather than merging/removing positions.

### Durable queue proof and precise limits

The implementation follows the ordering/digest/watermark rules in
`src/session-link-durable.ts` and
`container/agent-runner/src/db/host-state.ts`, without importing their runtime
effect handlers. Source journals are transformed **after** offline convergence,
so old executable payloads cannot replay.

Unacknowledged host events supported: `message.upsert` (the source journal's
`content_hex` encoding), `message.delete`, `sequence.floor`, and validated
`thread-title.upsert`.
Unacknowledged runner events supported: `message.upsert`,
`processing.upsert`, `processing.delete`, `state.upsert` **only for `input:*`**,
and the empty `batch.persisted` barrier. Event envelopes/columns, sequence
continuity, new-output sequence/turn anchors, and final two-way projection
convergence are checked. Processing receipt timestamps are intentionally
store-local: the existing host receipt date and runner transition date are
preserved rather than requiring equality. A newly projected processing row uses
the recorded event transition date, never the migration wall clock. `input:*`
states must have the canonical hashed message key, known application-state
fields/status, and existing message/turn references; malformed/orphaned state
is refused rather than interpreted.

Already-acknowledged runner events require the exact existing event ID,
sequence, type and SHA-256 digest. A missing/pruned receipt for an old pending
event fails even where the online receiver might ignore an old sequence.
Acknowledged host journal entries are bounded by the committed runner watermark.
Final projection equivalence is still mandatory. No sequence floor is guessed
for a lost/truncated journal.

Unacknowledged routing, destination, fork, title deletion, turn, turn-input, telemetry,
container, checkpoint, task, provider-continuation, edit/cancel-receipt,
suggestion or unknown events **fail preflight**. Unknown/divergent state and
unfinalized `runner:suggested-responses:*` state also fail. Existing unsettled
turns, tool-in-flight state and missing/regressed timeline clocks require
recovery first. This narrow prototype
does not emulate settlement, input mutation receipts, telemetry fallback,
optional validation skips, approval effects or provider resumption.

Queues are emptied only after proof; event IDs, original payload digests and
sequences survive in the private manifest. Applied runner receipts, committed
host watermarks and SQLite AUTOINCREMENT clocks survive in the candidate.
Questions are removed only after the session/response/publication proofs.

For installations whose earlier offline maintenance updated host history but
left older runner projections, `--canonical-host-projection` requires an
explicit operator choice. Both sides must already be settled with no tool in
flight. Pending runner events still require normal receipt/order proof. The
complete current host snapshot then hydrates its runner projection and covers
gaps in the host's projection-only journal; the committed watermark advances
to the host journal's recorded AUTOINCREMENT boundary. Runner-only conversation
or action outputs are refused, never discarded. Superseded internal rows remain
in the rollback backup. Existing message IDs/sequences and read cursors do not
change; sequence/timeline clocks advance only to cover recorded positions.

Questions whose old lifecycle rows were retired are reconstructed as inert
historical context from their recorded output, without inventing an answer or
resolution. Host-authored even-sequence outbound notices remain unchanged;
new runner events still require odd sequences.

Native files at `<session>/native-state/native-state.db` are copied byte-for-byte
at version 1 after table/column and history inspection. Known optional tables
may be absent, as in the current native runtime's additive schema. Historical
retired tool calls are inert model context, not commands to execute: complete
call/result pairs are preserved, while malformed or unresolved retired calls
fail preflight. Other opaque artifacts with executable legacy discriminants,
provider-native databases, unknown tables,
partial exports, missing session copies, ambiguous archives and publication
collisions require a separately reviewed converter. Working databases and
candidate files are spooled in a private temporary directory beside the
output, with bounded SQLite caches. Hashes are streamed; total database/file
inventory no longer has to fit in memory. The final candidate appears only
after all conversions are proven, and persisted table counts are checked.
Only a session's working handles stay open during reconciliation; those files
are closed before the next session. Disposable scratch copies use memory
journals and disabled per-transaction synchronization: a crash invalidates
scratch, never the source. Candidate files are copied only from closed stores,
explicitly flushed, then reopened for integrity/count/hash validation.
Progress is printed every 25 reconciled sessions and 50 rebuilt stores.
For fleet-scale runs, set an external wall-clock limit, keep the old host
available during rehearsal, and never leave a stopped installation unattended
while waiting for conversion. A missing manifest is not a successful migration.

## Active-installation deployment scope

Archives in v1/ISO format were already rejected by the previous v3 restorer.
An operator may explicitly preserve those unsupported archives unchanged,
including in the complete rollback backup, and migrate only current active
stores. Do not describe them as converted, do not relabel their version, and
do not install a compatibility reader. A separate historical conversion is
still required before any future restore. Unchanged workspace files and other
provider artifacts must remain at their original live paths; a canonical
database-only snapshot is not a complete rollback backup.

## Verify

`candidate-manifest.json` records source/candidate SHA-256 hashes, version
contracts, per-file source/target versions and table row counts, conversion
counts and durable event proofs.
Source checksums are checked before and after planning/writing. Every generated
database is checked for version, foreign-key integrity, SQLite integrity and
remaining executable question discriminants, including after writing.
The manifest is private and must not be published with personal data.

Inspect the static questions/answers, exact approval options, archive v4 dumps,
receipt rows and publication positions in the candidate. Rerun against a
different **new** output root to check retry determinism; reusing an existing
candidate is refused. A question-free v2 candidate is also accepted as an
offline source.

Maintained central thread summaries are cleared and marked `ready=0`; existing
`unread_ready`, publications/read cursors and unread baselines are retained.
**Rebuild maintained summaries/search before exposing candidate history.**
The prototype does not claim stale search/previews are valid; unknown external
search stores are unsupported. Coordinate the rebuild with the host's canonical
summary machinery without reseeding unread positions.

Old externally delivered approval buttons are not rewritten on their platforms.
Prepare an explicit reissue plan using **`nca:<approvalId>:<option-index>`** and
the canonical option order. Legacy `ncq` callbacks and literal-value callbacks
are invalid. Reissuing is a separate authorized operation; this tool performs
**no network requests** and does not auto-reissue receipted outputs.

Fixture validation:

```sh
pnpm exec vitest run scripts/migrate-reply-suggestions.test.ts
```

## Rollback

There is no installation step to undo: discard the new candidate and keep the
source/backup untouched. Do not overwrite source stores with candidate files.
For a separately reviewed later switchover, rollback means stopping host and
all runners again and restoring the **complete old installation and matching
old runtime**, not mixing schema versions or only restoring `v2.db`.
Keep external approval-reissue records to avoid duplicate decisions/messages.
