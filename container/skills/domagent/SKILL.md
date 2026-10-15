---
name: domagent
description: Work in the user's real browser through DomAgent v6 sessions (approved native tab groups), including background tabs and human help. Pair by a code the user reads from their DomAgent window.
---

# DomAgent v6 browser sessions

DomAgent is independent of BananaClaw and OneCLI. Service 6.0.0-beta.2 /
extension 6.0.1 / wire v6. The user runs a small DomAgent window in their
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

- `list_browsers()` shows `online`. Offline means the user's DomAgent window is
  closed: ask them to open it, or use another online browser.
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
- `list_tabs({session_id})`: all tabs in the group, including ones the user
  dragged in or a site opened. `create_tab({session_id, url?, description})`
  adds a background tab (max 8). `TAB_NOT_IN_SESSION` means the user removed it.
- `report_progress({session_id, message})` posts a short update to the user's
  activity feed. Use it for milestones, not every step.

## Page tools

Every page tool takes `tab_id` and a 40–500 character `description` the user
sees in their activity feed: say what and why, without secrets.

Start with a focused `get_page_snapshot`. Defaults are 4000 characters, 50
elements and 16 KiB (hard limit 64 KiB). Check truncation, narrow with
selectors and use snapshot `ref` + `document` for actions. Input is DOM-based,
not native keystrokes. `wait_for_page` "loaded" is document readiness; add
`content_selector` for real content. `navigate` works from blank or browser
pages. Protected origins (the DomAgent server, the identity provider) are
blocked with `HANDOFF_REQUIRED`.

`evaluate_script` takes an expression or source, not a function body. Prefer
`world: "USER_SCRIPT"` for DOM work, and use `MAIN` only for page globals.
Return focused JSON only. CSP can refuse scripts; never switch worlds and retry
a possibly-mutating script.

`DOCUMENT_NOT_CONTROLLABLE` means the tab is blank, browser-owned or restored
lazily: `navigate` it. `TARGET_STALE`/`ELEMENT_STALE` → re-inspect.
**`OUTCOME_UNKNOWN` → a mutation may have happened: inspect, never blindly
retry.** `BROWSER_OFFLINE` → the window closed mid-task; tell the user.

## Human help

Use `request_handoff({tab_id, instructions})` for logins,
CAPTCHAs, payments or review. Never type or read passwords or ask for
credentials. The user gets a notification, the tab group flashes, and they click
**Done** or **Cancel** in the DomAgent window. Only that tab waits; others can
keep working. `ACTION_DECLINED` means they cancelled.

## Boundaries

Sessions use the user's real logins and cookies. Scripts can read private data
and act on accounts, and ending a session can't undo requests already made.
Use disposable fixtures for tests and never mutate real accounts to prove a
capability.
