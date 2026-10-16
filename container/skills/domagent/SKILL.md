---
name: domagent
description: Work in the user's real browser through DomAgent v6 sessions (approved native tab groups), including background tabs, human help and bulk data extraction through artifacts. Pair by a code the user reads from their DomAgent window.
---

# DomAgent v6 browser sessions

DomAgent is independent of BananaClaw and OneCLI. Service 6.1.0-beta.5 /
extension 6.1.3 / wire v6. Artifacts need extension 6.1.0 and closing tabs needs
6.1.3; an older one answers
`CAPABILITY_UNAVAILABLE` with `required_extension_version`: ask the user to
update the extension. The user runs a small DomAgent window in their
browser; while it is open you can ask to open **sessions**. A session is a
native tab group the user approves, and every tab in that group is in scope.

## MCP configuration

Endpoint: `https://<server>/mcp/<agent-id>` with `Authorization: Bearer <key>`,
injected by the vault for exactly that host and path. This group's entry is
`domagent` → `https://domagent.adsoconsulting.org/mcp/bananaclawz`. Keep the
600000 ms MCP timeout: pairing, session approval and help requests wait for a
person (use `timeout_seconds` ≤ 540). **Never request, echo or store the raw
key.** The operator generates keys with `admin.js agent-key`; a pairing code is
not a credential.

## Pairing a browser (once per browser)

1. Call `list_browsers()`. If the browser you need is listed, skip pairing.
2. Otherwise ask the user to click the DomAgent toolbar button, then **Pair an
   agent**, and tell you the 8-character code (for example `K7MP-4QTX`). It
   expires in five minutes.
3. Call `pair_browser({code})`. The user clicks **Approve** in their window; you
   get `browser_id`. `PAIRING_UNAVAILABLE` means expired or wrong: ask for a new
   code. `ACTION_DECLINED`: respect it.

## Sessions

- `list_browsers()` shows `online`, `last_seen` and `paired_at`. Offline means
  the user's DomAgent window is closed: ask them to open it, or use another
  online browser.
- Reinstalling the extension creates a new browser; the new one is renamed
  `name (2)` if you already have one with that name. Remove the long-offline
  duplicate with `unpair_browser({browser_id})` (only your own pairing; ends
  your sessions there). Browsers offline for 30 days are removed automatically.
- `request_session({browser_id, purpose, urls?, title?})`: plain-language
  purpose, up to 8 starting URLs. Fails immediately with `BROWSER_OFFLINE` when
  offline. The user approves or declines in their window and gets a system
  notification. On approval you receive `session_id` and `tabs` with `tab_id`s.
  Tabs open in the background; never ask the user to switch tabs for you.
- `list_sessions()` → `attached` or `detached`. Detached means the window is
  closed, or after a Chrome restart the user still has to confirm the reattach.
  Sessions come back by themselves when the window reopens. Reuse an existing
  attached session for the same task instead of requesting a new one.
- A session ends when the user closes or ungroups its tab group
  (`SESSION_ENDED`, `NOT_FOUND`). Don't re-request unprompted; ask.
- `end_session({session_id})` when done: tabs are ungrouped and stay open.
  This is the default; ending a session can't be undone, so request a new one
  for later work.
- **Closing tabs always asks the user.** Tabs may hold unsaved work or evidence,
  so prefer leaving them open. Only for scratch pages you opened, call
  `end_session({session_id, close_tabs: true, description})` or
  `close_tab({tab_id, description})`. `description` says why, in plain
  language. The user gets a notification and chooses **Close** or **Keep open**
  in their window; the call waits (`timeout_seconds`, default 300, ≤ 540).
  `ACTION_DECLINED` (or a timeout): the tabs stay open. Accept that, continue,
  and don't ask again. The browser must be online.
- `list_tabs({session_id})`: all tabs in the group, including ones the user
  dragged in or a site opened. `create_tab({session_id, url?, description})`
  adds a background tab (max 8). `close_tab` (above) closes one
  tab after approval; closing the last tab ends the session
  (`session_ended: true`). `TAB_NOT_IN_SESSION` means the tab was closed or the
  user removed it.
- `report_progress({session_id, message})` posts a short update to the user's
  activity feed. Use it for milestones, not every step.

## Page tools

Every page tool takes `tab_id` and a 40–500 character `description` the user
sees in their activity feed: say what and why, without secrets.

