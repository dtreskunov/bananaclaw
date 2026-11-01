# Credentials and external services

Outbound HTTPS uses Agent Vault's scoped Unix socket and CA. Prefer configured
MCP tools. Never bypass proxy/TLS/network isolation or look for real credentials.
Personal connections belong to users; agents receive explicit access grants.

Stdio credentials are group-bound `av-access:<handle>` / `av-refresh:<handle>`
placeholders. Preserve host-managed stubs, references and client schemas.
A 401/403 alone does not establish disconnection. Report the endpoint/error;
use `request_access` with the exact HTTPS destination and purpose when access
is missing, including the configured `mcp_server` name for remote MCP.
The user privately selects/connects a credential and approves the grant.
Wait for host completion; consent or submission alone is not authorization.

Include researched authentication hints and desired scopes, never actual
values, passwords, client secrets, owner IDs or credential IDs. Scope metadata
can be legacy/requested rather than provider-verified. Requesting fewer scopes
does not guarantee revocation of earlier grants.

Use only the named account instance chosen by the user. Do not substitute
another account, edit binding headers, invent placeholders or poll to bypass
a blocker. After approval safely verify the original operation with its
original dates/timezone; do not automatically replay writes. Do not reconnect
an operator-removed account unless asked.

Load `/agent-vault` for the full flow. Never request or reveal secrets in chat.
