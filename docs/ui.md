# Web UI

Optional read-only web UI mounted on the existing webhook HTTP server under `/ui`. A shared auth shell (`/ui/auth/*`) hands out a single bearer-cookie that's reused by every UI app. Today the only app is the **chat** app at `/ui/chat`; more apps will live alongside it.

### Conversation protocol

The chat client uses versioned atomic conversation snapshots/updates, with
explicit turn identity and durable settlement. Host, runners, session stores
and browser assets must match; there is no old-client compatibility path.
Reload cached clients after a deployment. Going back to the pre-turn protocol
is a snapshot restore: see [downgrade-to-v3.md](downgrade-to-v3.md).

Missed frames, unknown streams, and revision gaps require an actual authorized
resnapshot. Disconnect or confirmed runner exit disables controls, but never
fabricates a final response, completion time, or billing record. Silent turns
remain visible without synthetic output. At the same host revision, reducing
incremental frames yields the same conversation as a fresh snapshot.

> Per-agent-group **public static websites** (served by `Host` on the same
> listener) are documented separately in [pages.md](pages.md).

## Enable

Set in `.env`:

```bash
UI_ENABLED=true
```

Restart the host. The routes are mounted on the webhook listener (default `0.0.0.0:3000`).

## Configuration

| Env var       | Default                               | Purpose                                                                                                                                        |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `UI_ENABLED`  | `false`                               | Mount the UI shell and every registered app.                                                                                                   |
| `UI_SECURE`   | `false`                               | Mark session cookies `Secure`. Set when fronted by HTTPS (reverse proxy, ngrok, etc.).                                                         |
| `UI_BASE_URL` | `http://localhost:${WEBHOOK_PORT}/ui` | External base URL embedded in magic-link URLs. Override when the host is behind a reverse proxy or tunnel (e.g. `https://bot.example.com/ui`). |

## Getting a login link

**From chat (self-service)** — any user wired to the bot can DM:

```
/web-login
```

The host intercepts the command (before it reaches the container) and replies with a one-time link. The link expires in 10 minutes and is consumed on first redeem. The resulting session cookie is valid for 30 days, `Path=/ui` so it covers every app.

**From the host (operator)**:

```bash
ncl users issue-link --user <userId>
# optionally --base-url <url> to override UI_BASE_URL for this call
```

`<userId>` is the user UUID from `users.id`. Look one up with `ncl users list`, or resolve from a channel handle via the `identities` table: `ncl exec 'SELECT user_id FROM identities WHERE channel=? AND handle=?' --args tg,6037840640`.

After redeem the browser lands on `/ui/chat/`. Log out via the button in the header (`POST /ui/auth/logout`).

## Apps

### Chat (`/ui/chat`)

In-browser chat + read-only browser for the per-agent-group filesystem at `groups/<folder>/`.

#### Appearance

In **My Profile / Settings → Appearance**, choose **Default** or **Autumn**,
and independently select **System**, **Light**, or **Dark** mode. Default /
System preserves the original appearance, including the black dark-mode
background. Autumn uses parchment and copper in light mode, and walnut and
amber in dark mode.

**Text density**, below Mode, offers **Comfortable** (larger text and more
breathing room) and **Compact** (smaller text and tighter spacing). Both use
locally bundled Figtree at weight 300 with 0.015em letter spacing. Compact is
the default and uses 15 px text with 1.3 line height while preserving the
tighter layout spacing. Comfortable uses 16 px text with 1.5 line height and
increases chat message gaps from 6 → 10 px, message padding from 6/10 → 10/14
px, and paragraph spacing from 8 → 12 px, alongside roomier spacing in lists,
menus, previews and settings. The selector includes a live sample message and
thread row. Markdown list items are separated by 4 px in Compact and 6 px in
Comfortable, without widening operational lists such as activity traces.
Density is independent of theme and mode, applies across the app, and does not
restyle embedded websites, PDFs or media. Pane widths, conversation width limits
and icons stay unchanged; existing touch targets never shrink and mobile text
inputs remain at least 16 px.

Changes apply immediately, including to the open settings dialog, and are
saved in this browser (`localStorage`, key `nanoclaw:appearance`, version 2).
Version-1 preferences migrate automatically, preserving theme and mode and
adding Compact density.
They synchronize across tabs on the same origin, not across devices or
accounts. System follows OS changes live; explicit Light / Dark overrides the
OS. Storage failures show an error while leaving the current in-memory
selection usable. Invalid saved preferences are diagnosed and cleared.
Themes affect application chrome, not embedded or user-authored websites.

