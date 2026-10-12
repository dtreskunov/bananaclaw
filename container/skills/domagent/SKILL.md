---
name: domagent
description: Use a user's independently approved browser connection when a website needs human interaction or an existing browser session. Guide tenant setup without handling durable credentials.
---

# DomAgent browser access

DomAgent is an independent service. It does not know about BananaClaw or OneCLI.
Your MCP credential belongs to this agent group, not just the current conversation.
Browser pairing permits requests; local approval is still required before sharing.
The workspace protocol is version 4: the selected actual tab moves into a
dedicated normal window with native side-panel consent. Stop closes that tab and
loses unsaved state. Normal logins/cookies are reused, not isolated.
The current diagnostic release is service **4.3.0-beta.3** / extension **4.3.3**.
Update the browser extension in place for navigation/label improvements; keep
pairing keys and credentials. Description minimum40 is enforced by the server.
Use connected target `browser_info` to record extension and Firefox versions
where available. Metadata is self-reported, not trusted package provenance; null
means unavailable/offline/older peer, not proof the browser has the latest code.
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
   authorization. Require `service: domagent` and `protocol_version: 4`.
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
  A request notifies the toolbar; the user opens its native panel and chooses
  **Share this tab**, or clicks the toolbar to share an unambiguous linked client.
  This moves the actual tab, preserving its current document. Don't automatically adopt
  the active tab or repeatedly create requests while one is pending.
  Each handle is bound to one tab/window. Extra tabs, popups or moving the tab
  revoke sharing; never use them as a route to other tabs. All positive consent
  (Approve, Allow all, Done) comes from trusted extension UI, never webpage DOM.
  Arbitrary page JavaScript remains covered by explicit Allow all.
  Supply at least 40 trimmed description characters (maximum 500) to meet updated
  validation, even if an older server accepts shorter explanations. Prefer useful
  task intent, not filler. Re-sharing an existing exact handle needs a fresh local
  approval but should preserve its connection and pending work; normally reuse
  the active handle instead of requesting another share.
- Every page operation requires its active explicit `target_id`; never substitute
  another group's target. `list_browser_targets.shared_tabs` lists all shared
  handles for the device; the old single `target_id` describes only the first.
  Pass the returned opaque handle unchanged. Updated servers reject malformed
  target handles with `INVALID_ARGUMENTS`; valid-shaped unknown/ended/foreign
  handles deliberately remain `NOT_AUTHORIZED` rather than revealing ownership.
- If a shared handle for the intended tab is already active, reuse it rather
  than requesting another sharing prompt. For a smoke test on a logged-in page,
  use one focused snapshot/targeted read. Do not click, type, navigate or clear
  overlays solely to prove that mutating capabilities work on the user's account.
  Report untested operations as untested, not broken or verified.
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
- New extensions offer `inspect_element`, a non-mutating diagnostic with a
  4 KiB maximum result. Use a selector or document/ref to inspect ZERO_SIZE,
  CSS_HIDDEN, OFF_SCREEN, DISABLED, READONLY or OBSCURED state. It does not
  focus, scroll or expose field values. If responsive UI collapses a control,
  inspect readiness, reveal the appropriate UI, refresh snapshot refs, then
  act and verify. Snapshots include viewport dimensions.
  Do not pass `timeout_ms` to `inspect_element`: element diagnosis is immediate
  after approval, not an element-readiness polling tool. Where reported,
  `hidden_by` identifies the hiding ancestor, `reveal_controls` lists bounded
  visible/enabled candidates with explicit `aria-controls`, and `activation`
  identifies an associated label for a styled checkbox/radio. They are metadata,
  not authority to blindly click a suggested control.
- Extension-generated approval summaries show actual operation, target,
  page and navigation destination separately from your unverified explanation.
  Values/source are hidden by default. A resolved target is bound to that
  exact element/document; replacement can require fresh inspection and a new
  action, never silent retargeting. Updated schemas require at least 40 characters
  after trimming and maximum 500 for sharing, handoff and page actions.
  Explain useful intent rather than padding; length alone does not establish consent.
- Keep tool output focused. Start with one compact `get_page_snapshot`, then
  `get_text` only for a relevant selector/ref; do not dump `body`, run several
  overlapping whole-page reads or return full DOM/HTML from scripts.
  Updated servers enforce a **16 KiB default** and **64 KiB hard maximum** per
  serialized text tool result (UTF-8, including the MCP content wrapper).
  Snapshots/text default to **4000 characters**, element lists to **50 entries**.
  Check `truncated`, `text_truncated`, and `elements_truncated`; never claim a
  full page/tree when any is true. A truncated snapshot does not enumerate every
  actionable element. With the updated extension, focus snapshots using
  `selector`, then request only the necessary `max_text_chars` (0..16000),
  `max_elements` (1..100) or `max_output_bytes` (1024..65536).
  Narrow the scope before raising limits. Fresh/scoped snapshots invalidate old
  refs. Do not fetch every omitted section merely to reconstruct a full dump.
  Screenshots are separate explicit image requests with their own larger limits;
  textual output caps do not constrain images or the total of many tool calls.
