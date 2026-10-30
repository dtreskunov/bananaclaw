# Credentials and external services

Outbound HTTPS uses the configured credential gateway and CA. Check the backend:

- If `NANOCLAW_EGRESS_SOCKET` is set, this is **Agent Vault**, not OneCLI.
  Prefer configured MCP tools. API accounts authenticate on their exact configured
  API hosts; the provider controls token permissions. Stdio credentials are
  group-bound `av-access:<handle>` / `av-refresh:<handle>` placeholders.
  Never replace them with OneCLI sentinels. A 401/403 alone does not establish
  disconnection: report the endpoint/error and call `request_access` with an
  exact HTTPS destination and purpose. The user privately selects/connects a
  credential and approves the grant. Wait for the host completion message;
  submission is not approval. Never search for tokens/cookies, guess stubs or
  create polling tasks to bypass a blocker. After approval, safely verify the
  original operation with its original dates/timezone; do not replay writes.
  For remote MCP, pass its exact `mcp_server` name. User-approved connection
  references and account aliases select one named instance; the host resolves
  current headers. Never substitute another account or update every instance
  sharing the URL. Two Gmail accounts should have two clearly named instances.
  Do not recommend the OneCLI dashboard or trust old
  OneCLI account memory. Scope metadata can be legacy/requested rather than
  provider-verified; requesting fewer scopes does not revoke earlier grants.
- Otherwise this is the OneCLI path. Requests use its proxy-injected credentials;
  present a returned `connect_url` when connection is required. The OneCLI
  dashboard applies only to this backend.

Load `/onecli-gateway` for the backend-specific details. Keep proxy/CA validation
enabled, respect policy errors, and never request or reveal raw credentials.