Density changes preserve drafts and expanded panels. A conversation already
following the bottom stays there; otherwise the first visible message retains
its viewport offset through reflow (clamped if the content no longer overflows).
The change does not reveal scroll arrows or mark existing messages as new.
The appearance controller captures reading position before changing CSS and
restores it immediately and after composer autosizing; new scrolling cancels
the deferred restore. Density changes do not animate text or spacing.
Shared density tokens live in `global.css`, separately from theme colors.

Markdown messages containing tables use the full conversation width. Tables
retain readable, non-wrapping cells and scroll horizontally inside the message
when their intrinsic width exceeds the viewport. Tables throughout the UI share
the same subtle row and column borders, darker theme-aware header background,
and faint even-row stripe. A short fade marks each edge that has additional
horizontally scrolled content. Tables scroll horizontally by default;
exceptional fixed-layout tables can opt out with `data-table-scroll="off"`.
Non-standard transcript entries share a subtle inset provenance rail without
changing their geometry. Tool, file, card and question output uses an accent
rail; runner notices, internal traces and turn-system state use a neutral rail;
warning and failed turn state use semantic warning and error rails. Normal
agent replies have no rail. Runner-authored notices use the same background as
agent replies, but retain the neutral or semantic rail and omit a redundant
status label from the metadata row.
Turn-system bubbles carrying status span the full conversation column, and
their timing and model metadata stay on one line while flexible usage details
truncate. Trace-only turn-system bubbles remain content-sized.
Activity trace previews and expanded rows use the same small type scale as
status metadata so operational detail remains secondary to message content.
Tool row headers use distinct theme-aware colors for queued, running, completed,
and failed states. The activity schema supports queued (`pending`) tool rows,
although providers normally begin emitting them once execution is running.
Themes define the font family, body and heading weights, and UI letter
spacing through `--font-ui`, `--font-weight-body`,
`--font-weight-heading`, and `--letter-spacing-ui`. Density defines the
font-size scale and `--line-height-ui`, so typography can be tuned without
coupling the color theme to Compact or Comfortable spacing.

Theme values live in
[`default.css`](../src/ui/client/chat/src/styles/themes/default.css) and
[`autumn.css`](../src/ui/client/chat/src/styles/themes/autumn.css). Theme
metadata lives in [`appearance.ts`](../src/ui/client/chat/src/appearance.ts).
To add a theme, add its registry entry, import its CSS in `global.css`, and
define common typography/radii plus `[data-theme="<id>"][data-mode="light"]`
and `dark` token branches. Override all theme-sensitive values, including
surfaces, text, borders, solid actions and their foregrounds, selection
washes, focus rings, status colors, shadows and syntax highlighting. Keep
responsive layout and touch-target sizes shared. Check text contrast at 4.5:1
and essential control boundaries/focus indicators at 3:1.
The floating scroll controls are icon-only **Up** / **Down** arrows with an
end bar marking the top/bottom destination and
accessible labels. They share a bottom-right anchor, with Up 8 px above Down.
They appear only after the user scrolls in the corresponding
direction, and jump to the beginning/end of the conversation. Fade-in and
fade-out each take 500 ms (instantly with reduced motion). Reversing direction
immediately hides the previous arrow and fades in the matching one; reaching
the destination or 1 second without scrolling starts fade-out.
Fading controls immediately stop accepting input and leave the accessibility tree.
Automatic scrolling, streaming/layout changes,
search jumps and thread changes do not reveal arrows. The controls support
touch, mouse wheel, scrollbar dragging and keyboard scrolling.
Active gestures retain the last observed scroll position so coalesced input
and scroll events do not mask direction reversals.
Jumping up pauses bottom-follow, including the first animation frames; new
user input or returning to the bottom restores normal following. Up and Down
always use the same surface, border, shadow and icon styling, including when
new messages arrive.

The blocking `dist/appearance.js` script runs before the stylesheet in the
chat shell to prevent wrong-theme and wrong-density flashes. The main bundle reuses its
controller, and the service worker caches the bootstrap for offline loads.
Rebuild browser assets with `pnpm --dir src/ui/client/chat run build` after
editing theme definitions or appearance logic; the watch script watches both
the app and the bootstrap.

