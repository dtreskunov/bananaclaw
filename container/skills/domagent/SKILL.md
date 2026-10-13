---
name: domagent
description: Use a user's locally activated DomAgent tab-group workspace for real browser tasks, including background tabs and human assistance. Pair by a short code without handling durable credentials.
---

# DomAgent v5 workspaces

DomAgent is independent of BananaClaw and OneCLI. Current matched release:
service5.0.0-beta.3 / extension5.0.1 / browser wire5. It replaces per-action
approval and one-tab windows with locally activated native-sidebar/group scope.
Old browser proofs/tools cannot authorize v5.

## Verify the configured MCP path

Use the group's actual configured authenticated HTTP MCP server. Recognize the
validated `https://<server>/mcp/<tenant>` endpoint, not a fixed entry name.
Credential belongs to the agent group, not just this chat. Inspect permitted
`ncl groups config` operations; preserve unrelated servers. Native tool discovery
should find21tools and caller-scoped `list_browser_workspaces`.

A successful curl probe is not proof the native provider is configured. Repair
authorization/configuration errors rather than inventing a namespace, replacing
pairing records, broadening credentials or using unauthenticated endpoints.
An HTTP600000ms MCP timeout permits genuine human waits; choose at most540seconds
with that timeout to leave execution headroom. Ordinary page calls have no
wait_timeout_seconds; use operation readiness timeout_ms where exposed.

## If no MCP client is configured

Ask for the intended DomAgent service domain and verify bounded public HTTPS
metadata with normal TLS checks; require service=domagent, protocol_version5.
No probing private/loopback/cloud metadata without operator authorization.
The operator provisions an independently revocable MCP client using DomAgent's
local CLI or configured operator administration. Browser pairing codes do not
create an application credential. There is no OIDC/browser-user login prerequisite.

The operator imports the once-shown credential directly into OneCLI and grants
it only to this group. **Never request/receive/echo/store raw credentials** in
chat, agent-visible files, environment or tool descriptions.

Vault injection must match the exact intended DomAgent hostname and
`/mcp/t_<id>` pathname. No `/*`, `/mcp/*`, dashboard, pairing or other namespace
scope. A gateway's broad creation link is not permission to broaden saved scope.
If creating a OneCLI generic-secret link, use its known operator dashboard URL
and URL-encode validated host/path/name fields only after the namespace is known.
Do not guess a vault profile or treat a prefilled link as saved-scope proof.

Configure:

```
ncl groups config add-mcp-server --name domagent --type http --url <validated-mcp-url> --timeout 600000
```

Use normal operator approval and restart/provider rediscovery to load the tools.
If placeholder headers are needed, use repository-sanctioned placeholders only;
never put real credentials in CLI flags. Verify actual provider requests pass
through destination/group-scoped OneCLI injection and absent grants fail explicitly.

## Browser-led pairing

User installs extension in place, enters only the service domain and reads a
five-minute short code. Ask for that code, then call `adopt_browser({pairing_code})`
on the configured authenticated MCP connection. Caller identity/namespace comes
from the credential, not an argument. Do not enumerate/guess pending invitations.
The short code is intentionally shareable once, not a durable secret.

The extension shows the proposed application and user confirms
**Connect and start workspace**. Application labels are not verified human
identities. Pairing alone does not grant tab control; workspace activation and
native sidebar/group membership are required. Unknown/expired/cancelled codes
fail generically; no retry spam or forced re-enrollment.

Existing v4 identities and credentials are migrated explicitly, not reset.
Firefox unsigned temporary installs can disappear on restart; never recommend
disabling signing checks. Updating in place should preserve device keys.

## Workspace and tabs

- `list_browser_workspaces()` lists eligible device/workspace state and bounded
  self-reported browser_info. Multiple browsers require user identification.
- `wait_for_workspace({device_id,description,timeout_seconds?})` waits passively
  for explicit user activation; immediate when active. It cannot open the sidebar,
  resume user pause or produce another approval per routine action.
- `list_workspace_tabs({workspace_id})` gives explicit opaque handles and effective
  capabilities for active grouped tabs only. Never enumerate unshared tabs.
- `create_workspace_tab({workspace_id,url?,description})` creates a fresh background
  grouped tab (default blank). Eight-tab capacity, two cross-tab executions, one
  per tab. It cannot regroup/adopt existing unrelated tabs. Do not automatically
  repeat creation after uncertain failure.
- Ordinary page tools always address target_id, never a current-tab default.
  The user can browse ungrouped tabs while grouped tasks continue in the background.
  Do not steal focus, change tabs/windows or request extra browser privileges.
- Adding/removing group tabs is local consent. Removed/re-added tabs and fresh
  session activations issue fresh authority. Website popups are excluded until
  deliberately added; group name alone is not permission.