- `evaluate_script` evaluates source/expression, not a function body. Use
  `document.title` or `(() => document.title)()`, never bare
  `return document.title;`. Return a small JSON object/scalar, not `outerHTML`,
  whole-page text or a large array. `RESULT_TOO_LARGE` rejects the value instead
  of returning partial JSON; narrow the script, do not blindly increase limits.
  `SCRIPT_SYNTAX_ERROR` requires correcting the source; `SCRIPT_RUNTIME_ERROR`
  means page evaluation failed; `SCRIPT_SERIALIZATION_ERROR` means the value
  is not JSON-returnable. `SCRIPT_POLICY_BLOCKED` means the page refused eval:
  use snapshots/targeted text, do not bypass CSP or repeat the same script.
  `SCRIPT_EXECUTION_UNAVAILABLE` means browser injection failed. Older extensions
  still report generic `CAPABILITY_UNAVAILABLE`; the presence of a capability
  does not guarantee that every page allows it.
- Supported actions can wait up to `timeout_ms` (0..10000) for readiness.
  Multiple selector matches fail with `ELEMENT_AMBIGUOUS`; controls may report
  disabled, readonly, invisible or obscured state. Remove the actual obstruction
  or complete prerequisites instead of injecting a click to bypass checks.
  Element waits default to 3000 ms; use `timeout_ms:0` for immediate selector
  probes. A positive exhausted wait intentionally returns `WAIT_TIMEOUT`;
  updated errors include `last_error` and `timeout_ms` to identify missing,
  disabled, readonly, invisible, obscured or absent-option conditions. Do not
  assume timeout means network failure or automatically retry the mutation.
  `wait_timeout_seconds` is the separate human approval budget.
- New extensions may advertise `select_option`, `set_checked`, `press_key`,
  `scroll`, and `wait_for_page`. Input is DOM-based; `press_key` does not perform
  native default actions or browser shortcuts. Prefer click/fill/select/check
  for native control state. `navigate` means navigation started; `wait_for_page`
  observes the loaded URL/document, not completion of a website transaction.
  Top-level pages and open shadow roots are supported; iframe/closed-shadow-root
  access is not. Always check the actual grant capabilities before using new tools.
  Styled checkbox/radio inputs may use their exact visible associated label.
  This does not bypass disabled state, hidden ancestors, site overlays or
  replacement checks. Use normal `set_checked`/label `click`, then verify state.
- Browser capabilities remain real platform limits. Firefox screenshots may be
  unavailable; ordinary page scripts may fail CSP. No privileged workaround or
  visible-tab substitution is allowed. There is no capability selection dialogue.
- Legacy geometry coordinates are viewport-relative, not document coordinates.
  A negative `y` is off-screen, not evidence of a hidden element. Use
  `in_viewport`, `disabled`, `readonly`, and `editable` fields; listed controls
  are not guaranteed actionable. Hidden inputs are excluded. Prefer snapshot
  refs, which let the action scroll into view and perform actual readiness checks.
- `get_text` reads rendered text, not hidden script/style/raw DOM contents.
  Updated extensions return HTML `head > title` as bounded
  `text_source:"document_title"` metadata. Other non-rendered targets return
  `rendered:false` and `empty_reason:"NOT_RENDERED"`, not proof they contain no
  data. CSS `title` may match SVG titles too; prefer snapshot `title` or the
  qualified HTML selector.
- `tools/list` is the service's generic catalogue, not the current browser's
  capabilities. Seeing `evaluate_script` or `get_screenshot` there proves neither
  browser support nor local approval. Inspect the active target's `capabilities`
  and keep missing capabilities explicit.
  The catalogue includes three management/handoff tools plus page operations
  (18 total once inspect_element is installed). A Firefox grant is not missing
  usable tools merely because its count differs from the catalogue:
  screenshots may be unavailable, and the management tools
  are not entries in that grant array. Successful text extraction does not
  establish that script evaluation is allowed on the same page.
- An `offline` device is registered but has no authenticated extension connection.
  Ask the user to open the installed extension and choose **Try again** or its
  saved connection. `/join/<tenant>` is installation/setup help, not a webpage
  that remotely reconnects the extension. After connection, request access and
  have the user choose **Share this tab** locally.
