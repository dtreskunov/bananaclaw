# Agent Vault gateway releases and upgrades

## Coordinated release: NanoClaw 2.5.0 and gateway gw-v0.2.0

[Revision 7 of the plan of record](credential-gateway-agent-vault-fork-proposal.md)
supersedes the published release's group-owned credential-management model.
It is a coordinated host/gateway/runner/schema release. The reviewed gateway
pin is `gw-v0.2.0`, source `9a99f613d54bec30cc3709351277d39de2f3fe6e`.
The former `gw-v0.1.1` binary does not implement this contract.

The release introduces native AgentVault managed users and personal libraries,
user-owned static/OAuth connections, connection-scoped OAuth refresh/client
lifecycle, explicit group grants and a top-level Credentials tab. Native users
remain non-login authorization principals; the host transport agent and
effective user are separately authorized/audited. Group proxy sessions must
not bind personal libraries or inherit the host's owner permissions.

Do not ship compatibility adapters for earlier fork iterations: remove the
old group-owned management routes/DTOs, vault-local ownership/refresh/cleanup
paths, obsolete catalog/scope translations and runtime schema/key aliases.
F12 copying and fan-out rotation are cut, not fallback upgrade mechanisms.

Preserve deployed state through a reviewed, bounded **offline** conversion and
explicit owner/recipient mapping. Move existing authorizations without
exporting/cloning tokens or changing their issuing client/scopes; update F8
bindings with the same deployment. The converter is not a permanent startup
migration, runtime fallback or retained maintenance feature. Remove it from the
shipped surface after acceptance; retain protected backups and safe receipts.

Require native-user/non-login tests, effective-user authorization, cross-group
reference denial, concurrent shared refresh, independent grant revocation,
group deletion without upstream disconnect, scope-change review and real
provider/MCP acceptance. Rollback restores matching stopped-service databases,
binaries and affected assets/configuration together, never a binary-only
downgrade. Do not change live services merely because this plan was updated.

The remaining sections describe the published contract and its verified
historical rollout; they are not the target revision-7 management API.

### Canonical host API and CLI

The revision-7 host exposes `/ui/chat/api/credentials` for the signed-in user's
connections, accessible groups and configured OAuth apps. Connection CRUD and
OAuth start/progress live below `/credentials/connections` and
`/credentials/sign-ins`; group settings use `/groups/:gid/admin/access`.
The former group-owned `/admin/credentials/*` management routes are removed,
not aliases to the new API.

The host provisions native managed users through `/v1/managed-users` using a
database-persisted installation UUID and stable NanoClaw user subject. Role,
membership and deletion changes enter a durable synchronization queue;
startup reconciliation precedes container adoption and subsequent updates
retry explicitly. A gateway without the canonical API is a contract mismatch,
not a reason to fall back to group-local writes.

Host-only CLI operations select an existing NanoClaw user explicitly:

```bash
ncl credentials list --user <user-id>
ncl credentials create --user <user-id> --label Search --kind static \
  --services '[{"name":"search","host":"api.example.com/search","auth":{"type":"bearer","token":"SEARCH_KEY"}}]' \
  --values-stdin < /secure/search-values.json
ncl credentials grant --user <user-id> --id <connection-id> --group <group-id> \
  --services '["search"]'
ncl credentials revoke --user <user-id> --id <connection-id> --group <group-id>
ncl credentials start --user <user-id> --id <oauth-connection-id>
```

The values file is a private key/value JSON object; do not put values in
arguments, audit records or examples. Update/delete operations require the
connection's exact `--revision`. OAuth completion is bound to the initiating
user, mapped native user and authoritative connection ID; a successful callback
does not grant an agent access automatically.

The old `credentials set`, vault-local key-set/provision commands and spike-era
`NANOCLAW_AGENT_VAULT_GROUPS` override are not supported by this contract. Backend
cutover remains an explicit operator action until OneCLI retirement is complete.