- Pause/End/sidebar close/reconnect invalidates runtime authority; tabs remain
  open. New mutations must not accumulate to fire on Resume. WORKSPACE_PAUSED/
  INACTIVE requires local user action, not an agent workaround.
  Compare service_epoch/connection_id and end_reason before diagnosing lost
  credentials. A service restart destroys active handles and in-memory tombstones;
  NOT_AUTHORIZED for an old unknown handle is not proof pairing broke.
  Updated extensions can republish inactive empty summaries with SERVICE_RESTARTED/
  CONNECTION_LOST; last_session_end is extension-reported context, not authority.
  Ask for local Start/Resume, not re-pairing. Multiple retained same-named groups
  are organization only; the user can explicitly select the intended native group.

Descriptions require at least40 trimmed Unicode code points, maximum500 raw
code points. Supply useful nonsensitive intent, not filler; this is activity
context, not proof of informed consent. They are not durable audit content.
The metadata path is exactly `/.well-known/domagent` (no `.json` suffix);
`/health` is service health, not a tenant MCP health path.

## Safe reading and page actions

Start with a focused `get_page_snapshot`; read only relevant selectors/refs.
Default4000textchars/50elements, 16KiB UTF-8 serialized MCP text-content wrapper,
hard64KiB. Inspector4KiB. Check truncation; never imply complete enumeration from
a capped list or reconstruct a whole page with overlapping reads. Screenshots
are separate image requests and actual browser capability may omit them.

Snapshots redact field values, not every possible page secret. Native DOM refs
are exact to that document; fresh snapshots invalidate old refs. Selector matching
must be unique. `inspect_element` is non-mutating, no timeout_ms polling argument;
read hidden_by/reveal_controls/activation metadata to diagnose responsive UI.
Suggestions are not authority to blindly click. Styled checkboxes/radios can use
their exact visible labels without bypassing disabled state, site overlays,
hidden ancestors or replacement checks.

Use click/type_text/select_option/set_checked/scroll/wait_for_page as appropriate.
Input is DOM-based; press_key is not native input or browser default behavior.
Top-level/open-shadow scope only; no frame/closed-shadow/profile export.
Navigation means started, not completed transaction. Verify actual loaded response,
document identity and small readback; a click or FormData is not proof of receipt.
Never intercept submit handlers, preventDefault user forms or clone/replace them
merely to inspect payloads. Mutation acknowledgement and DOM outcome are separate.

`evaluate_script` takes source/expression, not a function body; document.title or
an IIFE is valid, top-level return is not. Use focused JSON only, not full DOM.
SCRIPT_POLICY_BLOCKED is not permission to bypass CSP. Syntax/runtime/serialization/
injection failures are distinct; a failed script may already have side effects.
An interrupted evaluate_script cannot be proven read-only from its apparent source:
getters, network requests and delayed effects remain possible. Preserve uncertainty
and inspect state rather than automatically retrying. A runner interruption notice
is not by itself proof of a DomAgent permission failure or external mutation.
RESULT_TOO_LARGE means narrow output, not silently accept partial JSON.

New Tab or a refused viewer can be navigation-only: ordinary allowed website
navigation does not need injection into the current document. DOM calls may
return DOCUMENT_NOT_CONTROLLABLE, with fixed inspection_stage/injection_reason/
last_error/timeout_ms. Record actual versions and safe diagnostics; no raw exception
text, security-setting changes, renderer bypass, POST replay or new auto-grant.
Protected management origins and invalid navigation destinations remain blocked.
This is not a universal JSON/PDF/image interoperability promise.

TARGET_STALE/ELEMENT_STALE requires fresh inspection; OUTCOME_UNKNOWN may mean
a mutation already happened. Never repeat uncertain actions. Caller-owned removed
handles can report TAB_NOT_IN_WORKSPACE; unknown/foreign IDs remain NOT_AUTHORIZED.
Inspect workspace state before assuming credential failure.

## Global human assistance

Use `request_handoff` for login, CAPTCHA or human work. Never type/read passwords
or solicit credentials. It blocks that tab, not all workspace tasks.
The extension posts a generic system notification and browser-wide pending badge;
clicking focuses the bound task, **not** Done. The human explicitly uses Done/Cancel.
NOTIFICATION_UNAVAILABLE means API delivery failed; OS DND may still suppress
successful creation. Do not claim a person saw or completed the task without
evidence. Report stale/cancelled requests rather than sending repeated prompts.

## Acceptance reporting

Read the current `notes/domagent-test-plan.md` when asked to test. Record service,
extension and browser versions independently; browser_info is self-reporting,
not package attestation. Use fictitious/disposable fixtures only, bounded evidence,
immutable dated reports and PASS/FAIL/BLOCKED/NOT_RUN distinctions.
Do not mutate real accounts to prove tool capability. Old reports remain evidence,
not a mandate to preserve an exact failure signature or silently re-pair devices.

Normal logins/cookies/opener relationships are shared. Arbitrary page scripts
and account actions can expose private information. End/Pause cannot undo sent
requests, site workers or script effects in other contexts. History is a bounded
commands/observed-events log, not a complete security audit.
