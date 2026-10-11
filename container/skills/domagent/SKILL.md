---
name: domagent
description: Use a user's independently approved browser connection when a website needs human interaction or an existing browser session. Guide tenant setup without handling durable credentials.
---

# DomAgent browser access

DomAgent is an independent service. It does not know about BananaClaw or OneCLI.
Your MCP credential belongs to this agent group, not just the current conversation.
Browser pairing permits requests; local approval is still required before sharing.
The collaborative protocol is version 3: users choose existing/new tabs and
supervise actions, not a capability checklist or exclusive automation session.
Do not promise to bypass bot protection, solve CAPTCHA, or extract credentials.

## Check before requesting setup

Inspect your group's MCP configuration using permitted `ncl groups config`
operations. Do not require the entry to be named `domagent`; recognize its
`https://<server>/mcp/<tenant>` endpoint and verify authenticated tool discovery
and `list_browser_targets`.

Reuse the configured server/tenant if no browser is connected. If authorization
or transport fails, explain and repair it; do not create a replacement tenant,
guess a tenant ID, broaden credentials, or use an unauthenticated fallback.
If multiple browsers are eligible, ask which to use.

Successful direct curl JSON-RPC proves that request's transport/authorization,
not that DomAgent is configured as a native MCP server for the group. Verify the
group MCP entry separately; do not silently treat direct probes as completed
configuration or keep using them as an unapproved substitute.

## When no DomAgent MCP server is configured

1. Ask whether the user has access to a DomAgent server and collect its domain.
   Normalize a bare domain to HTTPS; reject HTTP, credentials, paths, queries,
   fragments, and unexpected cross-origin redirects.
2. Check `GET https://<domain>/.well-known/domagent` with normal TLS verification,
   bounded time/size limits, and the host's outbound-request policy. Do not probe
   loopback, link-local/cloud metadata, or private destinations without operator
   authorization. Require `service: domagent` and `protocol_version: 3`.
3. After confirming the intended domain, send `POST /api/setup-requests` with
   `agent_name` (at most 80 characters) and `request_description` (at most 500).
   Describe the user's task briefly without chat transcripts, sensitive page
   contents, credentials, or scripts.
4. Share the exact returned `verification_url`. Accounts register automatically
   through the configured OIDC provider; no DomAgent invitation is required.
   The user signs in independently
   and approves setup on DomAgent. The short-lived setup-link token is not a
   durable credential. Never fabricate a link or tenant ID.
5. Poll `POST /api/setup-requests/<request_id>/status` sparingly, passing
   `status_receipt` in the JSON body. Stop at its expiry or denial. Approval
   returns only public `connection_url`, `tenant_id`, and `mcp_url`.
6. The operator imports the once-shown MCP credential directly into OneCLI and
   attaches it only to this group's OneCLI identity. **Never ask for, receive,
   echo, or store that credential in chat, environment, or agent-visible files.**
   Scope its injection to the exact tenant MCP endpoint, as described below;
   never use a host-wide path such as `/*`.
7. Add the group MCP entry using
   `ncl groups config add-mcp-server --name domagent --type http --url <mcp_url> --timeout 600000`.
   `--transport http` is an alias. If the verified gateway configuration requires
   a header placeholder, supply it through `--headers '<json-object>'`; never
   supply a real credential. No `--command` is needed for HTTP. Use normal
   administrator approval and restart the group to load the entry. The existing
   group MCP settings editor is also supported. Preserve unrelated servers.
   The settings editor also supports its MCP timeout of 600000 ms for human waits.
   Page/sharing requests default to 300 seconds waiting plus at most 25 seconds
   execution. Explicit waits must leave headroom under actual client/proxy limits;
   use at most 540 seconds with a 600-second transport. Native MCP timeout limits
   must be verified, not inferred from direct curl success.
8. Verify the actual provider's HTTP traffic traverses OneCLI, injection is
   destination/group scoped, credentials are not exposed, and missing vault
   grants fail explicitly. Environment proxy variables alone are not proof.
9. Provide the public `connection_url` and browser-specific release ZIP/install
   instructions. The user installs, pastes this one link, signs in, and approves.
   The extension connects automatically; no tabs are shared until local approval.

Configured tenant endpoint but no connection link: derive
`https://<same-origin>/join/<exact-tenant-id>` from that validated endpoint.
Do not pass MCP credentials or the secret setup-approval URL to extension settings.
Firefox release ZIPs are temporary unsigned add-ons; reloading after browser
restart may be required. Never suggest disabling signature verification.

## Tenant-specific OneCLI connection links

Before providing a OneCLI generic-secret creation link, obtain the validated
`mcp_url` from the approved setup response or existing group MCP configuration.
Require HTTPS, the intended DomAgent hostname, and an exact
`/mcp/t_<tenant-id>` pathname. Do not generate the link before the tenant is known.

Use the established OneCLI dashboard/profile URL, without guessing a profile ID.
For its `/connections/custom` link, set query parameters using a URL builder:

- `create=generic`
- `host=<mcp_url hostname>`
- `path=<mcp_url pathname>` (for example `/mcp/t_2hML7r5X0vXmLBErvwUBXA`)
- `name=DomAgent MCP <tenant-id>` so different tenant credentials are distinguishable

URL-encode each query value. The `path` must be the exact MCP pathname, not `/*`,
`/mcp/*`, `/mcp/<tenant>/*`, a `/join/` link, or a dashboard path. A single tenant
endpoint does not need a wildcard. The credential must not be offered to another
tenant, owner dashboard, enrollment endpoint, or setup-request endpoint.

