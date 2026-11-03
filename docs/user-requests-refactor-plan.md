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
4. Consider one current-state interaction record only if replacing existing
   duplicated storage and coordination is independently net-reducing.
5. Finish integration by reusing shared message types in host read models and
   shared thread/task resource views in the browser, removing obsolete response
   polling and redundant presentation copies. Local thread presentation permits
   an uncreated session or implicit messaging-group context; authoritative
   thread-list fields stay required.

Measure each completed change and the cumulative delta against the baseline.
Report production, tests, documentation, generated assets, and disposable
cutover tooling separately. Use the same changed-production file set for
before/after complexity. Commit only improvements that preserve behavior and
produce a worthwhile reduction; passing tests alone is not sufficient.

## Preserved behavior

Keep one outstanding question per session, explicit skip, literal text,
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

## Approval storage consolidation

`approvals` retains one current-state record for confirmations and accounts:
request metadata, kind, status, revision, response, outcome and timestamps.
`approval_workflows` contains only private selections, submission aliases and
notification/restart flags. Its joined reader uses the canonical lifecycle;
there is no pending/history copy or mirrored workflow stage.

Questions already have one authoritative current-state row. They remain in
`questions`: forcing unrelated response and effect lifecycles into one table
would add adapters rather than eliminate them.

Generic effects enter `applying` before invocation and cannot replay from any
non-pending state. A host crash during a generic effect requires operator
review of uncertain effects; it never triggers automatic reapplication.
Account effects retain their existing private recovery and explicit retry.
Notifications derive their identity from the approval ID and terminal revision;
private notification flags do not own another result/lifecycle snapshot.

Archive format 2 cancels pending approvals, refuses both persisted and
process-local applying effects, and exports finalized audit records only.
Restoring with sessions never resumes private selections, grants, notifications
or retries. Format 1 archives are deliberately unsupported.
`ncl approvals list` lists retained public records; `--status pending` narrows
it to decisions still needed. Private account progress is never listed.

### Offline cutover: detect / why / fix / verify / rollback

Existing databases with `pending_approvals`, `approval_history` or the old
`approval_workflows` are refused at startup. Fresh databases need no cutover.
This intentionally removes old storage rather than carrying compatibility.

1. Finish the Agent Vault-only cutover first. Stop the host **and all its
   agent containers**, and prevent automatic restart during this procedure.
2. Review outstanding approvals and uncertain external effects. The script
   refuses workflows still marked `applying`; only after inspecting actual
   grants/configuration should the operator explicitly finalize those old
   records. Do not assume stopping a process rolled back an external effect.
3. Accept discarding **all old approval records and private recovery state**.
   Questions, other central records, session journals and actual credentials
   are not reset. No credential grant/revoke or pending effect is executed.
4. From the new checkout, choose an unused, protected backup path and run:

   ```bash
   pnpm exec tsx scripts/cutover-approval-storage.ts /absolute/path/data/v2.db /absolute/path/before-approvals.db --host-and-containers-stopped --discard-legacy-approvals
   ```

   The one-time script checks integrity, saves the old DB, and resets approval
   storage transactionally. It is not part of host startup.
5. Verify the backup, empty `approvals`, `PRAGMA foreign_key_check`, and the
   `retained-approvals` migration record. Build host/browser together and reload
   clients (conversation protocol 9); restart only after verification.
6. To roll back, keep everything stopped, restore the complete protected DB
   backup and the pre-cutover code/assets together. Do not restore only old
   tables into the new host. External credential/configuration changes require
   their own review; restoring SQLite does not undo external effects.

## Validation

Use focused host/browser tests, host and browser builds/typechecks, and runner
tests/typechecks whenever runner contracts change. Verify actual response
shapes and UI behavior, then regenerate checked-in browser assets. Preserve
unrelated baseline failures rather than masking them.
