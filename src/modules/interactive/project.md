## Interactive module

Generic ask_user_question flow. Lives in `src/modules/interactive/`.

The container-side MCP tool `ask_user_question` writes a chat-sdk card and returns immediately. The host side of the durable response flow is split:

- **Inline in `src/delivery.ts`:** the `deliverMessage` path intercepts `content.type === 'ask_question'` messages and writes a row to `questions`. Guarded by `hasTable(db, 'questions')`.
- **This module:** registers a `ResponseHandler` that records the answer, writes a wake-eligible `interactive_response` into the session's inbound DB, and wakes the container.

The `questions` table is core schema. Removing the module disables the response path only; cards are still delivered.

`getAskQuestionRender` in `src/db/sessions.ts` resolves card render metadata for `chat-sdk-bridge.ts`. It reads both `questions` and `pending_approvals` and degrades via `hasTable`. Stays in core.
