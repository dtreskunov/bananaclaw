## Self-modification tools (require admin approval)

Two fire-and-forget tools change your container image or config. Each requests admin approval; you get notified via system chat on approve/reject.

### install_packages

Add apt and/or npm packages to your container image. On approval, the config is updated AND the image is rebuilt in the same step; a follow-up after the deferred restart asks you to verify the packages.

```
install_packages({
  apt: ["ripgrep", "jq"],              // names only, no version specs or flags
  npm: ["@anthropic-ai/sdk"],          // global install
  reason: "need rg for fast code search"
})
```

- Max 20 packages per request.
- Names must match strict regex (blocks shell injection via `vim; curl evil.com`).
- On approval, the image rebuild and container restart happen automatically — there is no separate rebuild step for you to trigger.

### add_mcp_server

Add an existing third-party MCP server to your own runtime using this tool,
for either stdio or HTTP/SSE. The configuration CLI is host-only.
Use https://registry.modelcontextprotocol.io/ or https://mcp.so for discovery,
then verify the publisher's exact command, endpoint and authentication docs.

```
add_mcp_server({
  name: "memory",
  command: "pnpm",
  args: ["dlx", "@modelcontextprotocol/server-memory"]
})
add_mcp_server({ name: "example", url: "https://mcp.example.com/mcp", transport: "http" })
```

- Does NOT install packages. Use `install_packages` first if the command isn't already available.
- Submit once and finish the turn. Do not poll, resubmit or switch to the CLI.
- Approval applies the configuration and schedules an automatic restart after
  the current response finishes. No image rebuild is needed for MCP wiring.
- Never request access for a new named server before addition approval and
  restart. Afterward, load `/agent-vault` if credentials are needed.
- Before recommending Google-hosted MCP setup, load `/agent-vault` to verify
  personal versus Workspace account eligibility, preview/project enrollment
  and OAuth-client requirements. Prefer supported REST OAuth for new personal
  Gmail, Calendar or Drive integrations if MCP eligibility is unconfirmed.
  REST is not a workaround for Keep's account restrictions.

### How approval works

Submission is not approval. Tell the user approval is pending and finish
the turn. The outcome can steer an active response, but restart waits until
that response finishes. Verify the change only after the replacement runtime
starts; its follow-up system message asks you to verify and report.

If denied, you'll get a chat message telling you the request was rejected. Do not retry automatically; explain to the user what was denied.

## Credential access approvals

Use `request_access` with the exact HTTPS destination and purpose, and the
configured `mcp_server` name for remote MCP. The user privately selects/connects
a personal credential and approves this agent's access. Wait for the host's
completion message before retrying. A grant is not approval for every subsequent
API request. Do not reconnect an operator-removed account or replay writes.
Load `/agent-vault` for binding placeholders, scope review and error recovery.
