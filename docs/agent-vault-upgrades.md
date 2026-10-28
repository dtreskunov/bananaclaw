# Agent Vault gateway releases and upgrades

## Catalog-free OAuth breaking update

This checkout requires the generic OAuth app/account contract. There is no
provider catalog, capability negotiation or old-gateway fallback. Gateway and
NanoClaw updates must be coordinated; `gw-v0.1.0` cannot serve this host's OAuth
management UI. Do not downgrade an already migrated gateway to that binary.

The current operator-authorized canary runs **`gw-v0.1.1-dev`**, source
`8c240e88dd41032e85e11727a65a3dd3b0efec70`, Linux amd64 SHA-256
`0ff5c55cf8d187b9387fcf0afdd0f4cdb5a17fbb0c8505765ca30c21c45cda13`.
This is a local dev deployment: no tag, published release, signed release
provenance or consumer attestation verification was produced. The historical
published release pin below is not a compatible generic-OAuth installation.
Setup must stop until a compatible reviewed release is pinned; do not invent
release URLs or treat the dev binary as an attested release.

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

## Historical published release

`/init-agent-vault` installs the headless gateway from
[`dtreskunov/agent-vault`](https://github.com/dtreskunov/agent-vault/releases/tag/gw-v0.1.0).
It does not replace OneCLI for every group or perform consent on the operator's
behalf. A release being published does not mean the live canary was upgraded.

## Pin and verification

[`versions.json`](../versions.json) pins `agent-vault-gateway` to `gw-v0.1.0`.
[`setup/agent-vault-release.ts`](../setup/agent-vault-release.ts) binds that pin to
source `b292bc3e0b776ebd326117ed58d2ddee1b66321b`, platform assets and reviewed
SHA-256 hashes:

| Platform | Asset | SHA-256 |
| --- | --- | --- |
| Linux amd64 | `agent-vault_gw-v0.1.0_linux_amd64` | `2d8b54784871f8f33d1cad6292fe5a60860edb32dc2f9c43c135e4878f6cd83a` |
| Linux arm64 | `agent-vault_gw-v0.1.0_linux_arm64` | `8b946f31eedb06fe9fcee72258a5364cd9e3c1a865b46886a8ea033e33e9eff3` |
| macOS arm64 | `agent-vault_gw-v0.1.0_darwin_arm64` | `97521867e6fe144cd0d31230bc9e89349f73ab66818ae815bd5dd0ee4bd7ed42` |

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
- Source ref `refs/tags/gw-v0.1.0` and the full source commit above.
- GitHub-hosted rather than self-hosted build runners.

Any verification failure aborts. The helper never installs a binary, changes
configuration, starts a new gateway or restarts a service. Do not execute staged
bytes until it succeeds. Retain the verification files and license notices
alongside the installed release.

`version` reports `gw-v0.1.0`; commit/build-time fields remain `unknown` and Go
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
master-password input, database, CA and any network allowlist. Keep API/proxy
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

The same verified provider account may reconnect under its existing key and
union scope sets. NanoClaw retains the completion's returned `key` in sign-in
progress and reloads the overview after completion; it must not append a
presumed new account or invent a new key. Reconnect/disconnect actions use
the keys in that reloaded overview.

Pending operator acceptance includes real Google/GitHub consent and F8 stdio MCP
configuration using `av-refresh:<key>` / `av-access:<key>`. Do not claim those
passed from checksum, provenance, API readiness or fake-gateway tests.

### F8 stdio wiring

For an Agent Vault group, reuse the existing stdio servers and write only the
connected account's placeholders into their configured token files. Obtain the
actual key from the gateway's current account list, not a presumed newly
generated key. Keep provider app secrets in the gateway; installed-client
credential files may contain inert `agent-vault-managed` ID/secret placeholders.
Do not pass the host bootstrap token into a server or container.

Google token schemas differ by client:

| Client | Token record | Placeholder fields |
| --- | --- | --- |
| Gmail autoauth | Flat object | `access_token`, `refresh_token`, `expiry_date` |
| Cocal Calendar | Account map, e.g. `normal` | `access_token`, `refresh_token`, `expiry_date` inside that account |
| Piotr Agier Drive v2 | `accounts.<alias>` plus `defaultAccount` | `accessToken`, `refreshToken`, `expiryDate` inside that account |

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
endpoint intentionally intercepts its catalog host even in unmatched-host
tunnel mode. Do not disable TLS validation, give a test container unrestricted
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