#### Conversation layout

Normal message bubbles use at most 90% of the conversation column. On desktop,
the column and composer share a 960 px maximum and the same centered gutters,
defined once by `--chat-max` / `--chat-gutter` in
[`ChatMain.css`](../src/ui/client/chat/src/components/ChatMain.css). Mobile keeps
its existing 90% bubbles and 12 px composer gutters.

#### Access and file browsing

**Access model.** A user sees an agent group if either:

- the user has an `owner` or `admin` role for the group (or globally), or
- the user is listed in `agent_group_members` for the group.

Web chat threads are shared by every user who can access the agent group. All
members can list, read, and send messages in every web thread; only owners and
admins (global or scoped to the group) can delete a thread. Human messages keep
their sender attribution in both history and live updates.

Historical normal human message bubbles include an icon-only **Edit** action for starting a new
branch with that message copied into the composer. It is not restricted to the
original author, so another participant with access to the agent group may use
it; the newly sent revision is attributed to the editor. The client branches
after the preceding conversational message so the original remains only in the
source thread. Editing the first message starts a blank web thread instead.
Historical attachments remain in the source thread and are not copied into the
composer. Read-only channel threads offer Edit only for that first-message
blank-thread case.

Your own pending native web-chat messages instead offer **Edit**
while the connected runner advertises input editing. This changes text in place,
preserving attachments, ordering, message identity, and steering/queue intent;
it uses the main composer without creating a branch. The composer shows a
checkmark save button and an explicit **Exit edit** action. Your unsent composer
text and attachments are parked and restored after save or exit. Attachment
changes, uploads, and recording are disabled during editing. Other authors' messages and
external-channel pending messages cannot be edited in place. Queued, steering,
processing, and applied inputs never offer historical branch-edit, including
applied steering after the response finishes.

Save waits for durable runner confirmation. Conflicts, consumed inputs, and
disconnects show an inline error and retain the draft even if its pending status
changes. **Retry save** reuses the request identity for the same text. If a save
is still pending or its outcome is unknown, the draft is locked until that
request is resolved: retry checks the existing request rather than starting
another edit. **Exit edit** restores the unsent composer draft and keeps the
pending edit draft available on reopening; it cannot withdraw a save already
submitted, which may still apply. Drafts and requests remain scoped to their
original conversation across navigation.

The bubble's **Cancel** action removes only your own queued or waiting-to-steer
input, and only when the connected native runner advertises cancellation.
It never stops the active response. Cancel waits for authoritative confirmation;
the ordered conversation update removes the bubble. Command HTTP replies do not
overwrite transcript data, so a delayed reply cannot revert a newer edit or
cancellation. An ambiguous response or
network failure leaves it visible with **Retry cancel**, reusing the same request
ID. Consumed-input conflicts keep the bubble visible. An unresolved edit blocks
cancel, and an unresolved cancel blocks edit, until the original request resolves.
Reconnect history replaces the visible web transcript, so a cancellation missed
while offline still removes its bubble. Redacted cancellation tombstones in
history and scoped sync are authoritative: their matching bubbles are removed,
while merging a snapshot does not discard unrelated absent optimistic inputs.
Confirmed cancellations also leave conversation-scoped client tombstones.
Duplicate versioned updates do not replay mutations.
Only the matching send acknowledgement is cleared; unrelated optimistic sends
and unsent composer drafts/attachments are retained.

Admin-tier files (`container.json`, `bot.json`, `allowed-senders.txt`) are visible only to admins. `.git`, `node_modules`, `.claude-fragments`, dotfiles, and the composed `CLAUDE.md` are always hidden. `CLAUDE.local.md` is visible read-only.

**Inline preview** in-browser:

- Images (`png`, `jpg`, `jpeg`, `gif`, `webp`)
- Audio (`mp3`, `m4a`, `aac`, `wav`, `ogg`, `opus`, `flac`)
- Video (`mp4`, `mov`, `webm`, `ogv`)
- PDFs
- Text (`.txt`, `.md`, `.json`, `.yaml`, `.log`, `.csv`, source code, etc.)

Everything else falls back to a download link.

### Steering a native response

