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
