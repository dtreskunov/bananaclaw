# Interaction data consolidation

Approved: 2026-11-03. Baseline: `bananaclaw` at `577dc5852`.
Implementation branch: `refactor/interaction-shapes`.

## Goal

Reduce production code and complexity by giving equivalent data one shape.
Use composition, discriminated unions, authorized read models, and separate
local UI state. Do not create a general request-processing framework.

The previous `refactor/unified-user-requests` branch is parked, not merged.
Its historical attempts, alias/event/execution tables, generic receipts,
new inbox capabilities, and stronger journaling are not prerequisites.

## Data hierarchy

- Host-owned interactions contain identity, immutable origin, input
  specification, current state, and operation-specific private progress.
- Host and runner message stores carry the same semantic request, response,
  and result bodies inside their respective routing/journal envelopes.
  Runner projections are not another authoritative interaction lifecycle.
- The server projects a safe, authorized interaction view with display
  attribution and permitted actions. Private selections never enter it.
- The browser consumes that exact view type. Drafts, submission state,
  errors, and rendering metadata are local presentation data, not another DTO.
- Messages, interactions, and events are sibling conversation items. Turns
  own execution/accounting data; timeline rows reference items and turns.
  The question dock and transcript render the same interaction.

The wire keeps normalized `messages`, `interactions`, and `turns` collections.
The timeline combines them for rendering. Replacing the former `questions`
collection rather than introducing a mixed message array keeps message-only
processing simple and adds no extra collection or registry.

Interaction variants are question, confirmation, account setup, and access
grant. Keep meaningful states and responses variant-specific:

Account interactions carry `requirements` and the workflow revision directly.
`retryable` is an explicit current capability, false for restored audit records.
Their core data is shared by native/CLI readers and the authorized browser view;
only viewer-specific origin, attribution, and response context are added for
the browser. Account setup/grants use `completed`, not an approval-shaped
`approved` state. The account editor receives this interaction as a prop and
does not fetch or own another request DTO. Private previews bind a
`requestRevision` without copying the request. The editor waits for the
authoritative interaction update after HTTP acceptance.

- A choice answer, literal text answer, and skip are explicit alternatives.
- Approval is not successful application.
- Submission acknowledgement never removes a canonical request optimistically
  or invents an applied outcome; snapshots own visible lifecycle state.
- Account setup is not an agent access grant.
- Public input specifications retain all supported fields end-to-end.
- Stored/public identities and states are required; genuinely absent origin
  or response data is represented explicitly, not guessed from the current UI.

Normalize ergonomic producer inputs once. Validate untrusted JSON at boundaries
and surface invalid data explicitly; do not repeatedly parse typed internal
objects or introduce a custom schema DSL.

## Sequence and gates

1. Remove server/client type duplication and message-copying transformations.
2. Carry complete input specifications and typed answers through producers,
   storage, host/runner messages, server contracts, and UI.
3. Consolidate authorized interaction presentation and conversation item shapes.
4. Replace duplicated question/approval storage with one current-state
   interaction record after preservation and behavior verification. The user
   explicitly accepted the bounded candidate's small LOC/complexity increase.
5. Finish integration by reusing shared message types in host read models and
   shared thread/task resource views in the browser, removing obsolete response
   polling and redundant presentation copies. Local thread presentation permits
   an uncreated session or implicit messaging-group context; authoritative
   thread-list fields stay required.

Measure each completed change and the cumulative delta against the baseline.
Report production, tests, documentation, generated assets, and disposable
cutover tooling separately. Use the same changed-production file set for
before/after complexity. Commit only improvements that preserve behavior and
produce a worthwhile simplification; passing tests alone is not sufficient.
For the unified-store step, the user approved the measured +2 non-reference
production LOC and +8 cyclomatic points in exchange for one canonical store.
This exception does not authorize unrelated expansion or a generic engine.

## Preserved behavior

Keep existing question serialization and single-active-question controls,
retained pending queues, explicit skip, literal text,
choice labels, multiline/voice input, pending input controls, transcript
ordering and attribution, private account management, exact consent and
revision checks, user-owned credentials, and existing delivery guarantees.

