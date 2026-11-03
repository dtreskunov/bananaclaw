# Native runner economy mode

Economy mode is an opt-in, per-agent-group runtime policy, not a model output
limit. Existing groups retain their behavior. Only the native provider supports
it. No personal memory or live configuration is included in this branch.

Enable after reviewing the complete changes and staging the memory migration:

```sh
ncl groups config update --id <group-id> --economy-mode true
ncl groups restart --id <group-id>
```

Disable with `--economy-mode false` and restart. The equivalent settings API
field is the boolean `economy_mode`. These operations use existing permissions.

## Private memory migration

Do this offline first, inside a private copy of the group's workspace:

1. Copy the complete original `CLAUDE.local.md` to `MEMORY.archive.md` in the
   same directory. Check byte-for-byte equality and keep the original backup.
2. Keep identity, current preferences and safety rules in `CLAUDE.local.md`.
   Replace historical investigations with a topic index listing archive line
   ranges. Keeping the archive beside the original preserves relative links.
3. Use bounded reads of the relevant archive ranges, not whole-file loading.
   Never commit the private files or expose them through public Pages.
4. Verify representative memory questions and measure actual fresh-request
   input tokens before applying the staged copy to a live group.
5. To roll back, restore the complete original file and restart the group.

Compare usage in the user's timezone. Raw input/cache/output token totals
are not MiniMax's weighted plan quota, and reasoning tokens are already part
of output. Use recorded successful-call usage, not estimates, for savings claims.
