# Runner session link

NanoClaw uses one host-created Unix-domain socket per active session for all
host/runner communication. Live runner signals are best-effort; durable events
in both directions are journaled by their owner and acknowledged only after the
receiver commits them locally.

## Capability boundary

### Browser conversation projection

`readConversation` in `src/ui/server/chat/conversation.ts` projects a single
authorized channel/platform/thread from host-owned state. Messages, input
dispositions, explicit turns, questions and action capabilities are read
synchronously. Final response rows remain staged until their turn's durable
`settled` barrier; outputless turns remain visible. Live trace and usage are
joined by turn ID, never by the next response or a typing timeout. Billing
records retain their accounting IDs even when a turn has multiple outputs.

`onConversationChange` is an invalidation bus, not a delivery protocol. Host
input/output commits, durable runner application, live signals and question
mutations invalidate it. Subscribers must reauthorize and reproject; invalidation
itself does not prove a changed browser view. DB helpers defer notification
until synchronous outer transactions have unwound. A rolled-back write can
invalidate but cannot publish new state. Projection failures are explicit,
not successful empty histories. Unknown imported origins expose only sidecars
anchored to visible messages; off-route sends never expose the source trace.

The host listens at a hashed path below `data/.session-links/` and mounts only
that session's leaf directory at `/run/nanoclaw:ro`. The runner connects to
`/run/nanoclaw/runner.sock`.

The mount is the capability. Frames do not choose a session: the host listener
already owns the session ID, and ignores any extra identity fields supplied by
the runner. The private root is mode `0700`; the mounted leaf is `0755` and the
socket is `0666` so Docker and rootless Podman UID mappings can connect. The
leaf is not reachable without receiving its private bind mount.

The directory, rather than the socket inode, is mounted so an adopted container
sees a replacement socket after the host unlinks and rebinds it during restart.

## Protocol

Version 4 is newline-delimited JSON. Every frame contains `v: 4` and a closed
`type`. Live frames are capped at 16 KiB; durable frames are bounded by the
configured output cap plus envelope overhead. Each session is limited to 256
frames and 24 MiB per second,
accepts at most 32 connection attempts per second, allows one live connection
per session, closes on malformed input, and validates
each payload before updating memory. The frame budget belongs to the session,
not the connection, so reconnecting cannot reset it.

Supported live runner signals:

- `heartbeat`
- `activity.clear` and `activity`
- `usage.clear` and `usage`
- `turn.resume` and `turn.end`
- `turn.state`, carrying the immutable active turn ID, `running`/`stopping`
  status and originating channel/platform/thread, or `null` after settlement

Activity is capped at 128 current steps and text fields are bounded. Usage
numbers must be finite and non-negative. Live state is best-effort: the runner
keeps its current snapshot in memory and replays it after reconnect, but the
socket does not acknowledge or journal these signals.

Activity carries `turnId`, its original emit-time `ts` and a turn-local
`ordinal`; usage carries `turnId` and emit-time `ts`. Reconnect replays these
unchanged, rather than inventing a new time or a successor's identity.

The runner creates a durable logical turn before invoking the provider.
`turn.upsert` and `turn-input.upsert` precede its output, activity and usage
events, which carry `turn_id`. Steering and corrective prompts stay on that
turn; stale-continuation retries also retain its ID. Ordinary queued input
starts a new turn only after the previous result has finished persisting,
including asynchronous model-limit enrichment. Providers are never given
several independent queued turns to collapse into one result.

The MCP registry captures a DB-backed `runner:turn-context` at invocation,
using async-local storage across awaits. This works in both in-process tools
and external stdio sidecars; late completion cannot read a successor's ID or
reply address. The context is routing metadata, not a credential.

**Coordinated offline upgrade:** stop both peers after draining the v3 runner
journal, back up all three session databases, run the explicit turn-schema and
backfill helpers documented in `db-session.md`, then call
`migrateRunnerTurnJournal(db)` from the Bun runner package on each runner DB.
It refuses undrained old events and recreates the versioned journal triggers.
Verify `conversation_sync_migrations` contains `journal:2`, and that turn
associations match on both peers before starting the v4 host and new runners.
Production DB open does not migrate an existing journal. Roll back code and
the backed-up databases together; mixed protocol versions are unsupported.

