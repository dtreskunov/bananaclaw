# Credential gateway via an Agent Vault fork

**Status:** proposal (alternative). **Date:** 2026-10-15. **Revision 2:** the
gateway is headless. Credentials are managed in NanoClaw's agent group settings
through a gateway admin API, and the operator configures the gateway through
`.env`. Agent Vault's web UI and email/password accounts are not used.
**Revision 3:** one vault per agent group. Keys shared between groups are
duplicated ([§6.2](#62-keys-shared-across-groups)). **Revision 4:** R1 scope cut
([§1.1](#11-r1-scope)): no copying between groups, no agent requests, no
approvals or separate rules, and no activity view. **Revision 5:** network
restrictions leave R1, MCP sign-in with dynamic client registration scoped per
agent group becomes the first deliverable, and OAuth apps (Google and similar)
are configured per group in the UI instead of `.env`. **Revision 6:** OAuth
apps can be install-wide (set by an owner in the UI) with per-group overrides,
and MCP servers without dynamic registration (e.g. GitHub's) sign in through
those apps.

This proposal reaches the same goals as
[credential-gateway-proposal.md](credential-gateway-proposal.md) (the "native
proposal") but takes a different route. Instead of porting ideas to TypeScript,
**fork [Infisical Agent Vault](https://github.com/Infisical/agent-vault) and run
it as the gateway service.** Several parts of the native proposal carry over
unchanged:

- §1, goals and non-goals
- §2.1, the topology, lifecycle and trust model
- §4.6, the agent contract

This document covers only what differs.

## 1. Decision summary

- **What to fork:** Agent Vault v0.40.0 (commit `872578e4cdf9`) into
  `dtreskunov/agent-vault`, on a `bananaclaw` branch.
- **How to run it:** as `nanoclaw-gateway`, a single static Go binary.
- **Where new code goes:** NanoClaw-specific and MCP features go into **new
  packages**, with small hooks in core files. Each change is offered upstream.
- **Headless gateway:**
  - The fork drops Agent Vault's web UI and human accounts (registration,
    email/password login, invites, SMTP) (F10).
  - Its only client is the NanoClaw host, using an instance-owner agent token
    created at first boot.
  - Nothing about the gateway is exposed publicly.
- **Configuration:** operators set instance-level settings (master password,
  private-network allowlist, OAuth redirect URL, retention) in `.env`. Day-to-day
  credential management lives in **group settings → Credentials** in the
  NanoClaw UI, backed by the gateway admin API.
- **What NanoClaw keeps or adds:**
  - spawn integration
  - the in-container relay
  - the Credentials tab and MCP-tab integration
  - the OAuth callback relay
  - the setup skill
- **What NanoClaw doesn't build:** a vault, a certificate authority (CA) or a
  proxy.
- **First step:** a time-boxed spike ([§9](#9-plan)) with explicit go/no-go
  criteria before any rollout work.

### 1.1 R1 scope

| In R1                                                                                                                                                                                                                                                                                                                                                                                         | Deferred                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP sign-in with dynamic client registration, scoped per agent group** (F4, F11). This is the first deliverable: each group's vault registers its own OAuth client with each MCP authorization server and holds its own tokens.                                                                                                                                                             | **Network restrictions:** blocking requests to hosts without a key, hosts allowed without a key, per-group private-network allowlists (F5 and the Network view). In R1, requests to hosts without a key always go through a blind tunnel (F2), and private addresses are reachable only through the operator's `AGENT_VAULT_NETWORK_ALLOWLIST`. |
| **Keys:** add (from presets or for any host), replace, edit, delete. Each key has exactly one destination (`host[:port][/path-glob]`) and one way it's sent; there's no separate rules list.                                                                                                                                                                                                  | **Copying keys between groups** and setting a key in several groups at once (F12). Each group's keys are entered in that group.                                                                                                                                                                                                                 |
| **OAuth apps and accounts:** Google, GitHub and similar providers without dynamic registration. An owner or global admin sets an **install-wide** app in the UI that every group uses; a group admin can set the group's **own** app instead (F11). The same apps serve **MCP servers without dynamic registration**, such as GitHub's (F4). Token-endpoint stubs for stdio MCP servers (F8). | **Agent requests:** the agent asking for a key or account through proposals (`request_credential`). In R1, a missing credential returns the gateway's error and the agent tells the user to add it in group settings.                                                                                                                           |
| MCP-tab sign-in status row, `ncl credentials`, per-group switch to the gateway                                                                                                                                                                                                                                                                                                                | **Approvals and fine-grained rules** (F3): ask-before-calling, per-method/path rules, pause/resume, several destinations per key, and the chat approval bridge                                                                                                                                                                                  |
|                                                                                                                                                                                                                                                                                                                                                                                               | **Activity view** of proxied requests (the gateway still keeps its request log); **clients for MCP authorization servers outside the provider catalog** that support neither dynamic registration nor a client metadata document                                                                                                                |

## 2. What upstream already provides

Verified against the pinned commit:

- **Code:** 181 Go files (~1.15 MB) and 58 test files (~0.84 MB).
- **Activity:** 17 contributors, 53 commits in the last 90 days, roughly monthly
  releases.
- **License:** MIT. LICENSE mentions `ee/` directories, but none exist.

| Capability            | Upstream                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault                 | AES-256-GCM. A data key (DEK) is wrapped by a key derived from a master password with Argon2id. Agents with the proxy role can never read values.                                                                          |
| CA                    | Root key encrypted with the data key and stored in the DB; ECDSA P-256 leaves valid 24 h, kept in an LRU cache                                                                                                             |
| Proxy                 | CONNECT with TLS interception, plain-HTTP forwarding, streaming responses, WebSocket, size limits, slow-client timeouts                                                                                                    |
| Injection             | Services matched on `host[:port][/path-glob]`. Auth types: `bearer`, `basic`, `api-key` (header + prefix), `custom` (header templates), `passthrough`. Placeholder substitution in header, query, path, body or WebSocket. |
| OAuth                 | "Connect" with any provider (authorization code + PKCE) or pasted tokens; refresh 5 min before expiry, with concurrent refreshes merged                                                                                    |
| Network guard         | Each dialed IP is checked as the connection is made (defeats DNS rebinding). Cloud metadata IPs are always blocked; private ranges are blocked unless allowlisted.                                                         |
| Agent-raised requests | **Proposals:** the agent asks for a service or credential slot, and a human approves. Pending proposals expire after 7 days; approval can be done over the API by a vault `admin`/`member`.                                |
| Identity              | Users and agents with instance roles; per-vault roles `admin`, `member` and `proxy`; **scoped sessions** with the proxy role (5 min–7 d) minted by a privileged agent                                                      |
| Operations            | REST API (agent tokens with the right roles can do everything the UI does), CLI, request log with retention, rate limiting, SQLite (pure Go) or Postgres                                                                   |
| Not useful to us      | React admin UI and human accounts (register/login, invites, password reset, SMTP), container isolation for `vault run` (iptables, needs `NET_ADMIN`), Infisical sync, PostHog telemetry (on by default)                    |

## 3. Architecture

```mermaid
flowchart LR
  subgraph C["Agent container (no credentials)"]
    T["tools · SDKs · MCP clients"] --> R["egress-relay<br/>:3128 ⇄ egress.sock"]
  end
  subgraph H["NanoClaw host"]
    S["spawn"]
    PR["MCP probe → sign-in"]
    GS["Group settings → Credentials<br/>/api/groups/:gid/admin/credentials/*"]
    CB["/ui/oauth/callback relay<br/>/oauth/client-metadata.json"]
  end
  subgraph AV["nanoclaw-gateway (Agent Vault fork)"]
    SL["F1 socket listener<br/>(bound scoped session)"]
    M["MITM / forward<br/>F2 blind tunnels"]
    API["admin + agent API<br/>(headless, F10)"]
    VT[("vault · CA · OAuth")]
  end
  S -- "POST /v1/socket-sessions" --> API
  R == "per-session Unix socket" ==> SL --> M --> VT
  M --> NG["netguard"] --> UP["Upstreams"]
  PR --> API
  B["Admin browser"] -- "NanoClaw login" --> GS
  GS -- "owner-agent token" --> API
  B -- "OAuth redirect" --> CB -- "F11 complete(code, state)" --> API
```

**How NanoClaw concepts map onto Agent Vault:**

| NanoClaw / OneCLI                             | Agent Vault                                                                                                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The NanoClaw host process                     | Agent `nanoclaw-host` with the instance `owner` role and vault `admin` on every vault, created at first boot (F10). Values stay write-only (F6).                                                                                  |
| A session                                     | A socket-bound scoped session (F1), revoked when the session ends                                                                                                                                                                 |
| Which credentials a group can use             | **One vault per agent group**, named after the group ID (`ag-…`). Keys shared between groups (e.g. OpenRouter) are duplicated in each vault (§6.2). OneCLI agents are already one per group, so their grants carry over directly. |
| OneCLI secret + host/path pattern             | Credential + service                                                                                                                                                                                                              |
| OneCLI app connection                         | OAuth credential plus services for each API host                                                                                                                                                                                  |
| Owner/admin managing or approving credentials | NanoClaw roles, enforced by the host (§6). The gateway sees only the host's owner-agent token.                                                                                                                                    |
| `request_credential` tool                     | Deferred (§1.1). Later: an Agent Vault proposal created through the socket (F1 API passthrough), using upstream's agent skill.                                                                                                    |

## 4. Fork changes

Sizes are estimates of new code. "Core diff" is the change to existing upstream
files, which is what causes merge conflicts.

| #   | Change                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                   | Size / core diff                          | Upstream?                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| F1  | **Socket-bound sessions** (details below)                                                                                                                                                                                                                                                                                              | Identity comes from the socket, with no token in the container ([why](credential-gateway-proposal.md#2-architecture)) | M / small                                 | Yes: generic for local orchestrators |
| F2  | **Blind tunnels:** if no service in the session's vault matches the CONNECT host, splice raw TCP through the network guard instead of terminating TLS. Setting `unmatched_host_mode = tunnel \| mitm \| deny`; NanoClaw uses `tunnel` for every vault in R1.                                                                           | Certificate-pinned clients and bulk downloads work; less traffic is inspected                                         | S / small (`handleConnect`)               | Yes                                  |
| F3  | **Deferred past R1.** **Per-request approvals:** services get `approval: allow` or `ask` plus `(method, path-glob)` rules. An `ask` holds the request, publishes it on `GET /v1/approvals?wait=`, and is decided by `POST /v1/approvals/{id}` from a vault member or the host agent with an `approver` flag. A timeout counts as deny. | Parity with OneCLI approval cards                                                                                     | M / small (hook in `forwardRequest`)      | Yes                                  |
| F4  | **MCP OAuth** (details below)                                                                                                                                                                                                                                                                                                          | The main new feature                                                                                                  | L / small                                 | Yes                                  |
| F5  | **Deferred past R1.** **Network guard additions:** also block NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4, Teredo and the host's own IPs (ported from smokescreen, MIT); per-vault private allowlist                                                                                                                                | Closes IPv6 bypasses; lets the Home Assistant LAN host be allowed for one group only                                  | S / small (`netguard.go`)                 | Yes                                  |
| F6  | **Instance setting `reveal_disabled` (required):** turns off `credential get --reveal` and `list --reveal` for every role, including owners                                                                                                                                                                                            | The host's owner token must not be able to read values                                                                | S / small                                 | Likely                               |
| F7  | **Sealed bindings:** a credential's allowed hosts are part of its ciphertext's authenticated data, so services can only reference it on those hosts                                                                                                                                                                                    | Needed only for topology B (separate VM)                                                                              | M / medium                                | Maybe                                |
| F8  | **Token-endpoint stubs:** a service type for `oauth2.googleapis.com/token` and similar that answers refresh requests carrying the placeholder refresh token with a synthetic token, without contacting the upstream                                                                                                                    | stdio MCP servers using credential stubs (Gmail, Calendar)                                                            | S / small                                 | Maybe                                |
| F9  | **Fork hygiene:** telemetry off by default plus a `notelemetry` build tag; a CI check that fails if an `ee/` directory appears                                                                                                                                                                                                         | Privacy, license safety                                                                                               | XS / tiny                                 | No                                   |
| F10 | **Headless mode** (details below)                                                                                                                                                                                                                                                                                                      | No second UI or login; configured through `.env`                                                                      | M / small (route registration, bootstrap) | Maybe: "API-only server"             |
| F11 | **OAuth redirect relay and OAuth apps (install-wide and per vault)** (details below)                                                                                                                                                                                                                                                   | The NanoClaw UI hosts the browser-facing OAuth endpoints, so the gateway stays private                                | S / small (`handle_oauth.go`)             | Yes                                  |
| F12 | **Deferred past R1.** **Copying credentials inside the gateway:** `POST /v1/vaults/{dst}/credentials/copy {from_vault, keys}` re-encrypts within the gateway, so values never leave it. Copies record `copied_from` (vault, key, time). Static credentials only.                                                                       | Duplicating shared keys into another group without re-entering them (F6 blocks reading them back)                     | S / none (new package on the store API)   | Maybe                                |

**F1 details.**

- **Minting:** `POST /v1/socket-sessions {vault, label, dir}`, authenticated with
  the host agent's token, mints a proxy session and binds `<dir>/egress.sock`.
  `dir` must sit under `AGENT_VAULT_SOCKET_ROOT`.
- **Lifetime:** the session renews itself internally until `DELETE`, working
  around the 7-day cap.
- **The socket listener:**
  - serves CONNECT and plain-HTTP forwarding,
  - ignores `Proxy-Authorization` and always uses the bound session,
  - is exempt from rate limiting the same way loopback peers are,
  - passes requests for the reserved host `agent-vault.internal` to the API, so
    agents can call `/discover` and create proposals.

**F10 details.**

- **UI and accounts off:** `AGENT_VAULT_HEADLESS=true` (also a `noui` build tag)
  stops serving `web/` and turns off user register/login, invites, password
  reset and SMTP.
- **Bootstrap:** on first boot the gateway creates the `default` vault and the
  instance-owner agent `nanoclaw-host` (vault `admin`). It writes that agent's
  token to `AGENT_VAULT_BOOTSTRAP_TOKEN_FILE` (0600).
- **Token rotation:** `agent-vault agent rotate nanoclaw-host` on the gateway
  machine.
- **Loading `.env`:** `--env-file <path>` loads **only** `AGENT_VAULT_*` keys,
  so NanoClaw's other secrets in the same `.env` never reach the gateway's
  environment.

**F11 details.**

- **Redirect target:** `AGENT_VAULT_OAUTH_REDIRECT_URL` replaces upstream's
  hard-coded `<baseURL>/v1/oauth/callback`.
- **Relay endpoint:** `POST /v1/oauth/complete {state, code}` returns JSON
  instead of redirecting to Agent Vault's UI.
- **Client metadata:** `GET /v1/oauth/client-metadata` returns the CIMD document
  for NanoClaw to publish.
- **Issuer binding:** the completion relay accepts `{state, code, iss?}`.
  NanoClaw forwards the callback's `iss`; the gateway requires and validates it
  when the authorization server advertises RFC 9207 support.
- **OAuth apps, at two levels:**
  - **Install-wide:** `PUT /v1/oauth-apps/{provider} {client_id, client_secret?}`
    and `DELETE`. Stored in a reserved vault that no socket session can bind.
  - **Per vault:** `PUT /v1/vaults/{vault}/oauth-apps/{provider} …` and
    `DELETE`. Overrides the install-wide app for that vault.
  - **Resolution:** a connect or sign-in uses the vault's app, else the
    install-wide one. Each account records which client it was issued to, and
    refreshes always use that client.
  - **Changing or deleting an app** revokes and removes the accounts issued to
    that client (across all vaults for the install-wide app).
  - **Secrets** are stored like any credential and are write-only (F6).
- **Provider catalog:** each provider's issuer, endpoints and scope sets (with
  the API hosts each unlocks) are built into the gateway, so admins only enter a
  client ID and secret. Google and GitHub first. Catalog entries also list known
  MCP servers that sign in through the provider (GitHub's
  `api.githubcopilot.com/mcp`).

**F4 details.**

- **New proposal and credential kind** `mcp_oauth { resource_url }`.
- **Discovery:** RFC 9728 (protected resource), then RFC 8414 (authorization
  server), falling back to OIDC discovery.
- **Client registration, scoped per vault:** dynamic registration (RFC 7591)
  first. Each vault registers its own client with each authorization server, so
  a group's client and tokens are never used by another group, and removing a
  group's sign-in or vault can't affect others.
  - The registration (client ID, secret if issued, registration access token) is
    stored in the vault, keyed by issuer.
  - An `invalid_client` answer triggers one re-registration and a new sign-in.
  - **Fallbacks,** if the server doesn't offer registration:
    1. **A configured OAuth app** whose catalog issuer matches the authorization
       server: the vault's own, else the install-wide one (F11). This is how
       GitHub's MCP server works.
    2. **The install's client metadata document** (CIMD, published by
       NanoClaw, F11). The client identity is then shared across the install,
       but tokens stay per vault.
  - **Otherwise** the sign-in fails with `registration_unsupported`. When a
    catalog provider matches the issuer, the probe reports it, so the UI can
    offer to set up that app before the first sign-in.
- **Sign-in:** PKCE plus `resource` (RFC 8707). Refreshes include `resource`.
- **Result:** a service auto-created for the MCP URL's host and path prefix.
- **Hiding the challenge:** strips `resource_metadata` from 401s on MCP services,
  so in-container SDKs don't start their own OAuth flow.
- **Reused code:** the `oauthex` package is vendored from the
  [MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk) v1.8.0 (MIT moving
  to Apache-2.0; NOTICE kept). It provides resource/auth-server metadata,
  `ParseWWWAuthenticate`, `RegisterClient` and CIMD validation. Vendoring avoids
  pulling in the SDK's dependency tree.

**Not changed:**

- **Error format:** NanoClaw adopts upstream's codes (`service_not_found` hints,
  `oauth_not_connected`, `oauth_refresh_failed`, `credential_not_found`) instead
  of patching them.
- **Locked-down egress:** comes from NanoClaw's `--network none` plus F1, not
  from upstream's iptables-based isolation.
- **Topology B transport:** a host-side forwarder adding a per-session token in
  `Proxy-Authorization` is upstream's normal mode, so it needs no transport
  change.

## 5. Operator configuration (`.env`)

Instance-level settings are environment variables. The gateway unit runs
`agent-vault server --env-file <nanoclaw>/.env`, which reads only `AGENT_VAULT_*`
keys (F10). Edit `.env`, then run `systemctl --user restart nanoclaw-gateway`.
On a separate VM (topology B), a local `.env` works the same way.

Secrets can be given as `*_FILE` variants (added by F10), pointing at systemd
`LoadCredential=` files encrypted with `systemd-creds`. Plain values in `.env`
also work, but are then stored unencrypted on disk.

| Setting           | Variable                                 | This install                                                          |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| Headless mode     | `AGENT_VAULT_HEADLESS`                   | `true` (required)                                                     |
| Master password   | `AGENT_VAULT_MASTER_PASSWORD_FILE`       | `systemd-creds` credential; passwordless mode is not used             |
| Host token output | `AGENT_VAULT_BOOTSTRAP_TOKEN_FILE`       | `data/agent-vault/host-token`                                         |
| Socket root       | `AGENT_VAULT_SOCKET_ROOT`                | `data/agent-vault/sessions`                                           |
| Write-only values | `AGENT_VAULT_REVEAL_DISABLED`            | `true` (required)                                                     |
| OAuth redirect    | `AGENT_VAULT_OAUTH_REDIRECT_URL`         | `<UI_BASE_URL>/oauth/callback`                                        |
| Unmatched hosts   | `AGENT_VAULT_UNMATCHED_HOST_MODE`        | `tunnel` (fixed in R1; no per-group setting)                          |
| Private networks  | `AGENT_VAULT_NETWORK_ALLOWLIST`          | `10.0.1.103/32` (NextCloud), plus Home Assistant; operator-only in R1 |
| Telemetry         | `AGENT_VAULT_TELEMETRY`                  | `false`                                                               |
| Request logs      | `AGENT_VAULT_LOGS_MAX_AGE_HOURS`         | `720`                                                                 |
| Rate limiting     | `AGENT_VAULT_RATELIMIT_PROFILE`          | `default`                                                             |
| Listeners         | `AGENT_VAULT_ADDR` and listener settings | Loopback only; no reverse-proxy route to the gateway                  |

**Host side:**

- `NANOCLAW_GATEWAY_URL` (default `http://127.0.0.1:14321`) and
  `NANOCLAW_GATEWAY_TOKEN_FILE` tell NanoClaw where the gateway is.
- The host token file is read only by the host's gateway client. It is never
  mounted into containers.

## 6. NanoClaw changes (this repo)

- **Spawn:**
  - [container-runner.ts](../src/container-runner.ts) replaces
    `onecli.applyContainerConfig` with `POST /v1/socket-sessions` for the
    group's vault (`ag-<id>`).
  - It mounts the socket directory and the CA bundle and sets the proxy and CA
    env, as in native §4.1.
  - A failure refuses the spawn, as today.
- **Group lifecycle:**
  - Creating an agent group creates its vault.
  - Deleting a group deletes its vault.
  - Archiving a group keeps its vault so a restore works.
- **Relay:** `container/agent-runner/src/egress-relay.ts`, the same as in the
  native proposal.
- **Gateway client:** `src/modules/credentials/agent-vault-client.ts` is the
  only code that holds the host token. The UI server, `ncl` and spawn go
  through it.
- **Approvals:** none in R1. OneCLI approval cards
  ([onecli-approvals.ts](../src/modules/approvals/onecli-approvals.ts)) keep
  working for groups still on OneCLI.
- **MCP OAuth trigger:** the existing MCP **Test** action
  (`/mcp-servers/test`) and `mcp-probe` notice a 401 that carries
  `resource_metadata`. The MCP tab then offers **Connect**.
- **Container skill:** `onecli-gateway` is replaced by `credential-gateway`,
  which explains the gateway's error codes and tells the agent to ask the user to
  add a missing key or account in group settings → Credentials.
  [upload-trace.ts](../container/agent-runner/src/upload-trace.ts) is updated
  for those codes.
- **Host-side calls:** the former OneCLI proxy helper was used only for the
  public OpenRouter model catalog. That metadata now uses an explicitly
  unauthenticated fetch in [models-catalog.ts](../src/ui/server/chat/models-catalog.ts).
  Any future authenticated host caller must have an explicit scoped credential
  path, not an implicit default-agent fallback.
- **Stubs** are written by the host. They contain no secrets.
- **`ncl credentials`** (host only,
  [credentials.ts](../src/cli/commands/credentials.ts)): `list`, `set`
  (adds a key or replaces its value/destination; the value only via
  `--value-stdin`), `delete`, `disconnect` (MCP sign-ins); P4 adds
  `oauth-app set|remove [--install] --secret-stdin`. The dispatcher rejects
  every `credentials` command from containers regardless of `cli_scope`.
- **Setup:** `/init-agent-vault` replaces `/init-onecli`. It:
  - downloads a pinned release binary and verifies its SHA-256,
  - writes the unit with `--env-file`,
  - adds the `AGENT_VAULT_*` defaults from §5 to `.env`,
  - creates the encrypted master password,
  - starts the service, picks up the bootstrap token and creates a vault for
    each existing agent group.

  There are no user accounts and no public route to the gateway.

- **Uninstall and `/debug`:** updated for the new service.

### 6.1 Group settings → Credentials

There's a new `credentials` tab in
[GroupAdmin.tsx](../src/ui/client/chat/src/components/GroupAdmin.tsx), hidden
until `credentialsUiEnabled` is on. The MCP server editor
([GroupAdminMcp.tsx](../src/ui/client/chat/src/components/GroupAdminMcp.tsx))
gains a **Sign-in** row for HTTP servers. It shows whether the server uses a key
or a sign-in and offers **Sign in**, or links to the key in Credentials.
Routes extend the existing `/api/groups/:gid/admin/*` dispatcher in
[group-admin.ts](../src/ui/server/chat/group-admin.ts).

The UI uses plain-language names: **keys** (a gateway credential plus the one
service that sends it), **accounts** (OAuth connections and MCP sign-ins) and
**OAuth apps** (a group's own clients for providers without dynamic
registration, shown under Accounts). The wire contract is in
[GroupAdminCredentialsApi.ts](../src/ui/client/chat/src/components/GroupAdminCredentialsApi.ts),
and a mocked fixture of the whole tab is described in
[ui.md](ui.md). All routes are under `…/admin/credentials`:

| View     | Shows / does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Host routes                                                                                                                                                                                      | Gateway API                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Keys     | Name, key name, needs-value status, where it's sent and how, last used. Add (preset or any host), replace the value, edit the name or destination, delete.                                                                                                                                                                                                                                                                                                                                                                                  | `POST /keys {key, label, value, destination}`, `PUT /keys/:key {value?, label?, destination?}`, `DELETE /keys/:key`                                                                              | Set/delete the credential and its single service (no reveal, F6) |
| Accounts | MCP sign-ins (marked when the group has its own registered client or used an OAuth app) and OAuth accounts: status, access, last used; connect, change access, reconnect, disconnect. **OAuth apps** section: which app applies (install-wide or this group's), client ID, accounts using it; set up (owners choose install-wide or this group, with the redirect URI to copy), edit, use the group's own app, remove. Connecting a provider, or signing in to an MCP server, that needs an app that isn't set up leads into setting it up. | `POST /accounts/start` → `{state, authorizeUrl}`, `GET /accounts/start/:state`, `DELETE /accounts/:key`, `PUT /oauth-apps/:id {scope, clientId, clientSecret?}`, `DELETE /oauth-apps/:id?scope=` | F4, F11                                                          |

`GET /credentials` returns everything the tab needs in one call, including the
MCP servers' sign-in status that the MCP tab shows. When the gateway is down,
every route answers `503 {error: "gateway_unreachable"}`, and the tab shows an
operator hint instead of data.

**OAuth callback.** There are two UI-server routes:
[oauth-callback.ts](../src/ui/server/oauth-callback.ts).

- `GET /ui/oauth/callback` is the redirect URL
  (`AGENT_VAULT_OAUTH_REDIRECT_URL=<UI_BASE_URL>/oauth/callback`). It sits under
  `/ui` because the session cookie is scoped to `Path=/ui`.
- `GET /oauth/client-metadata.json` publishes the gateway's client metadata
  document (F11) at the origin, where its client ID points.

- **Start:** `POST …/credentials/accounts/start` records `state → (user, group)`
  in host memory with a 10-minute expiry and returns the authorize URL, which the
  UI opens in a popup. A host restart only means signing in again.
- **Callback:** completes only for the **same signed-in NanoClaw user**. A
  signed-out browser goes to the login page and comes back.
  - It forwards `{state, code, iss}` (or `{state, error, iss}` when consent was
    declined) to `POST /v1/oauth/complete`. A `200` can still report
    `status: "failed"`, e.g. `issuer_mismatch`.
  - It posts `nanoclaw-oauth-complete` to the same-origin opener, which reloads
    the tab; the progress route `GET …/accounts/start/:state` covers a lost
    message.
  - The page sends no referrer, isn't cached and runs one nonce-locked script,
    because its URL carried the authorization code.
- **Why this is safe:**
  - **No account injection:** a leaked authorize link can't bind someone else's
    account, because the callback only completes for the user who started it.
  - **The host can't redeem the code:** the PKCE verifier and client secret
    never leave the gateway.

**Permissions** (enforced by the host; the gateway trusts the host token). Each
vault belongs to exactly one group, so the rules follow NanoClaw's group roles:

- **Viewing the tab or changing the group's own vault** (keys, accounts, the
  group's own OAuth apps): a scoped admin of the group, an owner or a global
  admin.
- **Install-wide OAuth apps:** owners and global admins only. Scoped admins see
  which install-wide app applies but can only override it for their group.
- **Handling of values:**
  - never returned by any route,
  - request bodies containing values are never logged,
  - NanoClaw's audit log records only actor, action and key.

### 6.2 Keys shared across groups

- **Duplication is explicit.** Each group's vault holds its own copy, so a key
  set in one group can never be used by another. That's stronger isolation than
  shared vaults would give.
- **In R1, each group's keys are entered in that group.** Rotating a shared key
  means replacing it in every group that has it. Copying between groups and
  fan-out updates (F12) are deferred (§1.1).
- **OAuth connections are not copied.** Providers that rotate refresh tokens
  would make the copies invalidate each other. Each group connects its own
  account instead:
  - Providers usually remember consent, so re-connecting an already-approved
    account is typically one click.
  - Google allows up to 100 refresh tokens per account per OAuth client, which
    is plenty for this install's groups even when they reuse one client.
- **OAuth apps are shared by default.** An install-wide app is entered once and
  used by every group without its own. Only the client is shared: each group
  connects its own accounts and keeps its own tokens. A group that needs a
  separate client (different consent screen, quota or owner) sets its own.
- **MCP clients are never shared.** With dynamic registration each vault
  registers its own client (F4), so there's nothing to duplicate.

## 7. Maintaining the fork

- **Branch model:** the `bananaclaw` branch is rebased onto each upstream release
  tag. Fork commits are kept as one commit per F-change.
- **Code placement:** new code goes in `internal/nanoclaw/`, `internal/mcpauth/`,
  `internal/approval/` and `internal/sockets/`. Core files get only short hooks
  behind interfaces.
- **Upstream PRs:** F1–F6 and F10–F11 are offered upstream once the spike is
  green. Every accepted PR removes fork surface.
- **CI on every sync:**
  - upstream `go test ./...`, `govulncheck`, `go vet`
  - NanoClaw contract tests (spawn → socket → injection → approval)
  - builds for linux/amd64, linux/arm64 and darwin/arm64
  - signed `SHA256SUMS`
- **Supply chain:** this mirrors the pnpm policy.
  - Builds use `go.sum` with `-mod=readonly`.
  - New modules need human approval.
  - Dependency diffs are reviewed at each sync.
  - `golang.org/x/*` updates are accepted only through upstream syncs.
- **Cadence:** sync within 7 days of an upstream release, and immediately for
  security fixes.

## 8. Migrating the current OneCLI inventory

| Current (OneCLI)                                                                           | Agent Vault service                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bearer `Authorization` (MiniMax ×3, Vercel AI Gateway, Apify, Linear, OpenRouter)          | `bearer`                                                                                                                                                 |
| Path-scoped bearer: domagent `/mcp/bananaclawz`, budget `/http`, Home Assistant `/api/mcp` | `bearer` with a path glob                                                                                                                                |
| NextCloud `Basic {value}` (pre-encoded)                                                    | `custom`: `Authorization: Basic {{ NEXTCLOUD_MCP }}`, path `/mcp/*`                                                                                      |
| Seattle Open Data `X-App-Token`                                                            | `api-key` with header `X-App-Token`                                                                                                                      |
| Tavily query parameter `tavilyApiKey`                                                      | Query substitution; the MCP URL becomes `…/mcp/?tavilyApiKey=__TAVILY_API_KEY__`                                                                         |
| `anthropic` type (api.anthropic.com, api.minimax.io)                                       | `api-key` with `x-api-key`, or a `custom` Bearer + beta header for OAuth tokens. Merge the two overlapping api.minimax.io entries.                       |
| 7 Google apps × 2 accounts                                                                 | One OAuth credential per account with the union of scopes, connected in each group that uses it (§6.2); the gateway adds one service per Google API host |

**How the migration runs:** `scripts/migrate-from-onecli.ts` reads
`onecli secrets list` and each OneCLI agent's grants (metadata only). OneCLI
agents are one per group, so for each group it creates that group's keys with
their destinations and no values.

- The operator sets each value under **Credentials → Keys** (shown as **Needs a
  value**) or with `ncl credentials set --value-stdin`, once per group that
  uses it.
- Google accounts are connected per group from **Credentials → Accounts**.

## 9. Plan

**Spike (go/no-go before anything else):** build F1, F2 and the F10 bootstrap,
with a minimal NanoClaw integration (spawn and the egress relay) for one canary
group whose vault is configured with Agent Vault's own CLI. The work split and
interface contract are in
[credential-gateway-spike.md](credential-gateway-spike.md).

| Criterion    | Pass if                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functional   | Anthropic or MiniMax, Tavily (query), NextCloud (custom Basic), domagent (path-scoped), Linear MCP and blind tunnels (models.dev, GitHub) all work |
| Fork surface | ≤ 300 changed lines in upstream files (F1, F2, F10 together); the rest in new packages                                                             |
| Syncability  | Rebases cleanly onto upstream `main` at spike end; upstream tests pass                                                                             |
| Overhead     | Added p50 latency on the intercepted path < 5 ms on the host                                                                                       |
| Ops          | Static binary; headless, unattended boot from `.env` with an encrypted master password; no listener reachable from outside the host                |

**If the spike fails, fall back to the native proposal.** Its building-block
analysis still applies.

**Phases after a go:**

| Phase         | Scope                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1            | Foundation: F1, F2 (unmatched hosts always tunnelled), F6, F9, F10, socket rebinding after gateway restarts, NanoClaw host gateway client, per-group vaults and `credential_backend = onecli \| agent-vault` |
| P2            | **MCP sign-in with per-group dynamic registration:** F11 redirect relay, F4, Credentials tab with Accounts (MCP sign-ins) turned on for gateway groups, MCP-tab sign-in row, probe trigger                   |
| P3            | Credentials → Keys, `ncl credentials`                                                                                                                                                                        |
| P4            | OAuth apps (F11): install-wide and per-group, Google accounts and GitHub's MCP server through its app; F8 stubs                                                                                              |
| P5            | Migration script, cutover                                                                                                                                                                                    |
| P6            | Remove OneCLI                                                                                                                                                                                                |
| P7 (after R1) | Deferred features (§1.1): F5 and network restrictions, F3 approvals and the chat bridge with per-call rules, F12 copying between groups, agent requests, activity view, manually entered MCP clients         |
| P8 (optional) | Topology B (forwarder + upstream token mode) plus F7 and the tighter host role (§11)                                                                                                                         |

R1 is P1–P6. Each phase has the same exit criteria as the native proposal's
matching phase.

## 10. Comparison with the native proposal

|                            | Agent Vault fork                                                                                       | Native (TypeScript)                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Code to write              | NanoClaw integration and Credentials UI, MCP OAuth, headless mode                                      | Proxy, CA, vault, OAuth, plus all of the left |
| Test coverage from day one | Upstream suite (~0.84 MB of tests)                                                                     | Only what we write                            |
| Admin UI                   | NanoClaw group settings → Credentials (gateway is headless)                                            | NanoClaw group settings → Credentials         |
| Security fixes             | Cherry-picked from upstream                                                                            | Ours alone                                    |
| Language and toolchain     | Go, a second supply-chain policy                                                                       | TypeScript, existing pnpm policy              |
| Control over the design    | Shaped by upstream's model (one vault per session, so one vault per group with duplicated shared keys) | Full                                          |
| Topology B                 | Transport native to upstream; admin still flows through the host (§11)                                 | Has to be built                               |

## 11. Risks and open questions

1. **Upstream drift.** Agent Vault is pre-1.0, and Infisical sells an enterprise
   edition. Features could move to `ee/` or the architecture could change.
   - **Mitigation:** the MIT snapshot stays usable indefinitely.
   - **Mitigation:** keep the fork small.
   - **Mitigation:** the F9 CI check catches `ee/` changes.
2. **Duplicated shared keys.** Rotating a shared key means replacing it in
   every group that has it, by hand in R1.
   - **Later options:** copy and fan-out (F12, deferred), or a "layered vaults"
     fork change that removes the duplication.
3. **The host holds an instance-owner token.**
   - **What a compromised host could do:** set values, retarget services and
     create vaults.
   - **What it couldn't do:** read values, because of F6.
   - **Topology A:** this matches the existing trust model (the host already
     controls Docker).
   - **Topology B:** narrow it:
     - the host token gets only vault `member` (no instance owner),
     - vault creation and deletion move to the gateway CLI on the VM,
     - F7 sealed bindings stop services being retargeted to other hosts.
4. **Headless mode is fork surface.** F10 touches route registration and
   bootstrap. If upstream doesn't accept an API-only mode, it's carried long
   term, so keep it to a build tag plus one bootstrap package.
5. **The master password protects data at rest only.** With topology A, a
   compromised host can still read process memory. This is the same trust model
   as native §2.1.
6. **Go expertise is needed** for reviewing upstream syncs.
7. **No approvals in R1.** Any granted key is used without asking. Groups that
   need human approval for credentialed actions stay on OneCLI until F3 lands.
8. **No network restrictions in R1.** An agent can reach any public host without
   a key, as it can through OneCLI today. Private addresses stay blocked unless
   the operator allowlists them in `.env`, and that allowlist applies to every
   group on the gateway.
9. **Dynamic registration leaves clients behind.** Each group registers its own
   client with every MCP authorization server it signs in to. Deleting a sign-in
   or a group deletes the client with RFC 7592 when the server supports it;
   otherwise the client is just forgotten, which most servers expire on their
   own.
10. **An install-wide OAuth app is a shared dependency.** Rotating or deleting
    it disconnects every group's accounts that use it, and provider quotas and
    limits (e.g. Google's 100 refresh tokens per account per client) apply
    across those groups. A personal Google client can stay unverified; its
    owner sees Google's "unverified app" screen when signing in.
    Project-owned clients shipped with BananaClaw are ruled out: each install
    has its own redirect domain, the secret would be public, and Gmail's
    restricted scopes would need Google's verification and a recurring
    security assessment.