### Real host-to-gateway contract check

The gateway's opt-in Go bridge starts an ephemeral server with fresh test state
and a mode-0600 synthetic host-token file. It launches the actual NanoClaw
client modules against that server, covering managed users, two-group sharing,
revision-checked rotation, recipient detach, strict ownership, private/install
apps and role/deletion synchronization:

```bash
# Run in the AgentVault source checkout, using a private existing TMPDIR.
AGENT_VAULT_NODE_INTEGRATION_SCRIPT=/path/to/nanoclaw/scripts/test-shared-gateway.ts \
AGENT_VAULT_NODE_INTEGRATION_RUNNER=/path/to/nanoclaw/node_modules/.bin/tsx \
go test -race ./internal/server -run '^TestManagedGatewayNodeBridge$' \
  -count=1 -timeout=120s
```

The Node harness rejects live default ports and token files outside its test
temporary root. It does not read the deployed bootstrap token, modify the
central live DB or start/restart a service. This check is not a substitute for
reviewed offline adoption, release provenance or operator-approved provider
acceptance. PostgreSQL runtime acceptance remains a separate release check.

### Reviewed release checksums

| Target      | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------ |
| Linux amd64 | `45d49615f380f5b7b0b4e7cec4e4bafbca5a514ccdb594e33b6cb55fd0949633` |
| Linux arm64 | `187097aed926dae42335112e0b55f3d1f9c3b77a37cccebf7f96e7bbb668df05` |
| macOS arm64 | `295a0624f52f8df49a68e70746707683aa6f41b0d83d46e680f32f65c3cbe047` |

`versions.json` and the setup verifier pin these exact assets. Verify the
published tag-bound provenance before installing. The prior release details
below are historical and do not override the current source/hash pin.

## Catalog-free OAuth breaking update

This checkout requires the generic OAuth app/account contract. There is no
provider catalog, capability negotiation or old-gateway fallback. Gateway and
NanoClaw updates must be coordinated; `gw-v0.1.0` cannot serve this host's OAuth
management UI. Do not downgrade an already migrated gateway to that binary.

The sanctioned **`gw-v0.1.1`** release, source
`32f233b2ebc53786ab4e74b28fc4ef6d75e674e9`, includes catalog-free OAuth and
conditional atomic key sets. It replaces the separately authorized
`gw-v0.1.1-dev` canary; that earlier local build was not an attested release.
The release passed the full clean-CI suites, race tests, vet, three-platform
builds, checkout/archive reproducibility and exact-configuration vulnerability
scans. Its signed binary and checksum-manifest provenance were independently
verified with GitHub CLI 2.103.3 against the exact source, tag and workflow.

### Configure and use apps

Agent Settings → Credentials enumerates configured apps. Add an arbitrary
canonical app ID and safe OAuth configuration JSON: issuer, client ID,
authorization/token endpoints, exact `api_hosts`, `default_scopes`, token-auth
method and optional authorization parameters/identity settings. Enter a
confidential-client secret only in the separate write-only field. Public clients
use `token_endpoint_auth_method:"none"`. MCP-only apps can omit OAuth endpoints
and API hosts. Owners/global admins can manage install-wide apps; scoped admins
manage their group's override. Removing an override exposes the install app for
future sign-ins, without changing its existing accounts.

CLI equivalents (host only):

```bash
ncl credentials oauth-app set --group <group-id> --app <app-id> \
  --config '{"issuer":"https://auth.example.com","client_id":"public-client","token_endpoint_auth_method":"none"}'
ncl credentials oauth-app remove --group <group-id> --app <app-id>
```

For confidential clients, supply the secret via `--secret-stdin`, never in the
JSON or arguments. Add `--install` only for an intentional install-wide change.
Omitted update fields retain their values.