User cancellation uses a host-to-runner live `turn.stop` control carrying the
exact turn ID. Both peers compare it with the active turn; stale controls never
apply to a later turn. The runner replays `turn.state` on reconnect, reports
`stopping` while cancellation is in progress, and records the stopped response,
activity and completion before clearing the turn. The control is intentionally
not a queued inbound message and does not discard or claim queued follow-ups.
A disconnected or unconfirmed stop is reported to the UI rather than treated
as success; the user can retry the same turn ID. Durable conversation mutations
continue to use the journal/acknowledgement protocol below.

### Steering (native provider)

Native conversational turns advertise `supportsSteering: true` on `turn.state`.
The absence of this optional capability means ordinary queued follow-ups; it
must not be inferred from a group's saved provider setting while another
container is running.

Steering is durable input, not a `turn.stop` control. Web submissions may carry
`inputHandling: { mode: "steer" | "queue", turnId }` in their inbound content.
The runner only steers an explicitly targeted web message into that turn.
Eligible external-channel chat messages steer automatically, but only when
channel, platform/chat and thread match the active turn. Other conversations in
a shared session remain queued. Commands, scheduled tasks, interactive answers,
agent-to-agent messages and passive accumulated context do not steer.

The native provider lets the current model step and its tools finish, persists
their results, then incorporates guidance before generating again. Steering
keeps the logical turn ID, reply address and usage/activity accounting. It does
not cancel tools, reset the step budget, or undo already-delivered updates.
Explicit Stop still cancels; accepted but unapplied guidance remains pending.

The runner journals message dispositions in `session_state`, under
`input:<sha256(internal-message-id)>`. Values include the message ID, status
(`queued`, `steering`, `applied`, `processing`, `cancelled`), and optionally the target turn
and a fallback reason. A queued HTTP request or inbound echo is not proof of
application. `applied` is written only after the provider persists the guidance;
the native store records input IDs with their history entries for replay
deduplication. The host publishes input-state changes after committing these
durable events, and history reconstructs them on reconnect.

If a target turn finishes before application, the input is retained as a
follow-up, with an explicit outcome in chat. The current turn never consumes
another conversation's steering or a stale target intended for an earlier turn.

Durable runner-to-host frames carry an event ID, journal sequence, type, and validated payload.
The runner commits each mutation and event to `runner-state.db`. The host applies
events in order to its own `outbound.db`, records an event digest in
`applied_runner_events`, and ACKs only after the transaction commits. Identical
replays are acknowledged without reapplying. A valid durable envelope whose
event is rejected receives a bounded fatal NACK; the runner retains that journal
head, stops the link, and exits with a temporary-failure status by default.
Malformed envelopes and frames still close the connection without a response.
Runner APIs enforce the same message-size and attachment-collection limits before
journaling. The link sends one durable frame at a time and waits for its ACK; a
missing ACK closes the connection after 10 seconds so the event can be replayed
without allowing a batch of large frames to overrun socket or host rate budgets.

Host-to-runner events use the symmetric `host.event` / `host.ack` flow. SQLite
triggers append message and sequence mutations to `inbound.db.pending_host_events`;
routing and destination replacement helpers append atomic snapshot events. The
host sends one event at a time and removes it only after the runner commits the
change to `runner-state.db` and ACKs. A reconnect replays the unacknowledged head.
The runner rejects sequence gaps and waits for `host.ready` before constructing
the provider, so its first prompt always sees a complete routing/message snapshot.
Invalid host events receive a fatal `host.nack` and remain journaled for diagnosis.

The final `turn.upsert` with `phase=settled` is the identity-bearing delivery
barrier: its input associations, messages, usage, activity and metadata have
already committed in journal order. The old anonymous `turn.persisted {}` event
is rejected. Tool-origin and system messages can wake delivery
immediately. `batch.persisted` follows each fully persisted logical result and
wakes processing reconciliation only after its task attempts and completion
acknowledgements are final. This boundary does not wait for a warm provider query
to close. A 60-second host scan recovers messages committed immediately before a
host crash; routine one-second outbound polling is gone.

### Lifecycle and metadata

Turns progress through `running`, optional `stopping`, `settling`, and
`settled`. Only a terminal turn has an outcome and `ended_at`. Native outcomes
are `replied`, `warning`, `silent`, `stopped`, `failed`, or `interrupted`.
An intentionally silent corrective response needs no synthetic message.
Provider failures, including provider construction and outer fallback paths,
remain failures even when a human-readable error is delivered.

