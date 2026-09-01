# Runner session link

NanoClaw uses one host-created Unix-domain socket per active session for all
runner-to-host state. Live signals are best-effort; durable mutations are
journaled locally and acknowledged only after the host commits them.

## Capability boundary

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

Version 2 is newline-delimited JSON. Every frame contains `v: 2` and a closed
`type`. Live frames are capped at 16 KiB; durable frames are bounded by the
configured output cap plus envelope overhead. Each session is limited to 256
frames and 24 MiB per second,
accepts at most 32 connection attempts per second, allows one live connection
per session, closes on malformed input, and validates
each payload before updating memory. The frame budget belongs to the session,
not the connection, so reconnecting cannot reset it.

Supported runner signals:

- `heartbeat`
- `activity.clear` and `activity`
- `usage.clear` and `usage`
- `turn.resume` and `turn.end`

Activity is capped at 128 current steps and text fields are bounded. Usage
numbers must be finite and non-negative. Live state is best-effort: the runner
keeps its current snapshot in memory and replays it after reconnect, but the
socket does not acknowledge or journal these signals.

Durable frames carry an event ID, journal sequence, type, and validated payload.
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

`turn.persisted` wakes final response delivery after usage, checkpoints, and
activity have landed. Tool-origin and system messages can wake delivery
immediately. `batch.persisted` follows each fully persisted logical result and
wakes processing reconciliation only after its task attempts and completion
acknowledgements are final. This boundary does not wait for a warm provider query
to close. A 60-second host scan recovers messages committed immediately before a
host crash; routine one-second outbound polling is gone.

`inbound.db` remains host-to-runner transport and is still polled. Attachments
remain in the session `inbox/` and `outbox/` directories.

## Lifecycle

The host creates the listener before spawning a container and before adopting
a container that survived a host restart. The runner reconnects with bounded
exponential backoff. Container exit closes the listener; graceful host shutdown
closes all listeners. A host restart recreates each socket path and an adopted
runner replays its current live snapshot. Containers carry a
`nanoclaw-session-link=v2` label; startup stops rather than adopts a live
container with a missing or incompatible link version. Version 2 containers
mount host `outbound.db` read-only and keep their writable projection and event
journal in `runner-state.db`.

## Trust model

The runner is untrusted. Socket possession identifies only the session
capability; it does not authorize the payload. The host derives session and
group identity from the listener, validates all fields, applies resource caps,
and never treats runner-reported usage as trusted billing evidence.
