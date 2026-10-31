---
name: init-agent-vault
description: Install or upgrade the headless Agent Vault credential gateway for NanoClaw. Use for Agent Vault setup, a pinned gateway release upgrade, or P5 cutover from the OneCLI canary. Verifies platform checksums and signed source provenance before installation and preserves existing credentials and configuration.
---

# Initialize or upgrade Agent Vault

This is the `dtreskunov/agent-vault` gateway, not OneCLI. Do not run
`/init-onecli`, an upstream installer, or a `latest` download for this task.
Follow [the release and upgrade guide](../../../docs/agent-vault-upgrades.md).

**Compatibility requirement:** this checkout requires the revision-7 native
managed-user contract, user-owned connections, explicit group grants and
group-bound OAuth placeholders. The reviewed pin is `gw-v0.2.0`, source
`9a99f613d54bec30cc3709351277d39de2f3fe6e`. Earlier group-owned gateway releases,
including `gw-v0.1.1`, are incompatible. Do not invent release metadata or bypass provenance checks.
Rollback requires the matching previous binary and consistent state backup.

## 1. Inventory and obtain approval

- Ask whether the operator wants a fresh installation or an upgrade. Discover
  the running service, executable, working directory, HOME and configuration
  paths before making changes. Existing explicit upgrade approval remains valid.
- On upgrade, preserve the master-password input, bootstrap-token file,
  database, CA, socket root, OAuth redirect URL, bind addresses and network
  policy, including any approved private-range opt-in. Inspect only necessary keys; never print secret
  values or read them into chat.
- An existing database or bootstrap token means this is an upgrade, not a fresh
  installation. Do not rotate the host token, reset the database, create another
  instance, migrate backends, or switch every group.
- Obtain explicit approval before replacing the live executable or restarting
  its service. Release publication is not deployment.
- Compare the running build and deployed-state record with the reviewed pin.
  A pin is not permission to downgrade a newer canary. If current behavior or
  state depends on an unreviewed newer build, stop binary replacement and
  require a compatible, verified coordinated release.

## 2. Download and verify the sanctioned release

The pin is `agent-vault-gateway` in `versions.json`, currently `gw-v0.2.0`.
Reviewed source and three platform hashes live in `setup/agent-vault-release.ts`.
The binaries are standalone executables, not archives.

Use the guide's staging command. The helper requires a recent GitHub CLI with
`gh attestation verify` and checks:

1. Supported OS/architecture and reviewed release metadata.
2. Downloaded bytes against the pinned platform SHA-256 and checksum manifest.
3. Signed build provenance from the expected repository and release workflow,
   bound to the exact source commit and tag.

Missing verifier, download errors, checksum errors and provenance errors are
fatal. Stop without installing; do not turn failures into warnings or run a
downloaded binary before verification. Do not bypass these checks with a local
source build. `(devel)` module metadata and unknown commit/build-time fields are
expected; the source binding is the signed provenance.

## 3. Upgrade, or initialize only when truly fresh

**Upgrade:** follow the guide's stop, consistent backup, atomic binary
replacement and restart sequence. Preserve the existing service and all state.
Retain the previous binary and state backup for rollback.

**Fresh installation only:**

- Confirm installation path, service manager, database location, localhost
  listeners, socket root and public NanoClaw UI origin with the operator.
- Use a local secure prompt to provision the master password, preferably through
  the service manager's encrypted credential facility. Never request a password
  or token in chat, in command-line arguments, or in a committed file.
- Configure foreground `agent-vault server --env-file .env` with the approved
  secure password input; use `--password-stdin` for a credential pipe. The
  gateway imports only `AGENT_VAULT_*` entries. Do not source `.env`.
- Set the required runtime settings from the guide, explicitly selecting
  `AGENT_VAULT_BOOTSTRAP_TOKEN_FILE` and `AGENT_VAULT_SOCKET_ROOT`. Keep the token
  host-only with mode 0600; never mount it into containers.
- Ask before enabling the service. First boot creates its own host token; never
  fabricate one or copy a token from another instance.

## 4. Verify and hand back

- Confirm `version` reports the pin, the installed hash matches, the service is
  healthy, and authenticated metadata reads work with the existing host token.
- On upgrade compare vault/account/service and socket-session metadata before
  and after; check persisted sockets rebind. Do not reveal credential values.
- Keep headless/reveal-disabled policy enabled and unmatched hosts in tunnel
  mode. Verify the OAuth redirect equals NanoClaw's `/ui/oauth/callback` URL.
- Connections can have `account:null`; never infer a verified identity from a
  label. Trust the completion's authoritative connection ID, then reload its
  metadata. Consent alone does not grant an agent access.
- Coordinate Google/GitHub consent with the operator; never claim it passed
  without a real sign-in. F8 stdio token placeholders are separate wiring.
- Keep OneCLI and existing group backends unchanged unless a separate migration
  was explicitly requested. Test any approved per-group switch with
  `ncl credentials backend`, not an all-groups cutover.
- For an approved migration, inventory source access and target readiness,
  preserve private rollback state and validate actual model/MCP workloads
  before switching. Missing consent or values remain blockers unless the
  operator explicitly removes those capabilities. Revoke only the removed
  groups' grants, never shared connections or other groups' access. Keep the
  seven-day sustained acceptance gate before OneCLI retirement.
- Report the installed version, checksum/provenance results, rollback paths and
  any pending acceptance steps. Remove temporary download tooling, retaining
  release verification material and license/NOTICE files with the installation.
