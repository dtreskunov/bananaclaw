---
name: web-ui
requires_env: UI_ENABLED
description: >-
  Web UI access: how the user opens a browser to see their files, and how
  to send them a single-file download link instead of attaching bytes
  inline. Use when the user asks to "show me my files", "browse my files",
  "open the file browser", "see my files in a browser", "open this HTML",
  "download a file", "give me a link to my files", or when you want to send
  a specific file but inline attachment isn't a good fit (large file,
  channel that handles attachments poorly, sensitive/revocable, etc.).
---

# Web UI — File Browser + File Links

Two distinct primitives, both deliver via the user's DM:

| Tool | What it sends | When to use |
|------|---------------|-------------|
| `request_login_link` | Magic link → 30-day browser session to the whole file browser | User asks to browse / see their files / open the file browser |
| `mint_file_link` | Single-use short-TTL URL to one specific file | You want to send one file and inline attachment isn't a good fit |

Both are delivered by the **host** as a follow-up DM. Your own reply must
not try to include a URL (you don't have one) and must not ask the user to
send `/web-login`.

## When to attach a file vs. send a `mint_file_link`

Default: attach inline if the channel supports it and the file is small
and non-sensitive. Prefer `mint_file_link` when **any** of these is true:

- **Size** — file is larger than ~5 MB (email caps at 10–25 MB total;
  Slack 50 MB; SMS basically nothing).
- **Channel** — current channel doesn't carry attachments well (SMS,
  GitHub/Linear comments, X DMs).
- **Sensitivity** — file is private/credentialed and you want a revocable,
  audited download (single-use, 15-min TTL by default).
- **Context** — file is one of many and the recipient might want the
  folder view; offer the file link plus a `request_login_link` for the
  browser.
- **Freshness** — the file will keep changing and you want them to see
  the current version on download, not a snapshot in their inbox.

When attaching inline still wins:

- Small (< 5 MB), non-sensitive, recipient is on email/Slack/Telegram and
  benefits from having it archived in their inbox.
- Recipient may be offline when they read it.
- One-shot, ephemeral.

## Calling `mint_file_link`

```
mint_file_link(
  userId: "resend:user@example.com",     // recipient's namespaced id
  path:   "reports/q3.pdf",              // relative to the agent group workspace
  ttlMinutes: 15,                        // optional, default 15, max 1440
  uses:       1                          // optional, default 1, max 5
)
```

The host will:
1. Verify the recipient has access to this agent group (member / admin /
   owner). If not, the link is silently refused.
2. Verify the file exists and isn't hidden or admin-tier-without-admin.
3. Mint a file-bound token (the token is NOT a login — it only downloads
   this one file, and does not create a browser session).
4. DM the URL to the user. In a group chat, the link lands in their DM
   and is never visible to other group members.

A reasonable reply when you've called `mint_file_link` in a group:

> I've sent you a download link in a direct message.

Don't name the file in the public reply — that itself can be a small
information leak in a group setting.

## Calling `request_login_link`

```
request_login_link(userId: "resend:user@example.com")
```

Use when the user asks to browse or see "my files" generally. Same DM
delivery, same group-safe behavior. The link mints a 30-day browser
session for the private file browser.

A reasonable reply (in a group or DM):

> I've sent you a one-time login link in a direct message. It's valid for
> 10 minutes and gives you a 30-day browser session to the private file
> browser for this agent group.

## What they can do once logged in (browser session)

- Browse the filesystem of every agent group they have access to
  (membership, admin role, or ownership)
- Preview images, audio, video, PDFs, text, and HTML files inline in the browser
- Download anything else
- Open member-visible HTML as an isolated private application. Run
  `/private-web` when building one.

The trusted file browser and an HTML application's private origin are separate
surfaces. Trusted browser controls are role-gated. A private HTML application
can read member-visible workspace files and conditionally replace existing
member-visible regular files with ETag-protected `PUT`; it cannot create,
delete, rename, or access hidden/admin-tier files. Browser writes do not wake
you or send a chat message.

## Visibility rules (so you can answer "why don't I see X?")

- `.git`, `node_modules`, `.claude-fragments`, dotfiles, and the composed
  `CLAUDE.md` are always hidden.
- `CLAUDE.local.md` is visible read-only.
- Admin-tier files (`container.json`, `bot.json`, `allowed-senders.txt`)
  are visible only to users with the admin role on that group, and
  `mint_file_link` refuses to issue them to non-admins.

## When NOT to use this skill

- The user wants you to read, summarize, or modify a file — just do that
  yourself using your filesystem tools.
