---
name: add-gcal-tool
description: Add Google Calendar access using user-owned Agent Vault OAuth and explicit agent grants. Use for calendars, event search, event creation, free/busy queries or an authenticated Calendar MCP endpoint.
---

# Add Google Calendar access

Ask which owner/account, calendars and agent groups are intended, and whether
direct API access or a trusted remote MCP server is required.
Never request tokens or client secrets in chat.

1. Verify the reviewed gateway with
   `pnpm exec tsx setup/index.ts --step agent-vault`. Use `/init-agent-vault`
   if installation/configuration is needed; do not bypass proxy or TLS.
2. The owner signs into NanoClaw **Credentials**, selects/connects the intended
   Google account and reviews actual Calendar scopes. Complete real consent;
   labels or requested scopes are not proof of identity or granted permissions.
3. Grant only the chosen agents. A grant covers the whole credential and future
   URL patterns; review that authority before sharing. Host CLI:

   ```bash
   ncl credentials list --user <owner-id>
   ncl credentials grant --user <owner-id> --id <connection-id> --group <group-id>
   ```

4. Direct Calendar API calls use the group socket with no local token files.
   For MCP, obtain and verify the exact remote server URL, connect its MCP
   OAuth account privately, and configure a named instance with an approved
   connection reference/account alias through `ncl groups config add-mcp-server`.
   Consult `ncl help` for the current flag schema. Use distinct instances for
   distinct accounts; never guess endpoints or substitute another account.
5. Require authenticated MCP `tools/list` when applicable. Verify the intended
   account and calendar list with read-only calls through the group gateway.
   Check actual dates/timezone and free/busy results. Do not create test events
   without separate approval.

Do not install a legacy auto-auth stdio server or fabricate token files.
Review any required stdio schema and group-bound F8 placeholders first.
A 401/403 alone does not establish disconnection; distinguish routing,
permissions and explicit access grants.

See [REMOVE.md](REMOVE.md) for group-only revocation.