- The authenticated extension connection remains online without any shared tab.
  Prefer the updated `connection_state`, `sharing_state`, and
  `pending_request_id` fields. A null pending ID means there is no current
  sharing request; do not tell the user to approve a nonexistent prompt.
  Legacy `approval_required` means connected but not sharing, not that a request
  is awaiting approval.
  Sharing is not required to keep WSS alive, and permission is not window-scoped.
  Repeated offline/online flips require connection diagnostics, not racing access
  requests, guessing debug endpoints, or telling the user to share before a request.
- `ELEMENT_NOT_FOUND` is a CSS miss; `INVALID_SELECTOR` is malformed CSS.
  Implicit button submit behavior is not a `[type="submit"]` attribute.
- `TARGET_STALE` is a document race, not a selector miss. Do not automatically
  retry a mutation. `OUTCOME_UNKNOWN` may mean it already happened.
  Updated inspection waits briefly for a settled document before producing a
  preview. A document-unbound read that has not yet been approved can refresh its
  preview across navigation; already approved work and explicit refs/documents
  never silently rebind. After `navigate`, prefer `wait_for_page` then a fresh
  snapshot. Where present, `inspection_stage` distinguishes tab_status,
  document_state, document_changed and document_injection; allowlisted
  `last_error`/`timeout_ms` explains an exhausted inspection wait.
  `injection_reason` distinguishes permission_denied, browser_restricted,
  frame_unavailable, helper_execution_failed, empty_result or unknown. Report
  only these safe codes; do not print raw browser exception text. Persistent
  refusal remains fail-closed; no repeat POST or privileged renderer workaround.
  JSON content type alone does not establish a cause. A form field readback
  and click acknowledgement do not prove which URL received or accepted a POST.
- `PAGE_UNAVAILABLE` ends control. Ask the user to inspect/navigate the retained
  tab and approve again. Old target IDs cannot restore access.
- Use `request_handoff({target_id,description})` for login, CAPTCHA, permission
  prompts, or other human work. It waits for **Done** while retaining sharing.
  Never type/read passwords or ask for them in chat. Done is a human confirmation,
  not proof the site accepted the action; inspect the resulting page if needed.
- The user can interact and navigate while sharing. Ordinary navigation does not
  require another grant or inherently trigger `HANDOFF_REQUIRED`. That error
  denotes a protected destination or unsupported operation, not all navigation.
  Old-document queued actions may become `TARGET_STALE`;
  request new actions only against current state, without automatically retrying
  uncertain side effects.
  A successful click is not proof of a form POST or business outcome. Read back
  field/checked state before submitting, then use `wait_for_page` and inspect
  the expected response. Browser-refused response documents can return
  `PAGE_UNAVAILABLE` and end sharing; do not bypass inspection or repeat the
  POST. DomAgent leaves the user's tab open and does not navigate it back.
  Compare the document ID as well as URL when verifying navigation. Captured
  FormData is not evidence that any server received a POST. Do not install
  preventDefault submit listeners or clone/replace a user form merely to
  inspect its payload: that changes the workflow and may erase listeners/state.
  Use the control state and actual response. For JSON/PDF/browser-generated
  pages, injection may be refused; do not bypass the browser's renderer or
  replay the submission. A failed possibly mutating script may already have
  effects; inspect state instead of blindly running it again.
  `select_option` is for a real select, not radios/checkboxes; attribute selectors
  are supported. `press_key` requires an explicit target, not the currently
  focused element. Short pages can correctly return unchanged scroll offsets.
  Re-test version-dependent findings and label unverified capabilities honestly.
- `ACTION_DECLINED`, `COMMAND_CANCELLED`, and `COMMAND_EXPIRED` before execution
  mean the request ended; do not spam a replacement prompt. `OUTCOME_UNKNOWN`
  after execution may already have effects.
- Switching connections, pause, disconnect, or browser/service restart ends
  control. Identity reconnection does not restore grants.

Shared tabs use the user's website sign-ins. Page-readable secrets, text, scripts,
and screenshots may enter BananaClaw history; private-network sites may be
reachable. Pause stops new commands but cannot undo prior effects or scheduled
JavaScript. Stop/explicit Disconnect closes owned tabs; unexpected failures leave
the response available for inspection and manual closure. Closing cannot undo
sent requests/account changes or site background workers. Same-origin/opener
relationships persist, so a dedicated window is not a security sandbox.
The private local history is a bounded commands/observed-events log, not a complete
audit of JavaScript effects; it is not exposed to MCP. The page border is cosmetic.
Require matched v4 server/extension versions; prior v3 extensions cannot connect.
Update in place without resetting pairing keys or credentials, then share again.
