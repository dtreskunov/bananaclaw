# Remove Vercel capability

Remove the copied `container/skills/vercel-cli` skill and
`src/vercel-dockerfile.test.ts` if installed by this recipe. Resolve and remove
only those explicit paths; shared skill symlinks are reconciled on next spawn.
The pinned base-image Vercel CLI is not owned by this skill; leave it intact.

Revoke only the selected group's credential grant in Credentials, or:

```bash
ncl credentials revoke --user <owner-id> --id <connection-id> --group <group-id>
```

Do not delete personal credentials or disconnect upstream accounts used by other
groups. Global deletion requires explicit owner approval. Apply skill changes
at a safe committed turn boundary, then verify access is denied for the
selected group and unrelated groups remain authorized.