Activity is journaled as it is emitted, even with no output. Final settlement
may anchor it to the last turn-owned output without changing turn/ordinal or
emit time. MCP invocations register outstanding work in runner state; a result
cannot settle or accept a successor until captured tool invocations complete.
An irrecoverably hung/crashed tool sidecar therefore needs runner termination,
not a fabricated successful settlement.

`session_state['turn-metadata:<turn ID>']` is a versioned-by-protocol metadata
record (`turnId`, `durationMs`, `model`, `usageId`, `status`, `final`). Status is
`provisional` before any report, `partial` for reported calls/incomplete attempts,
`final` for completed reported totals, or `unavailable` when no usage was
reported. `final=true` means the metadata is settled, not that token coverage
is complete. Missing reports never create zero-token usage rows.
One stable usage row (`tu-<turn ID>`) is overwritten with the accumulated
reported billing across attempts; aggregate reports replace the current
attempt's call deltas, not add them again. Provider durations never reset the
logical turn's walltime. Usage timestamps and IDs survive re-linking.

`onSessionTurnChange` notifies host consumers after durable commits, with
changed turn IDs and an optional settled ID; identical replays do not produce
new mutations. `getSessionTurnSignals` preserves live turn IDs, activity
ordinals/times and usage time for a later projector. `readTurnMetadata` exposes
the durable metadata contract. These hooks do not implement browser projection.

A lost socket is not completion: the host retains the last matching turn.
`confirmSessionRunnerExit` emits a separate `runner-exited` observation only
after a successful runtime wait, not a failed watcher or link disconnect.
On replacement-runner startup, abandoned durable turns are journaled as
`interrupted` before any fresh input is consumed. Their end timestamp records
when interruption was confirmed; duration retains the last observed value
(or null), not invented downtime or a success. Until that replay commits, the
projector must present a confirmed exit as interruption pending reconciliation.

The runner waits on host event notifications instead of polling. Future
`process_after` rows use one timer for the next due timestamp; active-query
follow-ups use the same event signal with dirty reruns. `inbound.db` and
`outbound.db` remain private host journals and are not mounted into the
container. Attachments remain file-backed: `inbox/` is mounted read-only and
`outbox/` read-write.

## Transcript order and the pending queue

Queued follow-ups are not part of the consumed transcript yet. The runner marks
them with `queuedForNextTurn: true` in their durable input receipt; the web UI
shows those still in `queued` status as ordinary bubbles below the active turn,
with a subtle footer status rather than a separate queue section. A first input
awaiting cold startup is not automatically a follow-up.

On first consumption, an input receives an immutable `timelinePosition`.
Outbound content receives a position from the same runner-local logical clock
when written. Positions are positive safe integers in epoch-microsecond units,
allocated as `max(now * 1000, previous + 1)` in SQLite transactions. This
distinguishes same-millisecond events and remains monotonic across clock
adjustments and restarts. Positions travel as JSON numbers, serialized with
`JSON.stringify`, without modifying the messages' original timestamps.

History and live frames expose these positions independently of pending-state
badges. Completion can remove a badge without losing placement. Editing,
recovery and retry never replace an existing consumption position. Applied
steering is placed at its application boundary within the current turn; a
queued follow-up is placed only when its successor turn consumes it.

History, client rendering, and branch cutoffs/digests use the same ordering
rule. Forks inherit the selected inputs' positions and never copy a known
still-queued follow-up into the consumed history. Old records without positions
retain timestamp ordering; historical consumption times are not guessed.

## Pending web-input edits

Only native currently advertises `supportsInputEditing` on its active turn.
The web endpoint accepts text-only edits to the viewer's own pending web inputs;
attachments, routing, ID, sequence and steering intent are unchanged. A stale
host `processing_ack` is not sufficient to authorize an edit.

The host journals a non-triggering `system` message (`edit-<request UUID>`) with
`action: "edit_input"`, the target ID, expected text and replacement text. It
does **not** change the target yet. The runner processes edit commands before
claiming ordinary inputs and compares the original text against its authoritative
projection. It rejects already claimed/applied inputs. Native additionally
allows replacement only while guidance remains buffered, locking it before
asynchronous attachment preparation starts.

The runner commits the changed projection and an immutable
`input-edit:<request UUID>` receipt together. The host validates the receipt
against the original authorized request and uses an attached-DB transaction
(both host journals use `DELETE` mode) to commit the receipt and inbound text
together. The ordinary inbound update trigger journals the changed text back
to the runner. This avoids falsely acknowledging a save across either
edit-versus-consume races or a host crash between two independent DB writes.
Search and scoped websocket input-state frames are refreshed after projection.