Even if a gateway error returns a host-wide creation link, narrow its `host` and
`path` to the validated tenant endpoint before presenting it. Preserve the known
OneCLI dashboard/profile base. Do not broaden an existing credential's scope to
make a call work.

Have the operator verify the saved secret's host/path scope and grant it only to
this group's OneCLI identity. A prefilled URL is not proof of saved scope or proxy
traversal. If a host-wide secret was already created, ask the operator to restrict
or replace it before use; do not silently create overlapping credentials.

## Use the browser

- `request_browser_access` takes `device_id`, a plain-language `description`, and
  optional `wait_timeout_seconds`. It now waits for explicit user tab sharing and
  returns `target_id`/`tab_handle`; configure the transport timeout first.
  A request opens a small extension window. The user navigates to the tab they
  want and chooses **Share this tab** in the extension. Don't automatically adopt
  the active tab or repeatedly create requests while one is pending.
- Every page operation requires its active explicit `target_id`; never substitute
  another group's target. `list_browser_targets.shared_tabs` lists all shared
  handles for the device; the old single `target_id` describes only the first.
- Every page operation includes a non-sensitive `description` accurately explaining
  the action. The user can **Approve**, **Decline**, or choose **Allow all while
  sharing** for that client/tab. This does not grant browser-wide APIs, protected
  management pages, or access to other tabs. Do not treat friendly wording as
  permission for a different underlying action.
- When the installed browser advertises `get_page_snapshot`, use it to obtain
  document-bound `ref` targets rather than guessing CSS selectors. Pass both
  `ref` and `document`; do not also pass `selector`. A fresh snapshot invalidates
  earlier refs. `ELEMENT_STALE` or `TARGET_STALE` requires fresh inspection,
  not a blind repeat of a mutation. Snapshot field values are redacted.
- Supported actions can wait up to `timeout_ms` (0..10000) for readiness.
  Multiple selector matches fail with `ELEMENT_AMBIGUOUS`; controls may report
  disabled, readonly, invisible or obscured state. Remove the actual obstruction
  or complete prerequisites instead of injecting a click to bypass checks.
- New extensions may advertise `select_option`, `set_checked`, `press_key`,
  `scroll`, and `wait_for_page`. Input is DOM-based; `press_key` does not perform
  native default actions or browser shortcuts. Prefer click/fill/select/check
  for native control state. `navigate` means navigation started; `wait_for_page`
  observes the loaded URL/document, not completion of a website transaction.
  Top-level pages and open shadow roots are supported; iframe/closed-shadow-root
  access is not. Always check the actual grant capabilities before using new tools.
- Browser capabilities remain real platform limits. Firefox screenshots may be
  unavailable; ordinary page scripts may fail CSP. No privileged workaround or
  visible-tab substitution is allowed. There is no capability selection dialogue.
- `tools/list` is the service's generic catalogue, not the current browser's
  capabilities. Seeing `evaluate_script` or `get_screenshot` there proves neither
  browser support nor local approval. Inspect the active target's `capabilities`
  and keep missing capabilities explicit.
- An `offline` device is registered but has no authenticated extension connection.
  Ask the user to open the installed extension and choose **Try again** or its
  saved connection. `/join/<tenant>` is installation/setup help, not a webpage
  that remotely reconnects the extension. After connection, request access and
  have the user choose **Share this tab** locally.
- The authenticated extension connection remains online without any shared tab.
  `approval_required` means connected and waiting for local control approval;
  sharing is not required to keep WSS alive, and permission is not window-scoped.
  Repeated offline/online flips require connection diagnostics, not racing access
  requests, guessing debug endpoints, or telling the user to share before a request.
- `ELEMENT_NOT_FOUND` is a CSS miss; `INVALID_SELECTOR` is malformed CSS.
  Implicit button submit behavior is not a `[type="submit"]` attribute.
- `TARGET_STALE` is a document race, not a selector miss. Do not automatically
  retry a mutation. `OUTCOME_UNKNOWN` may mean it already happened.
- `PAGE_UNAVAILABLE` ends control. Ask the user to inspect/navigate the retained
  tab and approve again. Old target IDs cannot restore access.
- Use `request_handoff({target_id,description})` for login, CAPTCHA, permission
  prompts, or other human work. It waits for **Done** while retaining sharing.
  Never type/read passwords or ask for them in chat. Done is a human confirmation,
  not proof the site accepted the action; inspect the resulting page if needed.
- The user can interact and navigate while sharing. Ordinary navigation does not
  require another grant. Old-document queued actions may become `TARGET_STALE`;
  request new actions only against current state, without automatically retrying
  uncertain side effects.
- `ACTION_DECLINED`, `COMMAND_CANCELLED`, and `COMMAND_EXPIRED` before execution
  mean the request ended; do not spam a replacement prompt. `OUTCOME_UNKNOWN`
  after execution may already have effects.
- Switching connections, pause, disconnect, or browser/service restart ends
  control. Identity reconnection does not restore grants.

Shared tabs use the user's website sign-ins. Page-readable secrets, text, scripts,
and screenshots may enter BananaClaw history; private-network sites may be
reachable. Pause stops new commands but cannot undo prior effects or scheduled
JavaScript. The page border is a helpful visual cue, not a trusted security boundary.
