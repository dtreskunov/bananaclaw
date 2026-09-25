# Web UI

Optional read-only web UI mounted on the existing webhook HTTP server under `/ui`. A shared auth shell (`/ui/auth/*`) hands out a single bearer-cookie that's reused by every UI app. Today the only app is the **chat** app at `/ui/chat`; more apps will live alongside it.

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

**Access model.** A user sees an agent group if either:

- the user has an `owner` or `admin` role for the group (or globally), or
- the user is listed in `agent_group_members` for the group.

Web chat threads are shared by every user who can access the agent group. All
members can list, read, and send messages in every web thread; only owners and
admins (global or scoped to the group) can delete a thread. Human messages keep
their sender attribution in both history and live updates.

Admin-tier files (`container.json`, `bot.json`, `allowed-senders.txt`) are visible only to admins. `.git`, `node_modules`, `.claude-fragments`, dotfiles, and the composed `CLAUDE.md` are always hidden. `CLAUDE.local.md` is visible read-only.

**Inline preview** in-browser:

- Images (`png`, `jpg`, `jpeg`, `gif`, `webp`)
- Audio (`mp3`, `m4a`, `aac`, `wav`, `ogg`, `opus`, `flac`)
- Video (`mp4`, `mov`, `webm`, `ogv`)
- PDFs
- Text (`.txt`, `.md`, `.json`, `.yaml`, `.log`, `.csv`, source code, etc.)

Everything else falls back to a download link.

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
The host accepts 16 kHz mono PCM over an authenticated, group-authorized
connection. Limits are one active session per user, eight globally, five
minutes per capture, and bounded audio queues. Stopping and starting dictation
creates a fresh stream. Finalization times out after ten seconds instead of sending incomplete
text.

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
