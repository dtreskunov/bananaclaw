# Per-agent email addresses

Each agent group can own a Resend address such as `treskowitz@bananaclaw.app`. The agent can compose new mail with `send_email`, and responses return to the session that initiated the email.

## Prerequisites

The Resend channel must be installed and configured with both `RESEND_API_KEY` and `RESEND_FROM_ADDRESS`. The domain portion of `RESEND_FROM_ADDRESS` is the domain shown in Settings and used for agent addresses.

Resend must be configured to receive mail for that domain and deliver `email.received`, `email.bounced`, `email.failed`, and `email.suppressed` webhooks to NanoClaw. A catch-all receiving domain is required because addresses are allocated dynamically.

## Enabling email

Open the agent group's **Settings**, enable **Email**, and save. NanoClaw derives a unique local part from the group name. An owner or global admin can override it before or after enabling.

Enabling email atomically creates:

- a public Resend messaging group for `<local-part>@<domain>`;
- an inbound wiring from that mailbox to the agent group;
- a canonical `email` destination used by `send_email`.

No container restart is required for address changes. Active session destination maps are refreshed immediately.

## Replies and address changes

Fresh mail composed with `send_email` uses a tokenized return address derived from the agent alias. For example, `agent@example.com` becomes `agent+r-<token>@example.com` in both `From` and `Reply-To`. NanoClaw stores the token before sending. Inbound mail is classified in this order:

1. A matching return-address token routes the response directly to the originating session.
2. Mail without a correlation match follows the normal cold inbound-email path and starts or resumes a mailbox thread.

Direct response routing preserves the originating session's delivery destination. For example, if a web chat asks the agent to send an email, the recipient's response wakes that web session and the agent's result returns to the web chat. The external sender, subject, and email-thread metadata remain visible to the agent in the inbound message.

Permanent delivery failures use the same return-address token. A matching `email.bounced`, `email.failed`, or `email.suppressed` webhook writes a durable internal delivery report to the originating session and wakes the agent. The report includes the recipient, subject, and provider reason so the agent can stop waiting, report the failure, and retry only with a corrected address. Terminal failures remove their correlation after a successful wake; a failed wake keeps the correlation so the webhook can be retried. Transient `email.delivery_delayed` events do not wake the agent.

HTML is stored as an untrusted `original-message.html` attachment. The plain-text body is included in the message when the sender provides one; NanoClaw does not derive text from HTML-only mail.

Outbound mail uses the alias encoded in the canonical `email` destination. Resend thread IDs retain that alias, so email-thread follow-ups continue to send from the same address.

When an address changes, the old mailbox remains wired while email stays enabled. This lets recipients reply to messages sent before the rename. The new address becomes the canonical sender for new mail, and old aliases remain reserved to the original agent.

Disabling email removes the canonical outbound destination and closes all managed aliases at the inbound gate. Existing mailbox and thread records remain so re-enabling does not lose routing history.

## Security model

Agent mailboxes use `unknown_sender_policy='public'`: anyone who emails the address can start a thread. This is necessary for arbitrary recipients to reply without prior membership. Each cold sender is still resolved to a NanoClaw user identity, and sessions remain isolated by the mailbox's agent-group wiring and per-thread routing.

Correlated responses are capability-routed instead: possession of the random return-address token allows that response to re-enter only the stored origin session. Correlation does not broaden session search or expose other messaging groups wired to the same agent group.