HTTP success means the receipt has committed, not merely that a request was
sent. A five-second timeout reports `edit_pending`; the UI retains its draft
and request UUID and retries that same command rather than submitting another.
A timed-out command can still be applied on reconnect. Different outstanding
edits to one input are rejected until the first has a receipt. Receipt replay
never reverts a later edit. System edit commands are never model input, history
bubbles, or a reason to wake a cold container.

## Pending web-input cancellation

Native advertises `supportsInputCancellation` independently of editing. The
viewer can cancel their own unconsumed web input with
`DELETE /ui/chat/api/groups/:group/chat/:thread/messages/:message`, passing
`{ "requestId": "<UUID>" }` and the same conversation scope as editing.
New requests require the connected, running native turn; older runners do not
advertise the capability. Cancellation affects only the selected input, never
the active reply. Already claimed input and steering whose attachment preparation
has begun return a conflict.

The host journals a non-triggering `cancel-<UUID>` system command with
`action: "cancel_input"` and a target message ID. The runner handles edit and
cancel commands together, in sequence, before claiming model input. It removes
buffered native guidance synchronously with `cancelSteering` and commits the
completed target, a `cancelled` input disposition, and an immutable
`input-cancel:<UUID>` receipt. Cancellation does not allocate a consumption
position. The host validates the original authorized request and atomically
projects the receipt plus the target's completed status and cancellation marker.
Retained message/receipt rows prevent replay or retry from reviving canceled
input; this is not a content-purge operation.

History and search omit canceled messages, and forks neither copy them nor
accept them as anchors. Scoped live input-state frames and websocket history
snapshots carry an empty-text `cancelled` tombstone so other open tabs, including
tabs reconnecting after a missed cancellation, remove the same bubble. The composer
is used for text edits; cancellation is a separate bubble action. A successful
HTTP response means durable confirmation. A five-second timeout returns
`cancel_pending`, retaining the same request UUID for retry. Different outstanding
edit/cancel commands for one message are serialized. Consumed inputs cannot be
retracted by cancellation; use Stop to interrupt the current turn instead.

## Lifecycle

The host creates the listener before spawning a container and before adopting
a container that survived a host restart. The runner reconnects with bounded
exponential backoff. Container exit closes the listener; graceful host shutdown
closes all listeners. A host restart recreates each socket path and an adopted
runner replays its current live snapshot. Containers carry a
`nanoclaw-session-link=v3` label; startup stops rather than adopts a live
container with a missing or incompatible link version. Version 3 containers
mount only their writable projection directory (`runner-state/`, containing
`runner-state.db` and its rollback journal), a read-only inbox, a writable
outbox, and provider-specific state directories.

### Coordinated host/runner rollout

Runner source is bind-mounted at `/app/src`, not baked into the image. Newly
started containers therefore load worktree edits immediately, even before a
commit or an explicit deployment. The host, however, keeps its loaded compiled
code until restarted. Develop in a separate checkout or coordinate both sides
of a rollout; leaving a running old host against edited runner source is not an
isolated staging environment.

The Stop extension (`turn.state` / `turn.stop`) requires a matching host and
runner. An older host rejects the new live frame even though both use the `v3`
label. This can leave input pending while containers repeatedly connect and
exit before processing it. Rebuild and restart the host with the matching code;
the pending input is retained and the normal wake path resumes it. Do not
resubmit or delete session data to recover from this mismatch.

The native steering capability similarly requires a host that recognizes the
optional `supportsSteering` field on `turn.state`. Deploy matching host, runner,
and chat assets together. There is no host-message schema migration: steering
intent uses the existing inbound content journal, and dispositions use the
existing durable session-state projection.

Pending editing adds the optional `supportsInputEditing` live field and the
`input-edit:` receipt semantics. Update the host before recycling runners and
serving the rebuilt editing UI; old runners do not advertise the editing
capability and must not receive edit requests.

Verify a rollout with host health **and** an actual session exchange; a
successful build or an HTTP 200 alone does not prove runner compatibility.

## Trust model

The runner is untrusted. Socket possession identifies only the session
capability; it does not authorize runner payloads or let a frame select another
session. The host derives session and group identity from the listener,
validates all runner fields, applies resource caps, and never treats
runner-reported usage as trusted billing evidence. Host events are also
schema-validated by the runner so a host bug cannot partially corrupt its local
projection; only the host can remove a rejected durable event.
