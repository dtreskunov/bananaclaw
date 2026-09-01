# Runner session link

NanoClaw uses one host-created Unix-domain socket per active session for live
runner-to-host signals. Durable messages still use the two session SQLite
databases; the link replaces the former `.heartbeat`, `.activity`,
`.usage-progress`, and `.turn-ended` files.

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

Version 1 is newline-delimited JSON. Every frame contains `v: 1` and a closed
`type`. The host caps a frame at 16 KiB, accepts at most 256 frames per second,
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

Final activity and usage remain durable in `outbound.db` as `turn_activity` and
`turn_usage`. Replies, system actions, processing acknowledgements, provider
state, attachments, and inbound messages are outside this phase and continue
to use the existing session databases and directories.

## Lifecycle

The host creates the listener before spawning a container and before adopting
a container that survived a host restart. The runner reconnects with bounded
exponential backoff. Container exit closes the listener; graceful host shutdown
closes all listeners. A host restart recreates each socket path and an adopted
runner replays its current live snapshot. Containers carry a
`nanoclaw-session-link=v1` label; startup stops rather than adopts a live
container with a missing or incompatible link version.

## Trust model

The runner is untrusted. Socket possession identifies only the session
capability; it does not authorize the payload. The host derives session and
group identity from the listener, validates all fields, applies resource caps,
and never treats runner-reported usage as trusted billing evidence.