Account sign-in requests actual OAuth scopes; an empty scope field explicitly
requests none. Displayed metadata distinguishes provider-reported, requested,
legacy and unknown provenance. Requested scopes are not an independent gateway
permission filter, and requesting fewer does not guarantee revoking old grants.
Tokens authenticate every HTTPS path on their configured API hosts; provider
permissions still apply. MCP authorizations retain resource-scoped routing.

Existing account keys, encrypted tokens, issuing-app bindings and F8 files
survive the gateway migration. An endpoint 401/403 alone is not proof of
disconnection. Agent Vault groups must not be sent to the OneCLI dashboard.

### Rollout and rollback

Back up state and matching binaries/assets before deployment. Validate app
enumeration, scoped versus owner reads, reconnect/default/empty scope requests,
callback user/state binding, nullable identity and existing F8 placeholders.
Read-only identity/public-repository checks do not authorize inspecting private
repositories or changing any provider grant.

The gateway migration is transactional and precedes listeners. Rollback requires
stopping the gateway and restoring the matching previous database and binary
together; binary-only rollback is not assumed safe. Preserve the host token,
password source, CA, socket root and configuration. See the gateway's
`docs/guides/oauth-apps.mdx` for the deployed contract and migration details.

## Published release

`/init-agent-vault` installs the headless gateway from
[`dtreskunov/agent-vault`](https://github.com/dtreskunov/agent-vault/releases/tag/gw-v0.1.1).
It does not replace OneCLI for every group or perform consent on the operator's
behalf. A release being published does not mean the live canary was upgraded.

## Pin and verification

[`versions.json`](../versions.json) pins `agent-vault-gateway` to `gw-v0.1.1`.
[`setup/agent-vault-release.ts`](../setup/agent-vault-release.ts) binds that pin to
source `32f233b2ebc53786ab4e74b28fc4ef6d75e674e9`, platform assets and reviewed
SHA-256 hashes:

| Platform    | Asset                                | SHA-256                                                            |
| ----------- | ------------------------------------ | ------------------------------------------------------------------ |
| Linux amd64 | `agent-vault_gw-v0.1.1_linux_amd64`  | `474b807a88bb227901d5fa03c9cc1ec90a2f69573ce46af4d476fd14f906c9e6` |
| Linux arm64 | `agent-vault_gw-v0.1.1_linux_arm64`  | `70d619482c0a931b1cd5f33f8d8b0b616017f811f7e9bc788616c6eb35d04c79` |
| macOS arm64 | `agent-vault_gw-v0.1.1_darwin_arm64` | `c1db265b207574459126a3d438de4e86cab727ef96620bdbb56587e7de08c7a1` |

These are standalone binaries, not archives. Other platforms fail explicitly.
New pins require reviewed source and hash metadata; changing only the version
cannot silently install unreviewed bytes.

Use a recent GitHub CLI supporting `gh attestation verify`, `--bundle`,
`--source-ref`, `--source-digest` and `--deny-self-hosted-runners`. An old CLI
(such as 2.46) is not evidence that verification passed. Provision a supported
verifier through the operator's trusted tooling channel before proceeding.

From the repository root, choose a **new**, absolute staging path:

```bash
pnpm exec tsx setup/agent-vault-release.ts /absolute/private/path/gateway-staging
```

The helper downloads the explicit version's platform binary, `SHA256SUMS`,
`build-provenance.jsonl`, project license and MCP SDK license/NOTICE. It checks
the binary against both the hardcoded reviewed hash and the release manifest,
then verifies signed provenance with:

- Repository `dtreskunov/agent-vault`.
- Signer workflow `dtreskunov/agent-vault/.github/workflows/gateway-release.yml`.
- Source ref `refs/tags/gw-v0.1.1` and the full source commit above.
- GitHub-hosted rather than self-hosted build runners.

Any verification failure aborts. The helper never installs a binary, changes
configuration, starts a new gateway or restarts a service. Do not execute staged
bytes until it succeeds. Retain the verification files and license notices
alongside the installed release.

`version` reports `gw-v0.1.1`; commit/build-time fields remain `unknown` and Go
module metadata may be `(devel)`. These are intentional reproducible-build
properties. The tag and signed provenance bind source, not those fields.

## Detect an existing installation

Inspect the service's executable, working directory, HOME, environment-file
paths and password-input mechanism without logging secrets. On Linux, useful
non-secret checks are:

```bash
systemctl --user show agent-vault.service \
  --property=FragmentPath --property=ExecStart --property=MainPID
agent-vault version
```

Inspect only relevant non-secret settings from the actual configuration.
Do not dump `.env`, the process environment, password files or the host token.
Record privately (without their contents):

- Master-password source, including any encrypted service credential.
- Database and CA paths (default database: `~/.agent-vault/agent-vault.db`).
- `AGENT_VAULT_BOOTSTRAP_TOKEN_FILE` and its permissions.
- `AGENT_VAULT_SOCKET_ROOT`, current socket bindings and network allowlist.
- OAuth redirect, API address and listener addresses.

Read vault, account, service and socket-session metadata through NanoClaw's
gateway client to establish a pre-upgrade baseline. Never request reveals.

## Required runtime policy

Preserve these settings during every upgrade:

```dotenv
AGENT_VAULT_HEADLESS=true
AGENT_VAULT_REVEAL_DISABLED=true
AGENT_VAULT_UNMATCHED_HOST_MODE=tunnel
AGENT_VAULT_OAUTH_REDIRECT_URL=https://your-nanoclaw-origin.example/ui/oauth/callback
```

The redirect must exactly match NanoClaw's configured UI origin and the OAuth
app's registered callback. Retain the existing bootstrap-token path, socket root,
master-password input, database, CA and the approved network policy, including
`AGENT_VAULT_ALLOW_PRIVATE_RANGES=true` where explicitly authorized. Keep API/proxy
listeners on localhost. Do not change process-level overrides incidentally.

For fresh setup, explicitly configure the token and socket paths. The gateway
creates the host token on first boot and validates it on later boots. Missing
or invalid existing state is an error to investigate, not permission to rotate
the token or initialize a new database.

## Approved upgrade sequence

1. Verify the release into staging **before** stopping anything.
2. Obtain operator approval for the live upgrade. Confirm this is the same
   instance, service and working directory.
3. Retain the old executable. Stop the discovered gateway service and confirm
   it is inactive.
4. Make a private, consistent database backup while stopped, including any WAL
   files still present. Preserve the CA, bootstrap token, service configuration,
   `.env` and encrypted password source in a private backup, without printing
   their contents. Record file digests privately to verify configuration and
   host-token preservation.
5. Install the verified executable to a sibling staging filename, mode 0755,
   and atomically rename it over the existing executable. Do not overwrite a
   running inode in place. Keep release provenance and licenses in a private
   versioned installation directory.
6. Start the **same** service, with the same configuration. Do not restart
   NanoClaw or change any group's backend just to upgrade the gateway.
7. Check the installed SHA-256, `version`, service readiness and authenticated
   metadata API. Compare pre/post vaults, accounts, services and socket-session
   bindings; verify socket listeners have rebound. Compare the host-token and
   configuration digests without disclosing contents. Allow ordinary timestamps
   and request usage to move.
8. Test a real existing agent connection with operator approval. Google/GitHub
   consent acceptance is a separate operator action, not implied by readiness.

### Rollback

If readiness or state checks fail, stop the gateway, restore the previous
executable atomically and start the same service. Preserve failure diagnostics
without exposing tokens. If state itself was changed incompatibly, keep the
failed state for diagnosis and restore the consistent stopped-service backup
with explicit operator approval. Never run old and new gateways against the
same database or socket root simultaneously. Do not rotate the token, remove
the database or create a fresh installation as a recovery shortcut.

## OAuth completion and remaining acceptance

Verified account labels come from the gateway's `account` field. Existing
accounts do not acquire an identity merely by upgrading; `account:null` is
legitimate, including when a new identity check fails. Do not infer identity
from an unverified claim or expose stable internal subjects.

The same verified provider account may reconnect under its existing key.
Provider-reported scopes remain authoritative; never blindly union requested
scopes into grants. NanoClaw retains the completion's returned `key` in sign-in
progress and reloads the overview after completion; it must not append a
presumed new account or invent a new key. Reconnect/disconnect actions use
the keys in that reloaded overview.

The existing canary completed real Google/GitHub consent and F8 stdio acceptance
using `av-refresh:<key>` / `av-access:<key>`. Preserve those keys and files.
Under that published contract, new target vaults still require their own
credential entry, authorization and workload acceptance; release verification
does not establish those outcomes. Revision 7 replaces repeated entry and
authorization with explicit grants to owned connections, while retaining
per-group workload acceptance.

### F8 stdio wiring

For an Agent Vault group, reuse the existing stdio servers and write only the
connected account's placeholders into their configured token files. Obtain the
actual key from the gateway's current account list, not a presumed newly
generated key. Keep provider app secrets in the gateway; installed-client
credential files may contain inert `agent-vault-managed` ID/secret placeholders.
Do not pass the host bootstrap token into a server or container.

Google token schemas differ by client:

| Client               | Token record                             | Placeholder fields                                                 |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Gmail autoauth       | Flat object                              | `access_token`, `refresh_token`, `expiry_date`                     |
| Cocal Calendar       | Account map, e.g. `normal`               | `access_token`, `refresh_token`, `expiry_date` inside that account |
| Piotr Agier Drive v2 | `accounts.<alias>` plus `defaultAccount` | `accessToken`, `refreshToken`, `expiryDate` inside that account    |

Set access to `av-access:<key>` and refresh to `av-refresh:<key>`. For initial
refresh acceptance, set expiry to a positive expired timestamp such as `1`.
Zero can mean "expiry absent" and skip proactive refresh in some clients.
Subsequent refreshes must still return only synthetic placeholders; clients
may persist their synthetic future expiry normally. Scope metadata must reflect
the granted scopes, not pretend that ungranted scopes are available.

For a GitHub stdio server, its existing `GITHUB_PERSONAL_ACCESS_TOKEN` env value
can be `av-access:<github-account-key>`; API injection uses the corresponding
gateway-generated services. This does not turn the placeholder into a usable
GitHub token outside that vault's scoped proxy.

Keep the normal scoped socket, gateway CA and proxy environment. The F8 token
endpoint derives interception from account-pinned metadata and the persistent
authority registry, even in unmatched-host tunnel mode. Do not disable TLS validation, give a test container unrestricted
network access or route these clients back through OneCLI.

Back up existing files privately before changes. If they contain real tokens
rather than known placeholders, stop and coordinate migration instead of
overwriting them. Preserve each group's isolation, token-file modes and other
MCP settings. Persist MCP env changes in the central DB, not only materialized
`container.json`. Prevent legacy setup scripts from overwriting the new stubs.

Validate synthetic refresh, unknown/wrong-provider/cross-vault rejection,
tool discovery, and operator-approved read-only calls. Report counts rather
than private results and remove test sockets/containers afterward. A direct
MCP check is not a model-planned agent conversation. Rollback restores only
the backed-up group files and intended config entry, not other groups' rows or
the gateway database.

For the completed live canary evidence, see
[F8 stdio acceptance](credential-gateway-spike.md#r1-f8-local-stdio-mcp-acceptance-2026-10-27).

The release is built with `noui,notelemetry,noinfisical`. External-store access
is explicitly unavailable. Release vulnerability evidence applies to this
gateway build, not ordinary Infisical-enabled upstream builds.
