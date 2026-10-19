---
name: bananabrowse
description: Work in the user's real browser through BananaBrowse sessions (approved native tab groups). Use for pairing, background-tab browsing, read-only selector probes, structured DOM extraction with query_all, human help and bulk artifact downloads.
---

# BananaBrowse browser sessions

BananaBrowse (formerly DomAgent) is independent of BananaClaw and OneCLI.
Use the live MCP instructions, tool schemas and tab capabilities as the
authority for available features. `CAPABILITY_UNAVAILABLE` can mean a missing
browser capability or an extension update requirement; check the error details,
including `required_extension_version`, before asking the user to update.
The user runs a small BananaBrowse window in their
browser; while it is open you can ask to open **sessions**. A session is a
native tab group the user approves, and every tab in that group is in scope.

## MCP configuration

Endpoint: `https://<server>/mcp/<agent-id>` with `Authorization: Bearer <key>`,
injected by the vault for exactly that host and path. This group's entry is
`bananabrowse` → `https://domagent.adsoconsulting.org/mcp/bananaclawz`. Keep the
600000 ms MCP timeout: pairing, session approval and help requests wait for a
person (use `timeout_seconds` ≤ 540). **Never request, echo or store the raw
key.** The operator generates keys with `admin.js agent-key`; a pairing code is
not a credential.

## Pairing a browser (once per browser)

1. Call `list_browsers()`. If the browser you need is listed, skip pairing.
2. Otherwise ask the user to click the BananaBrowse toolbar button, then **Pair an
   agent**, and tell you the 8-character code (for example `K7MP-4QTX`). It
   expires in five minutes.
3. Call `pair_browser({code})`. The user clicks **Approve** in their window; you
   get `browser_id`. `PAIRING_UNAVAILABLE` means expired or wrong: ask for a new
   code. `ACTION_DECLINED`: respect it.

## Sessions

- First check `list_sessions()` and reuse an appropriate attached session for
  the task. `request_session` always requests a new group; it does not reuse one.
- `list_browsers()` shows `online`, `last_seen` and `paired_at`. Online is a
  point-in-time connection check, not a reservation. Offline can mean a closed
  window, a reconnect or a network problem; do not assume the user closed it.
- Reinstalling the extension creates a new browser; the new one is renamed
  `name (2)` if you already have one with that name. Remove the long-offline
  duplicate with `unpair_browser({browser_id})` (only your own pairing; ends
  your sessions there). Browsers offline for 30 days are removed automatically.
- `request_session({browser_id, purpose, urls?, title?})`: plain-language
  purpose, up to 8 starting URLs. `BROWSER_OFFLINE` means no live connection is
  available. Check `list_sessions` before retrying a failed request: an approved
  session may already exist. The user approves or declines in their window and gets a system
  notification. On approval you receive `session_id` and `tabs` with `tab_id`s.
  Tabs open in the background; never ask the user to switch tabs for you.
- `list_sessions()` → `attached` or `detached`. Detached can mean the connection
  is unavailable, reattachment is pending, or the user must confirm a Chrome
  group after a restart. An approved request can return a detached session
  before tabs are published: keep its ID and recheck rather than create another.
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
works from blank or browser pages. Protected origins (the BananaBrowse server, the
identity provider) are blocked with `HANDOFF_REQUIRED`.

- **Refs belong to one snapshot of one document.** Act with `ref` + `document`
  from the latest snapshot. After any click that may navigate, open a menu or
  re-render, take a new snapshot before the next action.
- **Never guess URLs.** Link rows carry `href`: `navigate` to that exact value.
- **"loaded" is not success.** `wait_for_page` "loaded" only means the document
  is ready; a 404 or sign-in page loads too. Pass `content_selector` for the
  content you expect and check the snapshot title/URL before going on.
- **Probe selectors without side effects.** `inspect_element({selector})`
  does not focus, scroll or mutate. It reports zero matches as missing, one
  with readiness details, and multiple as ambiguous. It has no `timeout_ms`.
- **Action receipts are not application success.** `clicked: true` confirms
  dispatch, not checkout completion or a successful navigation. Inspect the
  resulting page; selector readiness does not prove the intended outcome.
