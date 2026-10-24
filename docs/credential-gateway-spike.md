# Credential gateway spike: work split and contract

**Status:** fork and NanoClaw sides built and tested; canary pending.
**Date:** 2026-10-20, results 2026-10-21. This is the go/no-go spike from
[§9 of the Agent Vault fork proposal](credential-gateway-agent-vault-fork-proposal.md#9-plan).
The pass criteria are listed there.

## Work split

| Workstream   | Repository / branch                                                         | Scope                                                                                                                          |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Fork**     | `dtreskunov/agent-vault`, branch `bananaclaw` (local clone `~/agent-vault`) | F10 headless and bootstrap, F1 socket sessions, F2 blind tunnels, build, upstream tests, fork-surface and latency measurements |
| **NanoClaw** | `dtreskunov/bananaclaw`, branch `credential-gateway`                        | Spawn integration behind a per-group switch, in-container egress relay, canary setup                                           |

The two sides only meet at the contract below. Change it here first, then in
code.

## Toolchain

- `sudo apt install golang-go` installs Go 1.24 on Debian 13.
- That's enough: the fork's `go.mod` asks for Go 1.25, and the `go` command
  (with `GOTOOLCHAIN=auto`, Debian's default) downloads the matching toolchain on
  the first build, checksum-verified against `sum.golang.org`.
- No version manager is needed. To pin an exact toolchain, add a `toolchain`
  line to `go.mod`.
- Use only the modules already in `go.sum`. Adding a new one needs human
  approval.

## Contract

### F10: headless server and bootstrap

- **Starting:** `agent-vault server --env-file <nanoclaw>/.env` reads **only**
  `AGENT_VAULT_*` keys from that file. `*_FILE` variants read the value from a
  file, e.g. `AGENT_VAULT_MASTER_PASSWORD_FILE`.
- **Headless mode:** `AGENT_VAULT_HEADLESS=true` serves no web UI and turns off
  user registration, login, invites, password reset and SMTP. The REST API stays
  available to agent tokens.
- **Bootstrap (first boot):**
  - Create the instance-owner agent `nanoclaw-host` and write its token to
    `AGENT_VAULT_BOOTSTRAP_TOKEN_FILE` (mode 0600).
  - On later boots, never rotate it silently.
  - If the agent exists but the file is missing, fail with a message telling
    the operator to run `agent-vault agent rotate nanoclaw-host`.
- **Listeners:**
  - The API and the TCP MITM listeners bind to `127.0.0.1` only.
  - NanoClaw reads the CA from the existing `GET /v1/mitm/ca.pem`.
- **Vault names:** each vault is named after its agent group ID (e.g.
  `ag-1780956116163-prz9h2`), which is already a valid slug. The host token
  creates the vaults and is `admin` on each one.

### F1: socket sessions

All calls use `Authorization: Bearer <host token>`.

| Call                              | Body / response                                              | Errors                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/socket-sessions`        | `{vault, label, dir}` → `201 {id, vault, socket_path}`       | `400` `dir` is not an existing absolute directory under `AGENT_VAULT_SOCKET_ROOT` (checked after resolving symlinks); `404` unknown vault; `403` the host isn't a vault member; `409` `dir` is already bound |
| `GET /v1/socket-sessions`         | `200 {items: [{id, vault, label, socket_path, created_at}]}` |                                                                                                                                                                                                              |
| `DELETE /v1/socket-sessions/{id}` | `204`; removes the socket file and revokes the session       | `404`                                                                                                                                                                                                        |

Listener behavior:

- **Socket:** the gateway binds `<dir>/egress.sock` with mode 0666, because
  containers may run with other UIDs.
- **Identity:** every connection acts as a `proxy`-role session scoped to that
  vault, which the gateway renews itself until `DELETE`.
  `Proxy-Authorization` is ignored and stripped.
- **Accepted requests:** HTTP `CONNECT` and absolute-form plain-HTTP proxy
  requests, with the same injection, network-guard and logging as the TCP MITM
  listener. Not subject to the per-IP flood gate.
- **Gateway restarts:** sessions survive and their sockets are rebound in the
  same directories. Optional for the spike, required in P1.
- **API passthrough (optional for the spike):** requests to host
  `agent-vault.internal` go to the API as that session, for `/discover` and
  proposals.

### F2: blind tunnels

- **Setting:** `unmatched_host_mode` is `tunnel`, `mitm` or `deny`, per vault.
  The default comes from `AGENT_VAULT_UNMATCHED_HOST_MODE`, and the spike uses
  `tunnel`.
- **On `CONNECT host:port`**, if no service in the session's vault matches that
  host and port (on any path):
  - `tunnel`: splice raw TCP through the network-guard dialer without
    terminating TLS, and log host, port, bytes, duration and decision `tunnel`.
  - `deny`: answer `403` before hijacking the connection.
  - `mitm`: keep upstream's current behavior.
- **If any service matches the host**, intercept TLS, as upstream does today.

### R1 P2: OAuth completion relay

The authenticated host relays the public callback to
`POST /v1/oauth/complete {state, code, iss?}`. Forward `iss` unchanged when
the authorization server supplies it. For servers advertising
`authorization_response_iss_parameter_supported=true` (including Linear),
the gateway requires `iss` to match the issuer pinned in the sign-in state.
Missing or mismatched issuers fail the flow. Providers that do not advertise
this support may omit `iss`; a supplied issuer must still match.

## NanoClaw side

- **Switch:** `NANOCLAW_AGENT_VAULT_GROUPS=<group ids>` (spike only) moves those
  groups to the gateway. Every other group keeps OneCLI.
- **Spawn:** create `data/agent-vault/sessions/<16-hex hash of the container name>/`
  (container names make Unix socket paths exceed 108 bytes) and call
  `POST /v1/socket-sessions`.
  - **Mounts:** the directory at `/run/nanoclaw/egress`, and a combined CA
    bundle (system CAs plus the gateway root) read-only.
  - **Env:** `HTTPS_PROXY`/`HTTP_PROXY` (both cases) = `http://127.0.0.1:3128`,
    `NO_PROXY=localhost,127.0.0.1`, `NODE_USE_ENV_PROXY=1`, and the same CA
    variables as upstream's `internal/isolation/env.go`.
  - **Network:** `--network=none`, with or without egress lockdown. The
    gateway socket is the container's only way out.
  - **Env precedence:** these variables override provider contributions (e.g.
    OpenCode's `NO_PROXY` exception for `models.dev`, which is reached by a
    blind tunnel instead).
  - **On failure:** the spawn is refused.
  - **On container exit** (including adopted containers, failed starts and MCP
    probes): `DELETE` the socket session and remove its directory. Host
    startup revokes sessions whose container is gone.
- **Relay:** the agent-runner listens on `127.0.0.1:3128` and pipes each
  connection to `/run/nanoclaw/egress/egress.sock`. It starts before anything
  else in `index.ts` and `mcp-probe.ts`. Bun (1.3) can't keep TCP half-open,
  so a client that sends FIN before reading its reply loses it; HTTP and TLS
  clients don't do this.
- **Gateway service:** a user-level `agent-vault.service` with
  `--env-file`, plus these `.env` defaults:
  - `AGENT_VAULT_HEADLESS=true`
  - `AGENT_VAULT_BOOTSTRAP_TOKEN_FILE=data/agent-vault/host-token`
  - `AGENT_VAULT_SOCKET_ROOT=data/agent-vault/sessions`
  - `AGENT_VAULT_UNMATCHED_HOST_MODE=tunnel`
  - `AGENT_VAULT_TELEMETRY=false`
  - a master password file

## Canary

- **Group:** "My Agent" (`ag-1780956116163-prz9h2`). It has no MCP servers and
  no OneCLI grants, so the spike adds what its checks need.
- **Vault setup:** with the gateway REST API and the host token, create vault
  `ag-1780956116163-prz9h2` and set its credentials and services. Agent
  Vault's CLI can't do this headlessly yet (see results).
  These cover the model provider key, Tavily (query substitution), NextCloud
  (custom `Basic {{ … }}` header), domagent (path-scoped bearer) and Linear MCP.
- **Values:** OneCLI can't export secret values, so the operator enters each
  one (`POST /v1/credentials`, read from a prompt, never echoed).
- **MCP servers:** added to the group with `ncl groups config add-mcp-server`.

## Deliverables

- **Fork:**
  - The fork commits on `bananaclaw`, one commit per F-change.
  - A static build (`CGO_ENABLED=0`) of the binary.
  - `go test ./...` passes.
  - `git diff --stat 872578e -- $(upstream files)` stays within 300 lines.
  - A clean rebase onto upstream `main`.
  - A p50 latency comparison: intercepted path through the socket vs. a direct
    call.
- **NanoClaw:** the switch, spawn integration, relay, service unit and the
  canary checklist with results.
- **Out of scope:** the UI backend, approvals (F3), OAuth (F4, F11), copying
  keys (F12), write-only values (F6), migration.

## Results

### Fork (`~/agent-vault`, commits `a29af13`, `53bae61`, `d141569`; not pushed yet)

Independently re-verified on this host:

- **Build:** the static `CGO_ENABLED=0` build links statically.
- **Tests:** `gatewayconfig`, `headless`, `blindtunnel` and `socketsessions`
  pass.
- **Latency:** added p50 is 0.29 ms (fork report: 0.39 ms; limit 5 ms).
- **Fork surface:** 183 changed lines in 13 upstream files (144 of them code);
  everything else is in new packages.

Not implemented, as allowed for the spike: rebinding sockets after a gateway
restart (until P1, a gateway restart cuts egress for running canary containers
until they respawn) and the `agent-vault.internal` API passthrough.

### End to end (real gateway binary, real container image)

Run in an isolated `HOME` on non-default ports. A container with
`--network=none` got its mounts and env from `applyAgentVaultEgress`, plus the
new relay:

| Check                             | Result                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Headless startup                  | Token file 0600; UI and registration routes 404; both listeners on 127.0.0.1 only                   |
| Injection                         | The upstream received the real key, never the placeholder; certificate issued by Agent Vault's root |
| Blind tunnel                      | `example.com` returned 200 with its own public certificate (no interception)                        |
| Bun `fetch` through the proxy     | 200                                                                                                 |
| Direct egress bypassing the proxy | Blocked (no network)                                                                                |
| Cloud metadata IP via the proxy   | 502 (network guard)                                                                                 |
| Cleanup on release                | Socket session revoked and directory removed                                                        |

### Findings for the fork

1. **The CLI can't administer a headless gateway.** `vault create` and the
   `vault service` commands only use a human login session, and
   `AGENT_VAULT_TOKEN_FILE` (documented in `docs/guides/nanoclaw-gateway.mdx`)
   isn't read by the CLI at all. The REST API works with the host token.
   - **Fix options:** let those commands accept `AGENT_VAULT_TOKEN` and
     `AGENT_VAULT_TOKEN_FILE`, or correct the guide and use the REST API.
2. **The fork commits aren't pushed.** `origin/bananaclaw` is still at
   `872578e`.

### NanoClaw (`credential-gateway` branch)

- `src/agent-vault-egress.ts` adds the switch, socket-session lifecycle, CA
  bundle and container arguments.
- `container/agent-runner/src/egress-relay.ts` is the in-container relay.
- **Tests:** 7 for the host module against a fake gateway, 5 for the relay,
  and the existing `container-runner` tests pass.

### Canary on the live install (2026-10-21)

**Setup:**

- **Gateway service:** `agent-vault.service` (user unit) runs the fork binary
  from `~/.local/bin`, with working directory `~/nanoclaw-v2` and
  `--env-file .env`. NanoClaw's unit gets a `Wants=`/`After=` drop-in for it.
- **Master password:** encrypted with `systemd-creds --user`. This systemd
  (257) can't load user-scoped credentials into a user unit (`Permission
denied`), so the unit decrypts it with `systemd-creds --user decrypt` and
  pipes it to `--password-stdin`.
- **Canary vault:** "My Agent" has five services (MiniMax custom headers,
  Tavily query substitution, NextCloud custom Basic, bananabrowse bearer, Linear
  bearer) and four MCP servers. Keys were entered with a hidden-prompt script.

**Two bugs only the live install exposed, both fixed:**

1. **Socket path length.** Session directories named after containers made
   socket paths exceed 108 bytes. They're now named with a 16-hex hash of the
   container name.
2. **Probes never exited.** The relay's keep-alive sockets kept the MCP probe
   alive after it printed its result, so every probe timed out. Relayed
   sockets are now unref'd.

**Private address:** `nextcloud-mcp.adsoconsulting.org` resolves to
`10.0.1.103` from this host, which the network guard blocks.
`AGENT_VAULT_NETWORK_ALLOWLIST=10.0.1.103/32` allows it, for every vault until
F5 adds a per-vault allowlist. OneCLI doesn't block private addresses.

**Results:**

| Check                             | Result                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Model (MiniMax M3, Anthropic API) | 200 through the gateway                                                                |
| Tavily MCP (query substitution)   | OK, 5 tools                                                                            |
| NextCloud MCP (custom Basic, LAN) | OK, 136 tools                                                                          |
| bananabrowse MCP                  | 401: the gateway injected `DOMAGENT_TOKEN`, upstream rejected it; works through OneCLI |
| Linear MCP                        | 401: the gateway injected `LINEAR_API_KEY`, upstream rejected it; works through OneCLI |

The request log shows both 401s matched their service and had the key
injected, with the same `Bearer {value}` format OneCLI uses. So the stored
values differ from OneCLI's; re-entering them is the next step.

**Still to check:** a real conversation with "My Agent", and behavior across a
gateway restart (sockets aren't rebound until P1).

### R1 P2: MCP sign-in (2026-10-22)

**Fork:** `176bb39` (F11) and `dd51e1d` (F4) on `bananaclaw`, pushed. The
guide is `docs/guides/mcp-oauth.mdx` in the fork.

**NanoClaw:**

- [agent-vault-client.ts](../src/modules/credentials/agent-vault-client.ts)
  is now the only reader of the host token; egress uses it.
- [credentials-admin.ts](../src/ui/server/chat/credentials-admin.ts) serves
  group settings → Credentials for gateway groups:
  - MCP sign-in start, progress and disconnect.
  - The overview: MCP sign-ins, plus each HTTP MCP server's status from the
    vault's accounts, its services, and a cached gateway probe.
  - Keys: add, replace, edit and delete since P3 (below).
  - OAuth apps answer 501 until P4.
- [oauth-callback.ts](../src/ui/server/oauth-callback.ts) serves
  `/ui/oauth/callback` and `/oauth/client-metadata.json`.
- The tab appears for admins of groups listed in
  `NANOCLAW_AGENT_VAULT_GROUPS`.

**Verified:**

- **Route tests** against a fake gateway:
  - the callback is bound to the same user
  - `iss` is forwarded and a mismatch fails
  - a declined consent is forwarded
  - the gateway being down gives a 503
  - probes are cached
- **The isolated P2 binary**, driven through the client module:
  - Linear probes as `registered`.
  - Two vaults get **different client IDs**, both with PKCE S256, `resource`
    and the `/ui` redirect.
  - A bogus state gives `invalid_state`, and disconnecting an unknown account
    gives 404.
- **Found for P4:** probing GitHub's MCP server
  (`https://api.githubcopilot.com/mcp/`) fails with `discovery_failed`. The
  gateway rejects its protected-resource metadata. NanoClaw shows such servers
  as "no key or sign-in".

**Live acceptance (2026-10-22, passed).** Deployed fork `4065e67` (P2 plus
per-group `client_name`) and NanoClaw `9e4fb6600` to the canary. Cross-acct
Test was moved to the gateway as the second group.

1. **Sign-in:** Denis signed in to Linear from My Agent and Cross-acct Test.
   Linear's consent screen showed each group's name. Each vault got its own
   `registered` client, an `MCP_…` account and generated `mcp.linear.app/mcp`
   services.
2. **Test connection:** passed in both groups (Linear MCP, 68 tools). Each
   vault's `last_used_at` moved at its own test.
3. **Real tool call:** a container with no Linear credential, using each
   group's socket session, called `list_teams` and got the real team.
4. **Disconnect:** Cross-acct Test was disconnected through
   `DELETE …/credentials/accounts/:key`. Its generated services were removed,
   and its calls now get `401` with no `resource_metadata`. My Agent's call
   still returns the team.

### R1 P3: keys and `ncl credentials` (2026-10-22)

- **Shared logic:** [keys.ts](../src/modules/credentials/keys.ts) adds,
  replaces, edits and deletes static keys, each stored as one credential plus
  the one service that sends it. The Credentials tab routes and
  `ncl credentials` both use it.
- **How keys map to gateway services:**
  - Service names are slugs of the key's name, since the gateway only accepts
    slugs.
  - A query-string key becomes a passthrough service that swaps a URL
    placeholder (default `__KEY__`) for the value.
  - Basic auth sends the value as the username.
  - When only the host changes, auth details the form can't show (such as
    MiniMax's second header) are kept.
- **Protecting other services:** each edit rewrites the vault's whole service
  list under a per-group lock and keeps the services generated for MCP sign-ins.
  The fork has been asked for per-service writes, which would remove that race.
- **Rollback:** if saving a new key's service fails, its credential is deleted
  again.
- **`ncl credentials list|set|delete|disconnect`** is host-only, and values
  arrive only through `--value-stdin`.
- **Verified:**
  - Route, CLI and dispatcher tests pass.
  - Every injection type round-trips through an isolated real gateway.

### R1 P4: OAuth apps, provider accounts and atomic keys (2026-10-24)

**Fork (`a2d567b` on local `bananaclaw`, not pushed yet):**

- `cddcaa2`: OAuth apps (install-wide and per vault), the provider catalog and
  provider accounts.
- `6953e17`: atomic static keys and per-service writes.
- `0d6487b`: F8 token-endpoint stubs.
- Two GitHub fixes and an upstream merge.
- Guides: `oauth-apps.mdx`, `static-keys.mdx` and `oauth-token-stubs.mdx`.

**NanoClaw (`165d783dc`):**

- **Keys:** written with the atomic `PUT|DELETE /v1/vaults/{v}/keys/{KEY}`.
  This replaces the whole-service-list rewrite and the manual rollback. Keys
  now show updated and last-used times.
- **Credentials → Accounts:**
  - Shows the catalog with each provider's install-wide and group app.
  - Owners and global admins set install-wide apps; group admins set the
    group's own.
  - Google and GitHub accounts connect and disconnect through the existing
    callback.
  - MCP servers like GitHub's stop showing "needs an app" once an app exists.
- **CLI:** `ncl credentials oauth-app set|remove [--install]` reads the
  secret from `--secret-stdin`. `list` and `disconnect` now cover provider
  accounts.

**Verified:**

- **Tests:** 79 route, CLI and dispatcher tests against a fake gateway.
- **Isolated build of `a2d567b`:**
  - The fork's `internal/...` tests pass, except the Podman-socket isolation
    test, which fails for host-environment reasons.
  - Key add, rename/retarget and value-only update work; a duplicate gives
    409 and a missing key gives 404.
  - Setting an install-wide app as a scoped admin gives 403, and a new client
    ID without a secret gives 400.
  - The GitHub MCP probe answers `registration_unsupported` without an app and
    `client:"app"` with one.
  - Google sign-in starts with the group's client, the requested scopes,
    `access_type=offline` and the `/ui` redirect.
- **Live canary (gateway binary built from `a2d567b`):**
  - The gateway upgrade kept My Agent's Linear sign-in, and a real `list_teams`
    call still works.
  - An atomic key add, rename and delete through `ncl` left no stray service.

**Pending:**

- **Live Google and GitHub consent:** needs real OAuth apps created by the
  operator in the provider consoles.
- **F8 on the host side:** writing `av-refresh:<key>` / `av-access:<key>`
  placeholders into stdio MCP configs.
