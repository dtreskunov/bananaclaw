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

| Env var | Default | Purpose |
|---|---|---|
| `UI_ENABLED` | `false` | Mount the UI shell and every registered app. |
| `UI_SECURE` | `false` | Mark session cookies `Secure`. Set when fronted by HTTPS (reverse proxy, ngrok, etc.). |
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
