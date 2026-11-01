---
name: add-gmail-tool
description: Add Gmail access using user-owned Agent Vault OAuth and explicit agent grants. Use when users want to read, search, send or organize Gmail, or configure an authenticated Gmail MCP endpoint.
---

# Add Gmail access

Ask which credential owner/account and agent groups should have access, and
whether API access or a specific trusted remote MCP server is wanted.
Do not request tokens, client secrets or passwords in chat.

## 1. Verify the gateway

Run `pnpm exec tsx setup/index.ts --step agent-vault`. If it fails, use
`/init-agent-vault` and verify the reviewed release; do not bypass TLS/proxy
isolation or install an unverified binary.

## 2. Connect and grant access

The owner signs into NanoClaw and uses **Credentials** to select an existing
Google connection or create one with the configured Google OAuth app. Review
Gmail scopes and complete real consent in that owner's session.
Reuse a connection only when the intended account and actual permissions match.

Grant only the chosen agents. A grant covers the whole credential, including
future URL rules; do not broaden a service-only share implicitly. Host CLI:

```bash
ncl credentials list --user <owner-id>
ncl credentials grant --user <owner-id> --id <connection-id> --group <group-id>
```

Consent alone does not grant access. Never copy OAuth tokens between groups.

## 3. Choose the tool surface

For direct API access, agents use the granted Gmail API through the scoped
gateway. No local credential files or extra packages are needed.

If the user specifically wants MCP tools, obtain and verify the exact trusted
remote Gmail MCP URL; do not invent an endpoint. Configure its MCP OAuth
connection in Credentials, grant the selected group, and persist a named MCP
instance with an approved connection reference and account alias using
`ncl groups config add-mcp-server`. Read `ncl help` for the installed flag
schema. Different accounts need distinct named instances.

Do not install a legacy auto-auth stdio server or fabricate token files.
If a stdio client is required, review its schema and Agent Vault's group-bound
F8 placeholders before changing configuration.

## 4. Validate

Run the Settings MCP test for a configured server and require successful
authenticated `tools/list`. Verify the intended account with a read-only Gmail
profile/list operation through the group socket. A 401/403 is not proof of
disconnection: distinguish permission, routing and grant errors. Never send a
test email without separate approval.

See [REMOVE.md](REMOVE.md) to detach only this agent's access.
