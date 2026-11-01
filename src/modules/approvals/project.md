## Approvals module

Admin-gated durable approval flow for self-modification and credential access.
Agent requests are committed to the host before delivery and stored in
`pending_approvals`. `approval_history` retains request and resolution records.

### Wiring

- Delivery actions `install_packages` and `add_mcp_server` use registered
  handlers. `request_access` uses the durable credential-access workflow.
- The response handler authorizes the authenticated user for the requesting
  group, dispatches registered handlers and preserves the originating route.
- Optional user messages travel with the approval outcome through existing
  steering; they do not change the approved operation.
- Runtime changes schedule a restart after the active turn commits. Outcomes
  never terminate a response mid-turn.

Credential access grants are user-owned references, not per-request API
approvals. There is no external gateway approval poller or in-memory resolver.

### Tables

`pending_approvals`, `approval_workflows` and `approval_history` persist requests,
recovery stages and transcript outcomes. Historical schema fields are retained
for audit and archive compatibility; removing runtime code does not erase data.
