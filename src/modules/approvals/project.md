## Approvals module

Admin-gated durable approval flow for self-modification and credential access.
Agent requests are committed to the host before delivery and stored in
`approvals`, retaining request, decision and outcome in one current-state row.

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

`approvals` owns public metadata, kind, status, revision and response.
`approval_workflows` holds private selections, submission aliases and notification
flags only. Its reader joins the canonical approval; it owns no second lifecycle.
Questions retain their existing authoritative row. Group archives cancel pending
approvals, refuse applying effects and restore finalized records as audit-only.
Legacy storage requires the explicit offline reset documented in
`docs/user-requests-refactor-plan.md`; there is no runtime compatibility reader.
