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

## Validation

Use focused host/browser tests, host and browser builds/typechecks, and runner
tests/typechecks whenever runner contracts change. Verify actual response
shapes and UI behavior, then regenerate checked-in browser assets. Preserve
unrelated baseline failures rather than masking them.