Queued follow-ups appear as ordinary input bubbles at the bottom of the
conversation, below the active response and its Stop control. There is no
separate queue area: a subtle bubble footer shows status and **Edit** / **Cancel**
when available. They remain there through Stop until the runner consumes them.
At consumption each input moves into the transcript after the preceding
response and before its own response, once its durable position arrives.
A processing acknowledgement arriving before that position leaves it in the
bottom position with editing disabled. Durable logical positions preserve this
ordering on refresh, even when sent timestamps are identical; timestamp labels
still show the original send time. Older messages retain chronological ordering.
An initial idle message is not a follow-up merely because it briefly has queued
status. Waiting-to-steer input also appears at the bottom; applied steering
returns to its position in the current transcript.

Promoting an input preserves its attachments and pending editor: unsaved drafts,
in-flight saves, retry identities, and composer conflicts survive movement within
the conversation.

Sending text, dictation, or attachments while a native response is running in
the same web conversation offers **Steer current turn** (focused by default)
and **Queue for later**. Cancel, Escape, or dismissing the dialog keeps the
draft, files, and pinned context. Other providers keep their existing send
behavior. External-channel conversations do not show this choice; eligible
native inputs are steered automatically by the runner.

Both choices capture the active turn ID. If that turn finishes while the
dialog is open, steering becomes a follow-up rather than targeting a new
response. Shared sessions never steer a different conversation's response.
Capability comes from the running turn, not the group's saved provider setting.

Inbound bubbles show **Queued** with a distinct inset accent, **Waiting to
steer**, or **Applied to current turn**. Only a durable runner receipt confirms
application; an HTTP response or message echo does not. Queued/waiting captions
clear when processing starts, while applied provenance and explicit follow-up
outcomes remain in history. Receipts restore after reconnects and on external
conversation refreshes.

The web send endpoint accepts optional JSON `inputHandling: { mode:
"queue" | "steer", turnId?: string }`; multipart sends carry the same object as
a JSON-encoded `inputHandling` field. Steering requires a captured `turnId`.
The host validates send access and the matching live turn's capability, and
preserves stale targets for safe follow-up handling. A `clientMessageId` remains
stable across retries after ambiguous network/server failures.

### Stopping a response

The live activity ("thinking") bubble has a small square **Stop** icon at the
right end of its metadata footer, matching the branch button on completed
responses. It has no visible text; its tooltip and accessible label identify
the action. It remains available while the activity trace is collapsed and stops only that
response, including a response waiting on a tool. The composer, Send/Enter,
attachments, and dictation remain unchanged: you can still enqueue follow-ups.
Queued messages are not cancelled and run afterward.
Sending queued or steering input does not hide or retarget Stop: it remains
bound to the actual active response, even when the newest bubble is your input.
Steering accepted but not yet applied is preserved as a follow-up after Stop.
When the next queued response starts, Stop targets that new turn instead.

Question cards are not cancelled by Stop. They remain actionable, and submitting
an answer is ordinary new input (or a queued follow-up). You can stop the
resulting turn after answering. If the agent has finished asking a question and
is only waiting for your answer, there may be no active turn to stop.

The icon is disabled and grayed out while stopping, without adding transient
status text or changing the bubble's layout. A **Stopping response** tooltip
and accessible busy state remain until the runner settles the turn; HTTP
acceptance alone is not a completed stop. A disconnected runner or failed HTTP
request is shown explicitly, with a retry affordance. An accepted Stop waits for
the authoritative turn phase; elapsed time never declares success or failure.
Retries carry the same immutable turn ID, so a stale click cannot stop the next
response. Other open tabs and reconnects receive the current turn state.
Only users allowed to send in the conversation can stop it; a shared-session
turn running in a different thread or channel cannot be stopped from this view.

A stopped response leaves a durable history entry and its activity trace, even
if no assistant reply was sent. Completed and failed tool calls retain their
status; interrupted calls without a confirmed result are marked as having an
unknown outcome, not as successfully completed. Stopping does **not** undo
completed filesystem changes, messages, or external API effects. Provider
continuation is retained, and the stopped input is not automatically retried.
Already-submitted approval requests are separate workflows and are not revoked
by stopping the response.

Stopped responses retain elapsed time, the model when known, and any token usage
already reported. Counts are labeled **tokens reported** and may exclude an
unfinished model call; if no usage was reported, the footer says **Tokens
unavailable** instead of showing zero. Native model-call usage is captured before
waiting for tools to finish. This metadata is persisted for reloads, but cannot
be reconstructed for older stopped responses that never recorded it.