- **Check capabilities.** `list_tabs` reports each tab's capabilities.
  `get_screenshot` depends on native support; Firefox environments without
  `tabs.captureTab` cannot capture it. Use a DOM snapshot, not a fabricated
  screenshot fallback.
- **Output limits are tool-specific.** `max_output_bytes` bounds serialized
  output, including the MCP wrapper. `max_text_chars` is for text-extraction
  tools, not arbitrary `evaluate_script` results; for `query_all` it is per
  text field. Inspect the schema instead of copying parameters between tools.

## Structured DOM data: query_all

Prefer `query_all` when row and field selectors are known; use a snapshot or
read-only inspection to discover them. It avoids bespoke scripts and large
page-text dumps, but does not make site-specific selectors immune to changes.

```json
{
  "tab_id": "t12",
  "description": "Read listing titles, prices, and links to compare the available items.",
  "selector": ".listing",
  "fields": {
    "title": { "selector": ".title" },
    "price": { "selector": ".price" },
    "href": { "selector": "a", "attribute": "href" }
  },
  "limit": 50,
  "timeout_ms": 0
}
```

These are illustrative selectors, not a site's guaranteed DOM contract.
Field selectors are relative to each rendered row, including open shadow roots;
`:scope` selects the row itself. Iframes and closed roots are not traversed.
Omit `attribute` for rendered text. Allowed attributes are `href`, `src`,
`title`, `alt`, `datetime` and `aria-label`; links are resolved to HTTP(S) URLs.
Form values and editable content are redacted.

- Check `matched_count`, `returned_count`, `rows_truncated`, `field_issues`
  and `truncated`. Counts describe currently rendered rows, not a site's total
  dataset. Missing/redacted fields are `null` with an explicit issue.
- A field matching multiple rendered elements fails with `ELEMENT_AMBIGUOUS`
  and `query_field`/`row_index`. Narrow it; do not select an arbitrary match.
- Use standard CSS, not Playwright-only selectors such as `:has-text()`.
  Invalid syntax yields `INVALID_SELECTOR`, with field location when applicable.
- No matching rows yields `ELEMENT_NOT_FOUND`; a positive `timeout_ms` waits
  for rows and can return `WAIT_TIMEOUT` with `last_error`. Zero is immediate
  for row readiness; document-readiness checks still apply.
- Limit is 50 rows by default, maximum 100, with up to 20 fields. Text defaults
  to 4000 characters per field. Inline output drops complete rows to meet the
  byte budget; a single row too large produces `RESULT_TOO_LARGE`.
- For bulk data pass `return_as: "artifact"` and an optional `artifact_name`.
  Artifacts bypass inline row trimming, not the requested row/text limits.
  This tool does not scroll, paginate, navigate, focus or mutate.

## Scripts and recovery

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
retry.** `BROWSER_OFFLINE` → check any observed `offline_reason` and existing
sessions. The window may be closed or reconnecting; if the problem persists,
ask the user to check the window and connection or choose another browser.

## Bulk data: artifacts

Never move more than ~10 KB of page data through the conversation: it's slow,
costly and can corrupt data. Store bulk results on the BananaBrowse service:

1. Use `query_all` for structured DOM rows, or `evaluate_script` for data absent
   from the DOM (for example the site's paged API). A script's final expression
   returns the array or object; keep the whole call within its execution limit. Pass
   `return_as: "artifact"` and `artifact_name: "activities.json"`.
2. The result is a handle: `artifact` (`artifact_id`, `bytes`, `sha256`, `mime`,
   `download_url`), a `shape` summary (type, length, item keys) and a short
   `preview`. Check the shape and, for `query_all`, the returned counts and
   truncation flag. Downloaded extraction JSON also contains `field_issues`.
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
**Done** or **Cancel** in the BananaBrowse window. Only that tab waits; others can
keep working. `ACTION_DECLINED` means they cancelled.

## Boundaries

Sessions use the user's real logins and cookies. Scripts can read private data
and act on accounts, and ending a session can't undo requests already made.
Use disposable fixtures for tests and never mutate real accounts to prove a
capability.
