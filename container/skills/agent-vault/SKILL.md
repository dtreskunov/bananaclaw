---
name: agent-vault
description: >-
  Agent Vault credential gateway: HTTPS proxy that injects stored credentials
  into outbound calls. You MUST use this skill when the user asks you to
  read emails, check calendar, access GitHub repos, create issues, check
  Stripe payments, or interact with ANY external service or API. Do NOT
  use browser extensions or OAuth CLI tools. Make HTTP requests directly;
  the gateway injects credentials automatically.
compatibility: Requires HTTPS_PROXY and the configured gateway CA.
metadata:
  author: bananaclaw
  version: "0.5.0"
---

# Credential Gateway

Outbound HTTPS uses Agent Vault's per-session Unix socket and trusted CA.
Personal connections belong to users; this agent has only explicitly granted
access. A missing socket is a host configuration error, not permission to
bypass the gateway.

- Use the configured native MCP tools first. Search for their actual server/tool
  names, for example `^mcp__github-local__`, rather than treating a natural-language
  keyword sentence as a tool-name pattern.
- HTTPS requests use the scoped Unix proxy socket and gateway CA. Never disable
  the proxy, TLS verification or network isolation to work around an error.
- A connected API account supplies its token on the exact configured API hosts.
  The provider enforces the token's permissions; there are no gateway OAuth
  scope-set or REST-path permission bundles. Other hosts are not implied.
- Stdio clients use `av-access:<group-binding-handle>` / `av-refresh:<group-binding-handle>`.
  These are placeholders, not provider tokens or gateway credentials. Keep
  existing stubs and their client-specific schema. Never replace them with
  raw credentials or newly invented account keys.
- A 401/403 does not by itself prove a disconnected account. Report the exact
  endpoint and error; distinguish provider permissions, reconnect status and
  routing. Use `request_access` with the exact HTTPS destination and a reason
  to ask the user to select/connect a personal credential and approve this
  agent's access. It supports OAuth APIs, MCP OAuth and static authentication.
  Do not include secrets, owner IDs or credential IDs. Scope suggestions need
  user review and are not automatically granted. `ncl access request
  --resource-url <url> --reason <purpose>` uses the same approval workflow.
  Wait for the host's completion message; submission/review is not permission.
  Do not probe token endpoints, inspect process environments/browser cookies,
  guess credential placeholders, or create a recurring availability poller.
  After approval, use the supplied nonsecret binding selector and safely
  verify the original operation before continuing. Preserve the request's
  original dates/timezone; never automatically replay writes. Rejecting access
  ends the request unless the user asks again. `ncl credentials` stays host-only.
- For a configured remote MCP server, include its exact `mcp_server` name in
  `request_access` (CLI: `--mcp-server`). The user can pin a connection and account
  alias to that one server. Two accounts on the same endpoint require distinct
  named MCP instances, such as `gmail_personal` and `gmail_work`. Use the named
  tools matching the user's intended account; ask when ambiguous. The host
  resolves current group handles and transport headers. Do not copy binding
  headers into configuration or switch to another account when one is blocked.
- For a new server, use `add_mcp_server` first (stdio or HTTP/SSE), submit once
  and finish the turn. Do not request named-server access until its addition
  is approved and the automatic restart completes. A pending addition is not
  a configured server; do not retry access or use the host-only MCP-add CLI
  to work around it.
- When documentation or discovery identifies the required mechanism, include
  optional `authentication` hints in `request_access`: `type` is `mcp_oauth`,
  `oauth_app`, `bearer`, `api-key`, `basic` or `custom`. OAuth may suggest a
  configured `app_id`; place documented scopes in the separate `scopes` array.
  API-key hints use `header` plus an optional public `prefix`; custom hints use
  `headers` as an array of names, never values. Do not invent scopes, header
  values, client secrets or account identifiers. The user reviews these hints
  in the existing form; they do not authorize any change by themselves.
- Scope metadata may be provider-reported, requested, legacy or unknown.
  Do not describe legacy/requested metadata as a newly verified grant.
  Requesting fewer scopes is not a guaranteed provider-side revocation.
- Prefer live configured/account state to stale memory. Never ask for secrets
  in chat. The host token and real OAuth tokens are not available to containers.
