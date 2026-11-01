## Admin CLI (`ncl`)

The `ncl` command is available at `/usr/local/bin/ncl`. It lets you query and modify NanoClaw's central configuration.

### Usage

```
ncl <resource> <verb> [--flags]
ncl <resource> help
ncl help
```

### Scope

Your CLI access may be scoped. Run `ncl help` to see which resources are available and whether args are auto-filled. Under `group` scope (the default), `--id` and group-related args are auto-filled to your agent group — you don't need to pass them.

### Resources

Run `ncl help` for the full list. Common resources:

| Resource | Verbs | What it is |
|----------|-------|------------|
| groups | list, get, archive, update, restart, config get/update, config remove-mcp-server, config add-package/remove-package, config set-param/unset-param | Agent groups (workspace, personality, container config) |
| sessions | list, get, search | Active sessions + message history search |
| destinations | list, add, remove | Where an agent group can send messages |
| members | list, add, remove | Unprivileged access gate for an agent group |

Additional resources (available under `global` scope only): messaging-groups, wirings, users, roles, user-dms, dropped-messages, approvals.
The verbs `groups create` and `groups delete` also require `global` scope.
`groups config add-mcp-server` is **host-only**, even with global scope.
Use `add_mcp_server` for stdio and HTTP/SSE additions to your own agent.
Submit once and finish the turn; wait for addition approval and the automatic
restart before requesting access for the new named server.

### Archive vs. delete vs. restore

- `groups archive` (allowed in your scope) — snapshots the group's DB rows to `groups/<folder>/archive.json`, kills running containers, deletes the rows, and renames the folder with a `~` suffix. Reversible. Use this when the operator says they want to "delete" or "stop using" a group — archive is almost always what they actually want.
- `groups delete` (global scope only) — drops the DB rows without writing a snapshot. Not reversible; reserved for clearly throwaway groups (created in error, never used).
- `groups restore` — **host-only.** The agent cannot run this. If you archived something the operator now wants back, tell them: *"run `ncl groups restore --folder <name>` on the host shell."*

### Searching past conversations

`ncl sessions search --query "..."` searches your past message history with the current user on the current channel. Results include message IDs, timestamps, and text snippets.

- Supports prefix search (`deploy*`), phrase search (`"deploy to prod"`), and boolean operators (`deploy OR release`)
- Results are scoped to conversations with your current conversation partner — you cannot see other users' threads
- Each result includes a `messageId` and `threadId` you can reference in replies using `[[msg:<messageId>|<threadId>]]` format — the chat UI renders these as clickable links that jump to the referenced message

### When to use

- **Recalling past conversations** — `ncl sessions search --query "that deployment bug"` to find what was discussed.
- **Looking up your own config** — `ncl groups get` or `ncl groups config get` to see your container config.
- **Restarting your container** — `ncl groups restart` (with optional `--rebuild` and `--message`).
- **Checking who's in your group** — `ncl members list`.
- **Seeing your destinations** — `ncl destinations list`.
- **Answering questions about the system** — query `ncl` rather than guessing.

### Access rules

Read commands (list, get) are open. Write commands (create, update, delete, restart, config update, add, remove) require admin approval — the request is held until an admin approves it.

### Approval flow

Write commands require admin approval. Here's what happens:

1. You run the command (e.g. `ncl groups config update --model claude-sonnet-4-5-20250514`).
2. The command returns immediately with an `approval-pending` response — it has **not** been executed yet.
3. An admin or owner gets a notification showing exactly what you requested, with approve/reject options.
4. Once the admin responds:
   - **Approved:** the command executes and the result is delivered back to you as a system message in this conversation.
   - **Rejected:** you get a system message saying the request was rejected.

You don't need to poll or retry — the result arrives automatically.

### Examples

```bash
# Read commands (no approval needed)
ncl groups get
ncl groups config get
ncl sessions list
ncl sessions search --query "deployment issue"
ncl destinations list
ncl members list

# Write commands (approval required)
ncl groups restart
ncl groups restart --rebuild --message "Config updated."
ncl groups archive                              # archive yourself (--id auto-fills)
ncl groups config update --model claude-sonnet-4-5-20250514
ncl groups config add-package --npm some-package
ncl groups config set-param --key max_tokens --value 8192     # cap output length
ncl groups config set-param --key temperature --value 0.3     # OpenCode only
ncl groups config unset-param --key temperature
ncl members add --user telegram:jane

# Host-only — DO NOT attempt; ask the operator instead
# ncl groups restore --folder some-archived-group
# ncl groups config add-mcp-server ...
```

### Important

Config changes via `ncl groups config update` do not take effect until `ncl groups restart`. Run `ncl groups config help` for details.

### Tips

- Use `ncl <resource> help` to see all available fields, types, enums, and which fields are auto-filled.
- Flags use `--hyphen-case` (e.g. `--agent-group-id`), mapped to `underscore_case` DB columns automatically.
- `list` supports filtering by any non-auto column. Default limit is 200 rows; override with `--limit N`.
- Write commands return `approval-pending` immediately — don't treat this as an error. Wait for the system message with the result.
