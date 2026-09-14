# NanoClaw Database Architecture — Overview

Orientation for the data model: the three databases, how they fit together, and the invariants that hold across them. For table-level schemas, follow the links below.

- **[db-central.md](db-central.md)** — every table in `data/v2.db` (identity, wiring, approvals, Chat SDK state) plus the migration system.
- **[db-session.md](db-session.md)** — the per-session `inbound.db` + `outbound.db` pair, seq parity, and session folder layout.

Related: [architecture.md](architecture.md) for the high-level design; [api-details.md](api-details.md) for inbound/outbound message content shapes; [isolation-model.md](isolation-model.md) for channel-to-agent wiring modes.

---

## 1. The four databases

NanoClaw uses **four kinds of SQLite database**, all on the host filesystem:

| DB                   | Location                                                         | Writer    | Readers                            | Purpose                                                  |
| -------------------- | ---------------------------------------------------------------- | --------- | ---------------------------------- | -------------------------------------------------------- |
| **Central**          | `data/v2.db`                                                     | host      | host                               | Identity, permissions, routing, wiring — the admin plane |
| **Session inbound**  | `data/v2-sessions/<agent_group_id>/<session_id>/inbound.db`      | host      | host                               | Durable host messages, routing, and host event journal   |
| **Session outbound** | `data/v2-sessions/<agent_group_id>/<session_id>/outbound.db`     | host      | host                               | Durable runner output projected by the host              |
| **Runner state**     | `data/v2-sessions/<agent_group_id>/<session_id>/runner-state/runner-state.db` | container | container                | Local bidirectional projection + runner event journal    |

**Single-writer rule.** Every SQLite file has exactly one writer. The host writes
the central, inbound, and outbound stores. The container writes only
`runner-state.db`; the host never opens it.

Both host journals communicate with the runner projection over one acknowledged
per-session Unix socket. Live runner status uses the same socket; see
[session-link.md](session-link.md).

**Journal mode.** Session DBs use `journal_mode = DELETE` (not WAL). Each file
has one local writer; the socket protocol crosses the container boundary.

---

## 2. Database map

```
data/
  v2.db                                   ← CENTRAL (host ↔ host)
  v2-sessions/
    <agent_group_id>/
      .claude-shared/                     ← shared Claude state for the agent group
      agent-runner-src/                   ← per-group agent-runner overlay
      <session_id>/
        inbound.db                        ← private host input + event journal
        outbound.db                       ← private host runner projection
        runner-state/                     ← mounted so DB rollback journals persist
          runner-state.db                 ← container projection + event journal
        inbox/<message_id>/               ← decoded attachments, mounted RO
        outbox/<message_id>/              ← attachments the agent produced

  .session-links/<session-hash>/
    runner.sock                            ← bidirectional events + live signals
```

Session DB path helpers live in `src/session-manager.ts`; session-link lifecycle
and paths live in `src/session-link.ts`.

---

## 3. Central vs. session: what goes where

| Kind of data                   | Where                               | Why                                                        |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------------- |
| Identities, roles, memberships | central                             | Stable, cross-session, rarely written                      |
| Channel wiring, routing rules  | central                             | Admin plane                                                |
| Destination ACL                | central (+ projection per session)  | Source of truth centrally; fast local lookup per session   |
| Session registry (ids, status) | central                             | Host orchestrates lifecycle                                |
| Approvals & pending questions  | central                             | Survive container restarts, admin-visible                  |
| Dropped-message audit          | central                             | Global ops view                                            |
| Inbound messages, retry state  | session `inbound.db`                | Per-session workload; host is sole writer                  |
| Outbound messages, agent state | session `outbound.db`               | Host applies acknowledged runner events                    |
| Delivery outcome               | session `inbound.db` (`delivered`)  | Host writes and resolves edit/reaction targets             |
| Processing status              | runner journal → host `outbound.db` | Container can't write to `inbound.db`                      |

Heuristic: if the value is a message, routing projection, or runtime ack, it goes per-session. Everything else is central.

---

## 4. Isolation boundary