### Authoritative conversation synchronization

An active web conversation uses one versioned WebSocket subscription. Its first
snapshot includes messages, durable input dispositions, turns, current activity,
usage metadata, questions, runner connection state and permitted actions.
Subsequent envelopes update that view atomically. A final response is not rendered
until the host commits the matching turn's `settled` barrier. Platform typing
notifications are unrelated and cannot complete a browser turn.

Each logical turn has a stable timeline summary, keyed by turn ID. Steering,
queued input, multiple output messages, reconnects and settlement do not transfer
or erase its trace. Expansion state stays with that row. Silent, warning,
stopped, failed and interrupted turns remain visible even without a response.
Usage retains its accounting IDs and is displayed once per record, not once per
response; metadata explicitly distinguishes provisional, partial, final and
unavailable reports. Missing usage never becomes fabricated zero tokens.

Non-web conversations poll the same projector and replace their store using the
same validated snapshot reducer. Sidebar lists and global approvals keep their
existing ten-second polling. Web conversation questions are never overwritten by
that poll. Local composer drafts, uploads and command request IDs are separate
from the server store; HTTP acceptance does not prove a command took effect.

The browser validates `protocolVersion`, `streamId`, revisions and entity shapes.
Gaps or unknown streams show a synchronization error and reconnect for a fresh
snapshot; incompatible protocols explicitly ask for a page reload. Progress is
coalesced on the host with a bounded dirty flag. Slow consumers are closed rather
than building an unlimited queue. There is no durable browser replay/ACK log.
Every projection rechecks access and scopes channel, platform and thread, including
shared sessions and synthetic DM IDs. Off-route sends cannot reveal their originating
turn's trace; historical turns with an unknown origin expose only activity and
usage anchored to already-visible outputs.

**Deployment:** this client and host have no legacy frame support. Build
the checked-in bundle with `pnpm --dir src/ui/client/chat run build`, deploy host
and assets together, and reload open tabs. Verify that a reconnect starts with a
`snapshot` and subsequent changes are revisioned `update` envelopes. Do not mix
protocol versions; see [downgrade-to-v3.md](downgrade-to-v3.md) for rollback.
No deployment occurs during a build.

### Live voice input

The microphone starts live dictation directly into the composer. Speech appears
as revisable text; **silence never sends a message**. While listening, the
microphone becomes a stopwatch: press it to stop capture and finalize the text.
A spinner indicates finalization, then the microphone returns and the draft
can be edited normally. Press it again to dictate more at the cursor.
The existing Send button finalizes active dictation before submitting once.
There is no separate voice panel. Existing text and attachments are retained.
Pressing the connecting indicator cancels startup without changing the draft.

Voice works with every agent model and with question-card text answers. It is
separate from attaching an audio file for a model to hear. Browser speech
recognition and the old web `/voice/transcribe` upload endpoint are replaced by
streaming STT. Received audio files use the separate attachment behavior below.

The initial backend is ElevenLabs `scribe_v2_realtime`, accessed directly from
the **host** through AI SDK's experimental streaming transcription API. Use
Node **22 or newer**. Configure `ELEVENLABS_API_KEY` in the host's restricted
`.env` file or service environment. Never put the key in group files, container
configuration, or a browser build. The host reads the key explicitly and does
not pass it to agent containers. This is a host-only credential exception to
agent-side OneCLI routing; WebSocket STT does not go through OneCLI.

In Agent Settings, voice input has a separate enable toggle and a **Voice input
backend** selector for the server default or ElevenLabs. The database stores
`voice_input_enabled` separately from the nullable `voice_input_backend`;
`NULL` selects the server default, and backend IDs are not restricted by a
database provider whitelist. The host checks whether a backend is supported.
The server default is ElevenLabs; set `DEFAULT_VOICE_INPUT_BACKEND=disabled`
to disable inherited voice input by default. A missing key, unsupported backend,
or invalid server default shows an unavailable status rather than falling back
to another provider. Voice setting changes affect the next voice session and
do not restart agents.
When voice input is not ready, the disabled microphone shows
"Live voice input is not configured" as a tooltip instead of an inline notice;
Agent Settings retains the detailed availability reason.