The host checks authorization on every read and mutation. Browser capabilities
are presentation hints, never authorization. Real secrets remain in Agent
Vault/private account management, never runner messages or shared views.
Each SQLite file retains its single writer and existing acknowledged session
link. No new generic retry UI, inbox features, linked setup/access behavior,
or stronger delivery guarantees are bundled into this consolidation.

No legacy compatibility is required. If storage changes, use one explicit,
offline, disposable cutover script. Do not run it against live data as part
of development; do not add permanent historical readers or converters.

## Unified current-state storage

The `experiment/unified-interaction-store-20261103` worktree implements the
next step against immutable `412af3c15`. Promotion and the necessary offline
database cutover were explicitly authorized on 2026-11-03.
`interactions` replaces both `questions` and `approvals`; there are no old-table
views or runtime converters. Its `kind` distinguishes question, confirmation,
account setup and access grant. Identity, origin associations, current state,
revision, attribution and timestamps are common. `input_json` stores the complete
immutable input, including question placeholder/multiline hints. `response_json`
stores a tagged question choice/text/skip or a consent decision/note, not nullable
answer-type/value combinations. Original outbound anchors still own turn and
timeline provenance, not another input definition.

`interaction_progress` holds only private selections/recovery, submission aliases,
and notification/restart flags. It has no copied input or lifecycle. Specialized
question and approval mutations and operation-specific authorization remain
distinct; there is no generic effect/retry engine or new runner protocol.

Generic effects enter `applying` before invocation and cannot replay from any
non-pending state. A host crash during a generic effect requires operator
review of uncertain effects; it never triggers automatic reapplication.
Account effects retain their existing private recovery and explicit retry.
Notifications derive their identity from the approval ID and terminal revision;
private notification flags do not own another result/lifecycle snapshot.

Archive format 3 now stores one `interactions` collection, cancels pending
interactions, refuses both persisted and
process-local applying effects, and exports finalized audit records only.
Restoring with sessions never resumes private selections, grants, notifications
or retries. Old-shape archives are refused explicitly: restore them with their
original host in an isolated offline copy, then cut over that copy. Neither old
archives nor private account progress are silently converted at runtime.
`ncl approvals list` lists retained public records; `--status pending` narrows
it to decisions still needed. Private account progress is never listed.

### Offline cutover: detect / why / fix / verify / rollback

Existing `questions`/`approvals` storage fails closed with this guidance. Fresh
databases create only the canonical store. Migration application is keyed by
`current-state-interactions`, not its numeric file prefix. The unrelated
Agent Vault-only migration/security checks remain required and unchanged.

The completed converter and its conversion-only tests have been retired.
The reviewed `scripts/cutover-interactions.ts` remains recoverable with its
matching source in commit `c70cbc6ca`. Fresh-schema creation and legacy-storage
refusal tests remain in the current host; rollback backups are retained.

The converter is an explicit offline tool for the `retained-approvals` schema at
`412af3c15`, not a startup migration. It preserves
IDs, full input specifications, tagged answers, responder attribution, notes,
timestamps, statuses, revisions, dedupe keys, aliases, private selection/recovery
JSON and notification/restart flags. It never resets records, calls credential
APIs, opens runner-state.db, or executes an effect.
Six retained title-based legacy questions omit outbound `responseMode` and keep
the short display title in `question_text`. Only when that title exactly matches
the outbound title does the converter recover the retained response mode and
preserve the full outbound question as canonical input. Original messages,
including the short titles, remain untouched; invalid origins still fail closed.
The source permits multiple retained pending questions in a session (two such
queues exist in this installation). The replacement uses a non-unique pending
lookup index as well; cutover never cancels a question to impose new uniqueness.

1. Finish the Agent Vault-only cutover first. Stop the host **and all its
   agent containers**, and prevent automatic restart during this procedure.
2. Review outstanding approvals and uncertain external effects. The script
   refuses workflows still marked `applying`; only after inspecting actual
   grants/configuration should the operator explicitly finalize those old
   records. Do not assume stopping a process rolled back an external effect.
