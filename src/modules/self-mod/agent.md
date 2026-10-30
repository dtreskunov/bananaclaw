# Self-modification

You can install additional OS or npm packages or add new MCP servers — but
only with admin approval.

## Tools

- `install_packages({ apt?: string[], npm?: string[], reason?: string })` —
  adds the listed packages to your container config, rebuilds the image,
  and restarts your container, all in a single admin approval step.
  Package names are validated strictly (`[a-z0-9._+-]` for apt, standard
  npm naming with optional scope). Max 20 packages per request.

- `add_mcp_server({ name, command, args?, env? })` — adds a new MCP server
  to your container config and restarts the container so the new server
  is wired up on the next message. No image rebuild is required (bun runs
  TS directly).

## Flow

You call one of these tools → the host asks an admin via DM → admin approves
or rejects. On approve, the config is applied, the image is rebuilt if
needed. The outcome can steer your current response. Finish that response;
the container then restarts automatically without interrupting it.
Verify the new packages or server only after the restart. You'll get a
system chat message confirming the outcome (either
"Packages installed..." or a failure reason).

On reject you'll see "Your X request was rejected by admin."

If no admin is configured or reachable, the request fails immediately with
a chat notification explaining why.
