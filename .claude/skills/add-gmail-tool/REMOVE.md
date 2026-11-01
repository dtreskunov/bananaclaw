# Remove Gmail access

For each selected group, remove only its named Gmail MCP instance if one was
configured:

```bash
ncl groups config remove-mcp-server --id <group-id> --name <server-name>
```

The credential owner can revoke that group's grant in Credentials, or:

```bash
ncl credentials revoke --user <owner-id> --id <connection-id> --group <group-id>
```

Revocation is immediate and leaves other groups connected. Review the complete
credential grant before revoking; it can authorize other Google services too.
Do not delete the personal connection or revoke upstream OAuth unless the owner
explicitly asks to disconnect it everywhere.

Verify the group's access is denied and unrelated groups still work. Configuration
changes schedule a safe restart; do not kill an active response.
