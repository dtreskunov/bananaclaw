# Credential gateway spike: work split and contract

**Status:** ready to start. **Date:** 2026-10-20. This is the go/no-go spike from
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

## NanoClaw side

- **Switch:** `NANOCLAW_AGENT_VAULT_GROUPS=<group ids>` (spike only) moves those
  groups to the gateway. Every other group keeps OneCLI.
- **Spawn:** create `data/agent-vault/sessions/<session>/` and call
  `POST /v1/socket-sessions`.
  - **Mounts:** the directory at `/run/nanoclaw/egress`, and a combined CA
    bundle (system CAs plus the gateway root) read-only.
  - **Env:** `HTTPS_PROXY`/`HTTP_PROXY` (both cases) = `http://127.0.0.1:3128`,
    `NO_PROXY=localhost,127.0.0.1`, `NODE_USE_ENV_PROXY=1`, and the same CA
    variables as upstream's `internal/isolation/env.go`.
  - **On failure:** the spawn is refused.
  - **On session end:** `DELETE` the socket session.
- **Relay:** the agent-runner listens on `127.0.0.1:3128` and pipes each
  connection to `/run/nanoclaw/egress/egress.sock`. It starts before anything
  else in `index.ts` and `mcp-probe.ts`.
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
- **Vault setup:** with Agent Vault's CLI on the host, using the host token,
  create vault `ag-1780956116163-prz9h2` and set its credentials and services.
  These cover the model provider key, Tavily (query substitution), NextCloud
  (custom `Basic {{ … }}` header), domagent (path-scoped bearer) and Linear MCP.
- **Values:** OneCLI can't export secret values, so the operator enters each
  one through the CLI.
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