Host databases are not bind-mounted into the container. `runner-state.db` is the
only mounted database and the host never opens it. Durable events cross the
boundary one at a time and are removed from the sender's journal only after the
receiver commits and ACKs. `inbox/` is read-only; `outbox/` is writable.

These rules are enforced by convention in `src/session-manager.ts` and `container/agent-runner/src/db/`. If you change how the DBs are opened, re-read that code first.

---

## 5. Design patterns at a glance

1. **Host stores plus runner projection.** `inbound.db` and `outbound.db` are
   host-owned; `runner-state.db` is runner-owned. No SQLite file has cross-boundary writers.
2. **Seq parity.** Even = host, odd = container. Disjoint namespace across both tables lets the agent reference any message by `seq` alone. Details in [db-session.md §3](db-session.md#3-sequence-numbering-invariant).
3. **Projection pattern.** Host messages, destinations, and routing are
  journaled in `inbound.db` and projected into `runner-state.db` over the link.
4. **Acknowledged bidirectional channel.** Each side journals durable mutations
  and ACKs only after the other side commits them locally.
5. **One live-status channel.** A private per-session Unix socket replaces the
   former signal files and avoids serializing live UI updates behind DB writes.
6. **Lazy session-DB migrations.** Central DB uses numbered migrations; per-session DBs use `IF NOT EXISTS` + ad-hoc `ALTER TABLE` helpers for older session folders.
7. **ACL = row existence.** `agent_destinations` membership is itself the permission — no separate `permissions` table.

---

## 6. Readers & writers — at a glance

| Table                    | DB       | Writer(s)                                              | Reader(s)                                      |
| ------------------------ | -------- | ------------------------------------------------------ | ---------------------------------------------- |
| `agent_groups`           | central  | `src/db/agent-groups.ts`                               | session resolver, delivery, router             |
| `messaging_groups`       | central  | `src/db/messaging-groups.ts`, channel setup            | router, delivery, session resolver             |
| `messaging_group_agents` | central  | `src/db/messaging-groups.ts`                           | router                                         |
| `users`                  | central  | `src/db/users.ts`, auth flows                          | permission checks                              |
| `user_roles`             | central  | `src/db/user-roles.ts`                                 | `src/access.ts`, all permission gates          |
| `agent_group_members`    | central  | `src/db/agent-group-members.ts`                        | membership checks                              |
| `user_dms`               | central  | `src/user-dm.ts` (`ensureUserDm`)                      | approval + pairing delivery                    |
| `sessions`               | central  | `src/db/sessions.ts`, `src/session-manager.ts`         | delivery, sweep, container runner              |
| `pending_questions`      | central  | `src/db/sessions.ts` (via `ask_user_question`)         | container response matcher                     |
| `agent_destinations`     | central  | `src/db/agent-destinations.ts`, migration 004 backfill | `writeDestinations()`, delivery ACL            |
| `pending_approvals`      | central  | `src/db/sessions.ts`, `src/onecli-approvals.ts`        | admin-card delivery, sweep                     |
| `unregistered_senders`   | central  | `src/db/dropped-messages.ts`                           | ops tooling                                    |
| `chat_sdk_*`             | central  | `src/state-sqlite.ts`                                  | Chat SDK bridge                                |
| `schema_version`         | central  | `src/db/migrations/index.ts`                           | migration runner                               |
| `messages_in`            | inbound  | `src/db/session-db.ts`                                 | `container/agent-runner/src/db/messages-in.ts` |
| `delivered`              | inbound  | `src/db/session-db.ts` (`markDelivered`)               | container edit/reaction targeting              |
| `destinations`           | inbound  | `writeDestinations()` in `src/session-manager.ts`      | container routing / ACL                        |
| `session_routing`        | inbound  | `writeSessionRouting()` in `src/session-manager.ts`    | container `send_message` defaults              |
| `messages_out`           | outbound | `container/agent-runner/src/db/messages-out.ts`        | `src/delivery.ts` poll loop                    |
| `processing_ack`         | outbound | `container/agent-runner/src/db/messages-in.ts`         | `src/host-sweep.ts` (`syncProcessingAcks`)     |
| `session_state`          | outbound | `container/agent-runner/src/db/session-state.ts`       | container on startup                           |
