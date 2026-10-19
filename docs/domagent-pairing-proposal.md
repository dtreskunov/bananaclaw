# BananaBrowse: browser pairing, sessions, and BananaClaw integration

**Status:** implementation reference, replacing the original DomAgent proposal.
**Updated:** 2026-10-19.
**Implementation snapshot:** the local
[BananaBrowse](https://github.com/dtreskunov/bananabrowse) checkout at
`9aec727c2e6adc0dcf4a0d62ebc01d22593a5f63`: service and extension
**1.0.0-beta.2**, browser wire **v6**, database schema **6**. The extension's
numeric manifest version is **0.9.0.2**.

This records the implementation at that revision, not an assertion that a
particular service is deployed, the release is published, or every provider and
browser has passed production qualification. The implementation's `README.md`,
`docs/ARCHITECTURE.md`, `docs/V6-UPGRADE.md`, and `bananabrowse-mcp/README.md`
are the detailed source references. The filename is retained for existing links.

## 1. What supersedes the original proposal

BananaBrowse began as a fork of
[vaishnavucv/domagent](https://github.com/vaishnavucv/domagent). The original
proposal below this filename is no longer its authorization or lifecycle
contract:

| Earlier proposal                                                       | Current implementation                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Invited OIDC owners and a management dashboard                         | No user accounts or OIDC dashboard; agents are configured by the service operator                                                 |
| Owner-mediated device enrollment                                       | Rate-limited browser self-registration with a non-extractable signing key; registration grants no agent access                    |
| Unscoped or tenant-scoped MCP routes                                   | Authenticated `/mcp/<agent-id>` with an operator-configured key per agent                                                         |
| One dedicated automation tab per client/device                         | A locally approved session is a native tab group, containing up to eight tabs                                                     |
| Popup/options controls backed by a persistent background connection    | One app-like extension window owns the connection and tab controller                                                              |
| Disconnect ends the grant and reconnect always requires a new approval | Disconnect detaches sessions; reopening reconnects surviving groups automatically, with Chrome restart matching confirmed locally |
| Nonblocking access requests and status polling                         | Bounded, long-running pairing, session, handoff, and close requests                                                               |
| One explicit `target_id` per page operation                            | Session management uses `session_id`; page operations use server-issued `tab_id`                                                  |
| Automatically exclude website-created tabs                             | Every tab in an approved group is in scope, including tabs opened by websites that join it                                        |
| No service-side page-content storage                                   | Explicit artifacts can store agent-scoped page results with quotas and expiry                                                     |

There is no BananaClaw chat client inside the extension, no native sidebar, no
tenant/namespace provisioning, and no new BananaClaw browser-management endpoint.

## 2. Components and trust boundary

```text
Browser owner's device                    Independently administered service
----------------------                    ----------------------------------
BananaBrowse extension window             TLS reverse proxy
  trusted approval and activity UI          |
  signing key and refresh token             +-- /.well-known/bananabrowse
  tab-group/session controller              +-- /api/challenge
         |                                  +-- /api/browsers and /api/token
         +-- authenticated outbound WSS ---->+-- /extension
                                            |     browser hub and policy
BananaClaw agent group                      |
  HTTP MCP configuration                    +-- /mcp/<agent-id>
  vault credential placeholder              |     stateless HTTP MCP
         |                                  |     artifact download/delete
  OneCLI credential injection -- HTTPS ---->+
                                            +-- SQLite and artifact files
```

The service also supports other compatible Streamable HTTP MCP clients that can
supply an Authorization header. OAuth-only clients are not implicitly supported.
BananaBrowse and BananaClaw do not share databases, owner sessions, or enrollment
credentials.

Trust the browser, extension package/update channel, BananaBrowse service and its
administrators, and the credential gateway. A separately administered service
limits what a compromised BananaClaw host can provision, but cannot prevent it
from abusing authority already approved for its agent identity.

The extension is the final tab-membership and command-enforcement boundary.
Scripts, selectors, labels, page results, and agent requests remain untrusted.
Page content cannot approve pairing, create a locally approved session, or
authorize a close request.

Sessions use the browser's ordinary cookies and logins, not an isolated profile.
An authorized agent can read private page content and act on accounts; page
JavaScript can also affect same-origin state and accessible network services.
Ending a session or disconnecting cannot undo completed requests, remote changes,
or previously scheduled scripts. A tab group is not a network sandbox, and
login/CAPTCHA detection is not universal secret protection.

## 3. Agent identity, browser registration, and pairing

### Operator-configured agents

One service identity should correspond to one BananaClaw agent group, not one
conversation. All conversations in that group share its browser authority.

From the BananaBrowse checkout, generate a key and configuration line:

```sh
node bananabrowse-mcp/dist/bananabrowse-mcp/admin.js agent-key atlas "Atlas" https://atlas.example
```

The CLI prints the key once and a line with this shape:

```sh
BANANABROWSE_AGENT_ATLAS="Atlas|https://atlas.example/|sha256:<key-hash>"
```

Agent IDs are operator-chosen lowercase names; configuration suffix underscores
become hyphens. The service stores key hashes, authenticates every MCP/artifact
request, and scopes all browser, session, tab, and artifact lookups to the calling
agent. Unknown and foreign IDs return the same non-disclosing failure.

Restart the service after changing configured agents. Removing an agent prunes
its pairings, sessions, and artifacts. Browser and pairing revocations made with
the operator CLI are applied by the running service within about five seconds.

### Browser registration

The user installs the BananaBrowse extension, opens its window, enters the
server domain and browser name, and clicks **Connect**. The extension:

1. Checks `/.well-known/bananabrowse` and requests permission for that origin.
2. Generates a non-extractable P-256 signing key in extension-owned IndexedDB.
3. Registers with a key proof and receives a browser ID and tokens.
4. Uses rotating, key-bound refresh tokens and signed server challenges to
   obtain ten-minute access tokens.
5. Sends the access token in the WebSocket's first `hello` frame, then proves
   possession of its key before receiving commands.

Registration is open but rate-limited; it grants no agent browser access.
Refresh-token rotation has a five-minute lost-response grace window; later reuse
of a superseded token revokes the browser. Unpaired browsers expire after
24 hours offline; paired browsers expire after 30 days offline.

One service is configured per extension installation. Changing the domain clears
the local identity; **Forget this browser** first revokes it server-side.

### Local pairing

1. The agent calls `list_browsers()` and reuses an existing suitable pairing.
2. Otherwise, the owner clicks **Pair an agent** in the extension window.
3. The owner shares its eight-character code with the agent, which calls
   `pair_browser({code})`. Codes are single-use and expire after five minutes.
4. The window displays the operator-configured agent name/homepage; the owner
   clicks **Approve** or **Decline**.

The code is an invitation, not a bearer credential or approval. Pairing persists
until revoked but does not itself open a browser session. Reinstalling the
extension creates a new browser identity; duplicate names get a numeric suffix.
`unpair_browser({browser_id})` removes only the caller's own pairing and ends its
sessions on that browser.

## 4. Sessions, tab membership, and reconnection

The extension toolbar button opens or focuses one app-like window. That window,
not a long-lived background worker, owns the WebSocket and controller. It is not
a toolbar popup: minimizing or unfocusing it has no effect.

Before requesting another group, call `list_sessions()` and reuse an appropriate
attached session. `request_session({browser_id, purpose, urls?, title?})` always
requests a new group, with up to eight starting URLs. It fails immediately if
there is no live browser connection; otherwise the owner receives a notification
and an approval card. Approval creates a colored tab group in the last-used
normal window without stealing focus.

| Action                                             | Effect                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Drag/add a tab into the session group              | The tab enters scope with a server-issued `tab_id`                                               |
| A grouped website opens a tab that joins the group | That tab is in scope too                                                                         |
| Drag/remove a tab from the group                   | Authority over that tab ends; unstarted work is cancelled                                        |
| Close or ungroup the group                         | The session ends; remaining tabs are left open                                                   |
| Close the BananaBrowse window                      | Disconnect and detach sessions; the browser may show a generic leave confirmation                |
| Reopen the window                                  | Reconnect and automatically reattach surviving approved groups                                   |
| Browser restart                                    | Firefox restores group identity automatically; Chrome asks the owner to confirm candidate groups |
| `end_session({session_id})`                        | Ungroup and end the session, leaving tabs open                                                   |

The service's states are requested, attached, detached, and deleted. A session
survives while its group exists, for up to seven days since the last live group
report; every report extends that expiry. Inventory removes sessions whose
groups disappeared. A service restart disconnects browsers briefly, but token
refresh and group reattachment do not require re-pairing.

Chrome group IDs change across restarts, so title/color/URL matching is only a
candidate until locally confirmed. Firefox persists tab/group metadata with
`sessions.setTabValue`. A lazily restored Firefox page may retain its `tab_id`
but be navigation-only until navigated.

The server pings every 30 seconds and closes a connection after 90 seconds
without a pong. Graceful disconnect takes effect immediately; abrupt connection
loss is bounded by liveness detection. Old connections must not clear a newer
connection's state. Disconnection never authorizes replaying an uncertain action.

### Recovery without duplicate groups

`BROWSER_OFFLINE` means no live connection, not proof that the owner closed the
window. `list_browsers.online` is only a point-in-time observation.
`SESSION_DETACHED` can mean reconnecting or waiting for Chrome confirmation.

Beta.2 returns an already-approved detached session if the connection drops
before its first inventory. Keep that session ID and recheck `list_sessions`
instead of asking for another group. Offline session-request errors may include
a recently observed `offline_reason`; those observations expire after
90 seconds and do not establish the current window state.

### Human handoff and closing tabs

`request_handoff({tab_id, instructions})` asks for a login, CAPTCHA, payment, or
review in trusted extension UI. It flashes the group and sends a notification.
Only that tab waits; other tabs may continue. The owner clicks **Done** or
**Cancel**; notification clicks/dismissal alone do not approve anything.

Closing tabs is separate from ending a session:

- `close_tab({tab_id, description})` asks for approval to close one tab.
- `end_session({session_id, close_tabs: true, description})` asks to close the
  session's tracked tabs.
- The extension closes only after **Close**. **Keep open** returns
  `ACTION_DECLINED`; respect it and leave the session intact.
- Closing the last tab ends the session. Prefer plain `end_session` for normal
  cleanup so unsaved work and evidence remain available.

Human-waiting calls are bounded, normally 300 seconds and at most 600 seconds.
For BananaClaw, use `timeout_seconds` at most 540 with a 600000 ms MCP timeout
to retain transport headroom. Do not silently retry a declined or uncertain
request.

## 5. Page operations and structured extraction

Page tools require an explicit server-issued `tab_id` and a plain-language
40-500 character `description` shown in the activity feed. There is no global
current-tab fallback or raw CDP/browser-profile interface.

Start with `get_page_snapshot`, then use focused selectors or snapshot
`ref`/`document` pairs. References belong to that snapshot/document; refresh
after navigation or relevant re-rendering. Link rows include absolute `href`;
do not invent destination URLs.

`inspect_element` is an immediate read-only readiness probe, with no focus,
scrolling, mutation, or `timeout_ms`. Missing, unique, and ambiguous results are
distinct. A click receipt confirms dispatch, not a purchase or successful
navigation; inspect the resulting page. Likewise, a loaded document can still
be a sign-in page or HTTP error.

`list_tabs` advertises per-tab capabilities. Screenshots require actual native
support; Firefox environments without `tabs.captureTab` cannot provide them.
Use DOM data instead of fabricated screenshots. Scripts execute in page worlds,
not privileged extension contexts; `USER_SCRIPT` requires browser support and
CSP may refuse execution. Never change worlds and replay a possibly-mutating
script blindly.

### Beta.2: `query_all`

Use `query_all` for rendered DOM rows with known row/field selectors, rather than
custom scripts or repeated page dumps:

```json
{
  "tab_id": "t12",
  "description": "Read listing titles, prices, and links to compare available items.",
  "selector": ".listing",
  "fields": {
    "title": { "selector": ".title" },
    "price": { "selector": ".price" },
    "href": { "selector": "a", "attribute": "href" }
  },
  "limit": 50,
  "timeout_ms": 0,
  "return_as": "value"
}
```

Selectors are illustrative, not a guaranteed site contract. Field selectors are
relative to each rendered row, including open shadow roots; `:scope` selects the
row itself. Iframes and closed roots are excluded. The operation does not focus,
scroll, mutate, or invalidate snapshot refs.

- One to 20 fields; 50 rows by default, at most 100.
- Text fields default to 4000 characters, at most 16000 per field.
- `timeout_ms` defaults to zero and is capped at 10000 for row readiness.
- Allowed attributes: `href`, `src`, `title`, `alt`, `datetime`, `aria-label`.
  URLs are resolved and restricted to HTTP(S); form/editable values are redacted.
- Results include `document`, `scope`, `rows`, `matched_count`,
  `returned_count`, `rows_truncated`, `field_issues`, and `truncated`.
- Missing/redacted/unsupported values are null with field issues; multiple
  matches fail with `ELEMENT_AMBIGUOUS`. Invalid selectors identify the field
  and row. No rows returns `ELEMENT_NOT_FOUND`, or `WAIT_TIMEOUT` after a
  positive wait.
- Counts describe rendered in-scope rows at extraction time, not a site's total
  dataset. Pagination is not automatic.

`max_output_bytes` limits serialized MCP output, including its wrapper: 16 KiB
by default, at most 64 KiB. Inline trimming removes only complete rows and marks
truncation; a single row that cannot fit returns `RESULT_TOO_LARGE`.
`max_text_chars` is a text-extraction limit, not a generic script-result limit.

`query_all` requires extension 1.0.0-beta.2 (numeric 0.9.0.2). Older extensions
receive `CAPABILITY_UNAVAILABLE` with `required_extension_version` before
dispatch, without an implicit script fallback. Other beta.1 operations continue
to work.

### Bulk data: artifacts

`query_all` and `evaluate_script` accept `return_as: "artifact"` with an optional
`artifact_name`. The service stores the result and returns a handle, checksum,
shape summary, and short preview instead of passing bulk content through the
model. Extraction artifacts preserve the requested row/text limits and field
issues; they bypass inline trimming, not transport or artifact limits.

Download with `GET /mcp/<agent-id>?artifact=<artifact_id>` and verify the returned
SHA-256. `HEAD` and `DELETE` use the same authenticated path; foreign or expired
artifacts return 404. `list_artifacts` and `read_artifact` provide metadata and
bounded inspection. The download uses the same agent key as MCP, so verify
gateway injection also covers the artifact query.

Artifacts have a 24-hour TTL, a per-artifact cap of 8 MiB minus 64 KiB, and a
per-agent quota of 100 artifacts or 64 MiB with oldest-first eviction. They
persist under `BANANABROWSE_ARTIFACTS_DIR`, defaulting to the database directory's
`artifacts` subdirectory. Browser content can therefore persist both as explicit
BananaBrowse artifacts and in BananaClaw conversation history.

## 6. BananaClaw configuration and agent guidance

Reuse the existing [group MCP configuration](../src/cli/resources/groups.ts),
[native MCP client](../container/agent-runner/src/providers/native/mcp-client.ts),
and [BananaBrowse container skill](../container/skills/bananabrowse/SKILL.md).
The [runner documentation](agent-runner-details.md#native-provider-external-mcp-tools)
describes transport flags and native tool discovery.

An illustrative per-group entry is:

```json
{
  "bananabrowse": {
    "type": "http",
    "url": "https://bananabrowse.example.net/mcp/atlas",
    "headers": {
      "Authorization": "<verified-vault-authorization-placeholder>"
    },
    "timeout": 600000
  }
}
```

The placeholder above is not a supported sentinel to copy unchanged. The
operator must import the actual key directly into the vault, grant it only to
the corresponding BananaClaw agent, and verify the injection rule for the exact
HTTPS destination and `/mcp/<agent-id>` path. Never put the real key in chat,
CLI arguments, environment overrides for the container, or materialized
container configuration. Pairing codes can be shared; API keys cannot.

Configure the group through the admin CLI:

```sh
ncl groups config add-mcp-server --id <group> --name bananabrowse \
  --type http --url https://bananabrowse.example.net/mcp/atlas \
  --headers '{"Authorization":"<verified-vault-authorization-placeholder>"}' \
  --timeout 600000
ncl groups restart --id <group>
```

`--transport http` aliases `--type http`. BananaClaw also supports SSE and stdio
MCP entries, but BananaBrowse uses Streamable HTTP, not the legacy SSE transport.
Agent-initiated configuration still requires administrator approval. Changing
the URL clears previously configured headers unless explicitly supplied;
re-adding the same URL preserves headers, instructions, and timeout.

### Native provider: lazy discovery

The native provider now defaults to `mcp_tool_search: "always"`: conversational
turns see configured server names without connecting to every MCP server.
Search with `tool_search` and `server: "bananabrowse"` to discover only this
server, or use a fully qualified `select:mcp__bananabrowse__<tool>` query.
Loaded tools are callable on the next model step.

Successful discovery is cached within a query; discovery failures are explicit
tool errors and can be retried. History alone does not reconnect an undiscovered
server after restart. The retired `auto` mode and size heuristic are gone;
explicit `never` retains eager discovery/direct tools. This changes discovery,
not BananaBrowse pairing, session consent, or credential permissions.

### Required provider/gateway verification

Configuration shape and proxy environment variables are not proof of routing.
Before advertising a provider as supported, verify:

1. The real HTTP transport traverses the gateway and authenticates the expected
   per-group agent using only the agent-visible placeholder.
2. A second group cannot borrow that credential; neither MCP results, config,
   mounts, nor logs expose its real value.
3. Injection is restricted to the intended destination/path, including artifact
   downloads, and is not forwarded to unrelated endpoints.
4. Missing grants, gateway failure, and invalid credentials fail explicitly,
   with no direct/plaintext fallback.
5. Revoking credentials/pairings prevents further access, including existing
   browser-session operations.

The skill should explain optional browser access, pairing and session approval,
explicit tab IDs, handoffs, output budgets, artifact downloads, and recovery
without duplicate groups. Follow live schemas and capabilities rather than
assuming a feature from a static version string. Respect `ACTION_DECLINED`;
after `OUTCOME_UNKNOWN`, inspect state and never blindly replay a mutation.

## 7. Deployment, storage, and upgrades

Use Node 22.13+ and build the TypeScript service before restarting it. From the
BananaBrowse checkout:

```sh
npm --prefix bananabrowse-mcp ci --ignore-scripts
npm --prefix bananabrowse-extension ci --ignore-scripts
npm --prefix bananabrowse-extension/ui ci --ignore-scripts
npm --prefix bananabrowse-mcp run build
```

The service entrypoint is
`bananabrowse-mcp/dist/bananabrowse-mcp/index.js`; extension packages are built
under `dist/chrome` and `dist/firefox` at the checkout root.

- `BANANABROWSE_ORIGIN`: canonical public HTTPS origin.
- `BANANABROWSE_BIND` / `BANANABROWSE_PORT`: default `127.0.0.1:18792`, behind
  a TLS proxy; do not expose the plaintext listener.
- `BANANABROWSE_DB`: SQLite database, default `./data/bananabrowse.db`.
- `BANANABROWSE_AGENT_<ID>`: operator-configured agent name/homepage/key hash.
- `BANANABROWSE_PROTECTED_ORIGINS`: explicitly blocked control-plane/IdP
  origins; the service origin is always protected.
- `BANANABROWSE_ARTIFACTS_DIR`: artifact directory, writable under service
  hardening (`ReadWritePaths`); directory/file permissions are 0700/0600.

Reverse proxies must support WebSocket upgrades, idle timeouts above the
30-second ping interval, long MCP calls with 15-second SSE keepalives, and
browser messages up to 8 MiB. Run without shared Docker sockets, privileged
mode, or broad host mounts. Keep service configuration, database, backups, and
administrative access separate from BananaClaw.

SQLite holds browser identities, hashed refresh tokens, pairings, sessions, and
tab mappings. Live connections, pending requests, access tokens, and pairing
codes are in memory. Activity is local to the extension and capped at roughly
200 entries; service logs are JSON metadata with fixed codes/IDs, not page
content, keys, pairing codes, or scripts. Protect artifact storage and proxy
logs as well as the database.

| Upgrade                             | Required action                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v5 to wire/schema v6                | Clean break: retain a private old database backup, use a new database, configure agents, re-register browsers, and re-pair. Replace tenant routes and old workspace/target tools                                |
| DomAgent 6.1 to BananaBrowse beta.1 | Rename `DOMAGENT_*` settings to `BANANABROWSE_*`, update package/service paths, replace the extension, re-register browsers, and re-pair. Wire/schema stay at 6; existing configured key values can be retained |
| BananaBrowse beta.1 to beta.2       | Rebuild/update the service and extension. Wire/schema, registrations, pairings, and sessions are preserved; no migration or re-pairing. `query_all` needs extension 0.9.0.2                                     |

Do not claim old DomAgent extensions interoperate with BananaBrowse. Update MCP
URLs and gateway path rules to `/mcp/<agent-id>`, and rediscover tools after
upgrading.

## 8. Validation and remaining qualification

Current extension minimums are Chrome/Chromium **145+** and Firefox **153+**,
not the candidate minimums from the original proposal. Private-beta ZIPs are
unpacked Chrome extensions and unsigned temporary Firefox add-ons; store
distribution and durable installation must be qualified separately.

The implementation's `bananabrowse-extension/test/README.md` documents:

- Service, extension, and UI unit tests, build, and syntax checks.
- Real Chrome extension pairing, approval, background groups, actions,
  handoff, close requests, disconnect/reopen, and simulated restart matching.
- Native Firefox 153+ extension tests, including full browser restart and
  same-session/tab reattachment.
- `query_all` in both page engines, covering shadow roots, redaction, URL
  handling, Unicode budgets, field errors, and unchanged focus/scroll/refs;
  app-window fixtures exercise it through the MCP service and extension.

These are described test surfaces, not new test results from this documentation
update. Podman with `mcr.microsoft.com/playwright:v1.58.2-noble` supports
page-helper and Chrome extension tests without host browser installation.
Native Firefox extension tests still require an official Firefox 153+ binary;
Playwright's bundled Firefox is not a substitute for that extension test.

Remaining acceptance checks include real Chrome session restore, physical
permission prompts, OS notification visibility, installation/key persistence,
protected-origin enforcement and declared capabilities in supported browsers,
and actual credential-gateway routing for each advertised BananaClaw provider.
Generic per-session network approval is an extension point, not implemented
policy. Do not promise arbitrary egress consent or a network sandbox.
