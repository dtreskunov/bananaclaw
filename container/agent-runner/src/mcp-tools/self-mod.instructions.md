## Installing packages & tools

To install packages that persist, use the self-modification tools:

**`install_packages`** — request system (apt), global npm, or Python (pip) packages. Requires admin approval.

Example flow:
```
install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], pip: ["yt-dlp"], reason: "Audio transcription + video download" })
# → Admin gets an approval card → approves
```

**Prefer `pip` over `apt` for Python CLIs and libraries.** Debian's apt packages
for fast-moving Python tools (yt-dlp, ffmpeg-python, certain ML/SDK clients) are
often months or years out of date and break against current upstream services.
pip packages install into a shared venv on `PATH`, so the console script (e.g.
`yt-dlp`) is callable the same way — just newer. Reach for `apt` only for things
that genuinely are system packages (codecs, fonts, native libraries, daemons).

**When to use this vs workspace `pnpm install` / `pip install --user`:**
- Workspace install if you only need it temporarily for one task. Will not be available in subsequent turns.
- `install_packages` persists for all future turns. Use especially if the user specifically asks you to add a capability.

### MCP servers (`add_mcp_server`)

Use **`add_mcp_server`** for both stdio and remote HTTP/SSE servers in your
own configuration. It is the only agent-facing MCP addition operation;
`ncl groups config add-mcp-server` is host-only, even with global CLI scope.
You cannot use this tool to change another agent's configuration.

Discover existing servers at the official MCP Registry
(https://registry.modelcontextprotocol.io/) or https://mcp.so. Catalog entries
are discovery hints, not permission to install or proof of trust. Verify the
publisher's documentation for the exact command or endpoint, transport and
authentication requirements; do not guess endpoint or OAuth paths.

Examples:

```
add_mcp_server({ name: "memory", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-memory"] })
add_mcp_server({ name: "example", url: "https://mcp.example.com/mcp", transport: "http" })
```

Never ask for raw credentials in chat or fabricate credential setup instructions.
Only use documented nonsecret headers and environment settings or existing
approved credential placeholders. Do not construct authentication or binding
headers. Optional `instructions` and `timeout` (1000–600000 milliseconds) are
supported for either transport.

1. Submit the addition **once**. Submission is not approval or installation.
2. Tell the user approval is pending and **finish the turn**. Do not poll,
   resubmit, switch to the CLI, or manually restart to work around a pending
   approval. The host notifies you when an admin approves or rejects.
3. On approval, the host applies the configuration and automatically restarts
   your container after the active response finishes. No image rebuild is
   needed for MCP wiring.
4. **Only after approval and restart**, load `/agent-vault` and request missing
   credentials with `request_access`: exact HTTPS destination, purpose and
   configured remote `mcp_server` name. Never request named-server access while
   its addition is pending; it is not configured yet.
5. If access is requested, finish that turn and wait for the host's completion
   message before verifying the server's tools and reporting the result.

Rejection ends the setup unless the user asks again.
The user privately selects/connects a credential and approves this agent's grant.
Preserve host-managed `av-access:<handle>` / `av-refresh:<handle>` stubs and
connection references; never invent credential values or replace these with
invented sentinels. Do not reconnect an operator-removed account unless asked.
