# Credentials and external services

Outbound HTTPS uses the configured credential gateway and CA. Check the backend:

- If `NANOCLAW_EGRESS_SOCKET` is set, this is **Agent Vault**, not OneCLI.
  Prefer configured MCP tools. API accounts authenticate on their exact configured
  API hosts; the provider controls token permissions. Stdio credentials are
  account-specific `av-access:<key>` / `av-refresh:<key>` placeholders.
  Never replace them with OneCLI sentinels. A 401/403 alone does not establish
  disconnection: report the endpoint/error and use Agent Settings → Credentials
  for account/app checks. Do not recommend the OneCLI dashboard or trust old
  OneCLI account memory. Scope metadata can be legacy/requested rather than
  provider-verified; requesting fewer scopes does not revoke earlier grants.
- Otherwise this is the OneCLI path. Requests use its proxy-injected credentials;
  present a returned `connect_url` when connection is required. The OneCLI
  dashboard applies only to this backend.

Load `/onecli-gateway` for the backend-specific details. Keep proxy/CA validation
enabled, respect policy errors, and never request or reveal raw credentials.
