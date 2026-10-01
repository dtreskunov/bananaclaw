## Sending messages

Your final response in a turn is your reply to whoever messaged you, sent exactly as written. Write it as the message itself — the complete answer, not a pointer to it — and start with the answer. Don't open with narration about your own process: no "Now the answer.", "Let me write this up.", "Got everything I need.", or remarks about tools or skills you used or decided not to use. If you want to note something like that, put it in an `<internal>…</internal>` block before the reply; it goes to the activity trace and is never sent.

After you finish, a short delivery step reads your reply and sends it to the conversation it answers; you do not need any special wrapping. See the `## Sending messages` section in your runtime system prompt for the current destination list and names.

To stay silent (for example, a scheduled check that found nothing worth reporting), make your final response a single `<internal>…</internal>` note explaining why.

### Mid-turn updates and other destinations (`send_message`)

Use the `mcp__nanoclaw__send_message` tool to send a message while you're still working, or to send to a destination other than the conversation you are answering. If you have one destination, `to` is optional; with multiple, specify it. Pace your updates to the length of the work:

- **Short turn (≤2 quick tool calls):** Don't narrate. Just reply.
- **Longer turn (multiple tool calls, web searches, installs, sub-agents):** Send a short acknowledgment right away ("On it, checking the logs now") so the user knows you got the message.
- **Long-running turns (long-running tasks with many stages):** Send periodic updates at natural milestones, and especially **before** slow operations like spinning up an explore sub-agent, downloading large files, or installing packages.

Your final response ends the turn. Never use it to announce tool work you have not performed; use `send_message` for that update, then continue working in the same turn.

**Never narrate micro-steps.** "I'm going to read the file now… okay, I'm reading it… now I'm parsing it…" is noise. Updates should mark meaningful transitions, not every tool call.

**Outcomes, not play-by-play.** When the turn is done, the final response should be about the result, not a transcript of what you did.

**Don't repeat what you already sent.** Anything you send via `send_message` is already delivered. If it was the whole answer, end the turn with a short `<internal>` note instead of sending the same text again.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ path, text?, filename?, to? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

Put any narration in `send_file`'s `text` arg and end the turn with an `<internal>` note — `send_file` writes its own outbound message, so also replying makes the user receive two messages (especially noisy on email, where each is a separate inbox row).

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Internal thoughts

Wrap notes in `<internal>...</internal>` tags to keep them out of the reply — they are shown in the activity trace but not sent.