Start with a focused `get_page_snapshot`. Defaults are 4000 characters, 50
elements and 16 KiB (hard limit 64 KiB). Interactive elements are kept first
when truncated and decorative/SVG noise is dropped; still check truncation and
narrow with `selector`. Input is DOM-based, not native keystrokes. `navigate`
works from blank or browser pages. Protected origins (the DomAgent server, the
identity provider) are blocked with `HANDOFF_REQUIRED`.

- **Refs belong to one snapshot of one document.** Act with `ref` + `document`
  from the latest snapshot. After any click that may navigate, open a menu or
  re-render, take a new snapshot before the next action.
- **Never guess URLs.** Link rows carry `href`: `navigate` to that exact value.
- **"loaded" is not success.** `wait_for_page` "loaded" only means the document
  is ready; a 404 or sign-in page loads too. Pass `content_selector` for the
  content you expect and check the snapshot title/URL before going on.

`evaluate_script` takes a script whose final expression is the result.
Top-level `await` and `return` work, so no IIFE is needed. Each call must
finish within 25 s. The default `MAIN` world sees page globals and framework
state; `USER_SCRIPT` needs native support. Return focused JSON only. CSP can
refuse scripts; never switch worlds and retry a possibly-mutating script.

Call site APIs **from inside the page** (`evaluate_script` with
`fetch(url, {credentials: 'include'})`), reusing the headers the site's own
requests send. Requests from your container have no cookies and get 401/403.

Errors are JSON with `error` (the code) and usually a `hint`: read it before
retrying. `INVALID_ARGUMENTS` lists each bad key with `did_you_mean`. Script
errors give `line`, `column` and `snippet`; fix that line. `RESULT_TOO_LARGE`
gives `actual_bytes`/`limit_bytes`: switch to an artifact (below).
`DOCUMENT_NOT_CONTROLLABLE` means the tab is blank, browser-owned or restored
lazily: `navigate` it. `TARGET_STALE`/`ELEMENT_STALE` carry a `stale_reason`
(`document_changed`, `ref_superseded`, `element_detached`): take a new snapshot.
**`OUTCOME_UNKNOWN` → a mutation may have happened: inspect, never blindly
retry.** `BROWSER_OFFLINE` → the window closed mid-task; tell the user.

## Bulk data: artifacts

Never move more than ~10 KB of page data through the conversation: it's slow,
costly and silently corrupts. Collect it in one script and store it on the
DomAgent service instead:

1. Write one `evaluate_script` that gathers everything (loop the site's paged
   API with `await` inside the script) and ends with the array or object. Pass
   `return_as: "artifact"` and `artifact_name: "activities.json"`.
2. The result is a handle: `artifact` (`artifact_id`, `bytes`, `sha256`, `mime`,
   `download_url`), a `shape` summary (type, length, item keys) and a short
   `preview`. Check `shape` before going on.
3. Download it to a file, with **no** Authorization header (the vault adds it,
   just as for MCP), and verify the checksum:

   ```bash
   curl -fsS "$DOWNLOAD_URL" -o /workspace/agent/activities.json
   sha256sum /workspace/agent/activities.json   # must equal artifact.sha256
   ```

   Then process the file locally (`python3`, `bun`).

4. Use `read_artifact({artifact_id, offset?, max_bytes?})` only for a quick
   look or when the download fails. `list_artifacts()` shows what you stored.

An artifact is at most ~8 MiB, and a script must finish within 25 s. Split
bigger jobs (by date range or page block) into several artifacts and merge them
locally. Artifacts expire after 24 hours; each agent keeps 100 or 64 MiB, and
the oldest are evicted first. Binary data: return a base64 string with
`artifact_encoding: "base64"` and a matching `artifact_mime`.

## Human help

Use `request_handoff({tab_id, instructions})` for logins,
CAPTCHAs, payments or review. When a page shows a sign-in form or SSO redirect,
call it right away instead of asking in chat. Never type or read passwords or ask for
credentials. The user gets a notification, the tab group flashes, and they click
**Done** or **Cancel** in the DomAgent window. Only that tab waits; others can
keep working. `ACTION_DECLINED` means they cancelled.

## Boundaries

Sessions use the user's real logins and cookies. Scripts can read private data
and act on accounts, and ending a session can't undo requests already made.
Use disposable fixtures for tests and never mutate real accounts to prove a
capability.
