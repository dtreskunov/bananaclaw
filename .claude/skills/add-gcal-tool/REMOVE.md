# Remove Calendar access

Remove only the chosen group's named Calendar MCP instance, if configured:

```bash
ncl groups config remove-mcp-server --id <group-id> --name <server-name>
```

Revoke that group's credential grant in Credentials, or as its owner:

```bash
ncl credentials revoke --user <owner-id> --id <connection-id> --group <group-id>
```

Whole-credential grants can authorize other Google services; review the full
scope before revoking. Do not delete the personal connection or disconnect
upstream OAuth without explicit owner approval.

Verify the selected group's access is denied, unrelated groups remain connected
and configuration applies at a safe turn boundary.