Microphone capture requires HTTPS (or localhost) and browser permission. Set
`UI_BASE_URL` to the actual external UI URL: the voice WebSocket checks the
browser Origin against it. Reverse proxies must forward WebSocket upgrades.
The browser captures at its native audio rate; the audio worklet resamples to
16 kHz mono PCM before sending over an authenticated, group-authorized
connection. Limits are one active session per user, eight globally, five
minutes per capture, and bounded audio queues. Stopping and starting dictation
creates a fresh stream. After an explicit Stop or Send, a clean provider stream
ending can finalize the latest provisional text even without a provider final
event. The same recovery applies to an SDK empty-transcript error when
provisional text exists. Revisions retain their segment IDs rather than being
appended again. Recovery is logged with a segment count, never transcript text.
Other provider failures, a stream ending before Stop/Send, cancellation, and a
ten-second finalization timeout do not promote provisional text or submit it.
Silent audio and unrecognized speech have distinct error messages.

Hiding the page or leaving a conversation releases the microphone. Provider
errors, disconnects, and quota exhaustion preserve recovered, editable text and
show an error but cancel automatic submission; review the text before pressing
Send again or starting another dictation.
No automatic paid fallback is configured. Provider free allowances and
spending settings are managed in the ElevenLabs account, not guaranteed by the
application.

Audio and provisional transcripts are not persisted by the host. Audio is sent
to ElevenLabs; only submitted text enters the chat journal. The request disables
provider logging where supported; provider retention and account terms still
apply. Spoken editing commands and assistant speech playback are not included.

### Audio attachments and channel voice messages

Audio received through WhatsApp, Telegram, other channels, or web file uploads
is an ordinary attachment. The **+ > Record audio attachment** action is
available whenever the browser supports microphone capture, independently of
the selected model and live dictation settings.

There is no automatic file transcription or hidden STT fallback. The original
file is saved in the workspace and its name, MIME type, and path are included
in the prompt. Providers embed audio only when model capabilities, their
transport, and the file format support it. Otherwise the agent receives the
file reference and can use its available tools; it is not told that the audio
was transcribed.

The native provider requires a known audio-input model over OpenAI-compatible
Chat before inspecting any audio. `NATIVE_BASE_URL` overrides the endpoint
address, not the canonical model's catalog capabilities. Unknown custom models
remain unknown; catalog outages produce a diagnostic and leave custom endpoints
usable with unknown capabilities (catalog retries back off for one minute).
Explicit endpoints retain their independently selected `NATIVE_PROTOCOL`
(OpenAI-compatible Chat by default).