3. Rehearse on an isolated copy of the central DB and host-owned session tree.
   The tool requires explicit `--offline`, no host socket, stopped session
   container states, no applying effects, and a SQLite writer lock. Reconcile
   stale container flags only after proving the host and its containers are
   stopped (or absent in an isolated rehearsal). Never finalize uncertain
   approval effects merely to bypass these checks. Missing/invalid outbound
   question provenance and global ID/alias collisions are hard errors.
4. If another retained-approvals installation needs conversion, recover the
   reviewed source into an isolated historical worktree and prepare its locked
   dependencies. Do not graft the converter onto a later schema or restore
   legacy readers in the current host:

   ```bash
   git worktree add --detach /offline/cutover-source c70cbc6ca
   cd /offline/cutover-source
   ```

   Choose a new backup file in an operator-owned mode-0700 directory and run
   **only against the authorized, stopped database** (an isolated copy for
   rehearsal, then the original installation for the approved cutover):

   ```bash
   pnpm exec tsx scripts/cutover-interactions.ts --db /offline/data/v2.db --sessions /offline/data/v2-sessions --backup /private/original.db --offline
   ```

   Before mutation it checks integrity/FKs and makes and verifies a mode-0600
   SQLite backup through a separate read connection while writers are excluded.
   It copies current state, removes old stores and adds the named migration
   record in one transaction. Any conversion failure rolls that transaction back.
5. Verify exact source/destination inventory and every input/response/progress
   field against the protected original, integrity/FKs, absence of old stores,
   and the `current-state-interactions` migration record. Build host/browser
   together and reload clients (conversation protocol 10). Review, rehearsal,
   verified backups and explicit authorization are required before promotion.
6. To roll back, keep everything stopped, restore the complete protected DB
   backup and the pre-cutover code/assets together. Do not restore only old
   tables into the new host. External credential/configuration changes require
   their own review; restoring SQLite does not undo external effects.

## Validation

Use focused host/browser tests, host and browser builds/typechecks, and runner
tests/typechecks whenever runner contracts change. Verify actual response
shapes and UI behavior, then regenerate checked-in browser assets. Preserve
unrelated baseline failures rather than masking them.

### Bounded candidate result — promotion approved

The initial candidate was evaluated in `/mnt/ssd/ncl-store` on
`experiment/unified-interaction-store-20261103`, based on `412af3c15`, without
changing live data or calling credential APIs. The measurements below describe
that complete candidate before promotion hardening (including archive format 3).

Validation passed: host build; browser typecheck/build; standalone cutover-tool
typecheck; 614 tests across 27 files, including Node/Bun response/restart
integration and 16 synthetic cutover cases. Synthetic fixtures exercise a
42-question (32 answered / 10 pending), three-approval, nine-group inventory in
DELETE and WAL modes, byte-preserved private progress/aliases/flags, protected
original backups, and transactional refusal of locks, active/applying state,
collisions, malformed/missing provenance, invalid answers/progress, unknown
columns, and FK violations. Runner sources/protocol were untouched.
Changed-file lint retains one pre-existing unused `chatMessages` import in
`stop-actions.test.ts`; new storage/migration modules pass lint.

Using the prescribed measurement scripts on the full integrated changed file
set (including new/deleted modules), authored production is **458 added /
476 removed = -18 physical LOC** (6,968 → 6,950; nonblank 6,515 → 6,492).
Tests are +384 LOC; disposable offline tooling is +262; generated assets are +2;
fixtures are unchanged. Documentation is +33 LOC, counted separately from
production. Cyclomatic sum is **1,567 → 1,575 (+8)**, actual branch increments
**1,223 → 1,222 (-1)**, functions **344 → 353 (+9)**, and maximum complexity
remains 63. Static imports are 251 → 259; runtime static imports 213 → 219.

Twenty removed lines are the reference-only central schema copy, so other
integrated authored production is **+2 LOC**, not a runtime-code reduction.
The initial reduction-only gate rejected this candidate. The user explicitly
accepted +2 LOC and +8 complexity points as insignificant and approved proceeding.
The architectural benefit is one canonical current-state store, complete typed
input/response values and shared persistence/projection, not a LOC claim or a
generic effect engine. Promotion retains the preservation, authorization and
recovery requirements above; all nine groups and their access relationships
remain in the installation.

### Promotion verification