Eligible audio is inspected by `ffprobe`, not trusted solely by its declared
MIME type or extension. Compatible MP3 and PCM WAV can be embedded directly;
common voice-note formats such as OGG/Opus, WebM, M4A/AAC, and FLAC are normalized
to MP3 with `ffmpeg`. The original file is never replaced. Conversions are not
cached; temporary preparation files are cleaned up immediately afterward.
See [audio preparation limits](build-and-runtime.md#audio-attachment-preparation).

Unknown or text-only model capabilities, unsupported adapters, invalid media,
and processing limits or failures retain the original file reference, with an
explicit reason in the model prompt and runner logs. Anthropic Messages,
OpenCode's current file-part adapter and Claude do not embed native audio.
These agents can still access the original file through their tools. Catalog
audio support does **not** promise every endpoint accepts every audio format;
provider rejection is surfaced rather than retried with a different attachment
representation. Live dictation, attachment controls, and Agent Settings are
unchanged by this preparation.

**Upgrade behavior change:** channel voice notes sent to text-only models no
longer get automatically transcribed. `DEFAULT_TRANSCRIPTION_MODEL` is ignored
and can be removed from the host environment; `transcription_model` and
`voice_mode` are removed by a new database migration. Historical migrations
remain unchanged. The live web dictation backend and enable flag are preserved.
Legacy transcription settings are not converted to dictation settings.

Rebuild the host and chat UI, then restart the host and affected agent
containers to pick up this simplification. Runner source is bind-mounted, so
this source-only change does not require rebuilding per-group images.
Idle containers restarted through `ncl groups restart` start fresh on the next
message. Back up the database before
upgrading if rollback to the legacy schema is needed; the removal migration
does not preserve the retired settings.

### Feedback notifications

Error toasts across the UI remain visible until explicitly dismissed. Their text
can be selected and copied, long messages wrap and scroll, and each has a
keyboard-accessible **Dismiss** button. Later notifications queue behind an
unread error rather than replacing it. Success messages still auto-dismiss;
action prompts (such as a new-version reload) remain clickable and persistent.

If a catalog skill fails to install, the error includes Git's diagnostic when
available. `Repository not found` during a catalog add or refresh means the
upstream is unavailable to the host; it does not invalidate an existing snapshot.

### Catalog snapshots and skill installation

Catalogs are cached under `data/skills/cache/<catalog-id>`. Installs use that local
Git snapshot, not a fresh clone of the upstream. The UI sends the displayed commit
with the install request; if the cache has changed, installation stops with a
request to reload and review the catalog rather than silently using another
revision. Directory results that have not yet been cached are cloned once when
added; expanded previews reuse their existing snapshot when added.

Each group receives an independent sparse checkout at
`groups/<folder>/skills/.catalogs/<catalog-id>@<commit>`, with relative skill
symlinks into it. The checkout's `origin` remains the original repository URL,
but no Git objects are borrowed from the browsing cache: removing or refreshing
that cache cannot break installed skills. Installing another revision does not
update existing skills. Local edits and commits are preserved; if a checkout
cannot safely supply the requested skill, a separate suffixed checkout is used.
Legacy `.catalogs/<catalog-id>` checkouts continue to work unchanged.

Installing a cached skill does not require the upstream repository to exist.
Existing security-audit checks and acknowledgements still apply. Catalog refresh
and updating an agent's installed skills remain separate operations.

### Refreshing catalogs

Owners and global admins can **Refresh** a registered catalog from either its
catalog card or its directory-search result. Both show **Last successful refresh**: the
last successful upstream check, with an exact timestamp on hover. Older preview
snapshots without a recorded fetch time show **Not recorded**. Installing a skill
does not change this timestamp.

Refresh is manual; browsing does not trigger a network refresh. While a refresh
is running, its controls show progress and repeated requests for that catalog
join the same operation. Other catalogs remain usable. Git network operations
run asynchronously so they do not block host routing or other UI requests.

The host prepares a separate checkout, fetches the configured branch, and validates
the catalog before publishing its tree and metadata together. A failed fetch or
validation preserves the previous cache, commit, and successful timestamp. The
latest failure and attempt time are retained and displayed, and cached skills
remain installable. Publication errors roll back the previous tree; an unsuccessful
rollback preserves staging files and logs their location for operator recovery.
Removing a catalog during its refresh is refused.

Successful refreshes update the timestamp even when the commit has not changed,
clear the previous failure, and invalidate the displayed catalog and directory
previews so subsequent installs use the newly displayed commit. Refresh never
updates agent checkouts or discards agent edits.

### Updating installed skills

Owners and global admins have an **Update** button beside each catalog-installed
skill. It uses the current local catalog snapshot; it does not fetch upstream.
Use **Refresh** separately when a newer catalog revision is wanted. Built-in
and agent-authored skills have no catalog update action.

Update prepares and validates the target revision before atomically switching
only that skill's link. Other installed skills and the old checkout remain
untouched. Updating to the already-installed revision is a no-op. Local edits
or commits, missing sources, invalid snapshots, and blocking security audits
stop the update with an error instead of replacing the current skill. There is
no review or confirmation flow and no automatic restart.

Skill updates and catalog refreshes show button progress and updated revision
metadata without success notifications. Failures remain visible. Enabled flags
and unsaved settings are preserved; restart the agent to pick up updated skills.

## Security posture

- Magic-link tokens and session tokens are 256-bit random; only their sha256 hashes are stored.
- Cookie is HttpOnly, `SameSite=Lax`, `Path=/ui`, optionally `Secure`.
- Path traversal and symlink escapes are blocked (`resolveSafe` runs `realpath` + containment).
- Read-only: no upload, rename, delete, or edit endpoints.
- Access is logged to the `ui_access_log` table.

The mount is reachable on whatever interface the webhook server binds (default `0.0.0.0`). If your webhook port is exposed to the public internet, the UI is too — auth is strong, but treat the URL as sensitive. Put it behind a reverse proxy with TLS for non-LAN use, and set `UI_SECURE=true`.

## Tables

Migration `016-ui` creates:

- `ui_sessions` (cookie sessions, shared across apps)
- `ui_magic_links` (single-use login tokens)
- `ui_access_log` (audit trail)

All three are pruned hourly by the in-process purge timer.