The real-data rehearsal preserved 42 questions (32 answered / 10 pending),
two approved confirmations, one completed account setup and its private
progress. All 33 unrelated table fingerprints matched, including identities,
roles, memberships, group configuration and credential metadata. Integrity/FK
checks passed, as did restoring the backup and comparing every original table.
The rehearsal exposed and corrected the historical title-based input conversion
and an unsupported uniqueness constraint; both now have regression tests.

The complete host/browser suite passed 3,247 tests with the same 21 baseline
failures. After the rehearsal fixes, 63 focused storage, cutover, archive and
question-response tests passed, including 19 disposable cutover cases.
Host/browser builds and typechecks, runner typecheck and standalone converter
typecheck passed. Deployment evidence is retained with the installation's
protected upgrade backups rather than treating this document as a live status
or adding a permanent migration/recovery framework.

## Conversation dependency-boundary phase

The next step separates authorized context and history projection from the HTTP
controller, with no new lifecycle, protocol, schema or request engine. Context,
history and public conversation/approval readers have one-way dependencies.
History reuses the already-authorized session instead of repeating target and
session resolution. Input handling, DM/identity scope, pending edits, attachments,
attribution and task events keep their existing behavior.

UI flags, mount prefix and external URL calculation now have a small
configuration owner below HTTP startup. Commands, credential operations and
link helpers import that owner rather than the server. No compatibility
re-exports preserve the former cycles.

Against `61a2035f8` (converter cleanup), this adds 36 production physical LOC,
removes two cyclomatic/branch increments and adds no production functions.
The full resolved static runtime import/re-export graph changes from one
seven-module cycle to no cycles (517 to 520 modules); type-only and dynamic
imports, tests and generated files are excluded from that measurement.
The largest function remains complexity 217; reducing that HTTP dispatcher
is a separate step, not hidden by this extraction.

The full host/browser suite passes 3,247 tests with ten unrelated existing
failures (five CSS assertions, four approval-card attribution expectations and
one builtin-count fixture). The eleven host-routing tests formerly blocked by
eager UI initialization now pass without changing their tests. New import
guards prove authorized readers and configuration load without HTTP startup;
configuration precedence and URL fallback behavior are covered explicitly.

## Input attention phase

The approved user-facing follow-up adds one authorized, ordered navigation
projection of canonical pending questions, confirmations, account setup and
access grants to global sync. Shared response authorization determines
eligibility before counting; private recovery/selection data is excluded.
The host/browser sync contract is shared, with no waiting-state table, copied
lifecycle, persistent counters, new poller, runner change or storage migration.

One shared amber badge counts requests on agent tabs, the mobile agent picker
and thread rows. A single clickable amber total floats over the transcript above
the composer, with no position indicator or additional controls. It opens the
newest request first, cycles through older requests and wraps. A thread badge
always opens the newest request in that exact thread. Navigation uses existing
routes and forms, preserves exact non-web context and focuses a request once
without stealing focus on later snapshots. Manual request focus updates the
navigation cursor. Newest-first presentation is client-only; the server's stable
oldest-first contract is unchanged.

Counts derive from the same authoritative list and do not clear when viewed or
on HTTP acknowledgement. Refresh errors retain last-known information instead
of reporting a fabricated zero. Stable canonical IDs handle pending queues and
cross-client resolution. Browser push and a separate inbox are not part of this
phase.

### Attention LOC and complexity review

Against pre-feature `eb52f19b0`, the original `8fa9460ef` implementation adds
419 production LOC, 497 test LOC, 349 generated LOC and 51 documentation LOC.
Across the same changed-production TypeScript/TSX module set, classic cyclomatic
complexity increases by 132: 103 branch increments and 29 functions. This is a
new user-facing capability, not a net code-reduction claim.

A follow-up removes redundant focus subscriptions, nullable authorization
plumbing and an impossible nullable-navigation branch, and shares previous/next
control rendering. It removes 13 production LOC and seven branch/complexity
points without changing production function count, permissions or wire behavior.
The feature's resulting production delta is +406 LOC, classic cyclomatic +125
and branch increments +96; runtime imports remain acyclic. A replacement-stream
focus regression is retained, and targeted tests/builds/typechecks pass.
