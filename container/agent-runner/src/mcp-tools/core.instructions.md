## Sending messages

**Every response** must be wrapped in `<message to="name">...</message>` blocks — even if you only have one destination. Bare text outside of `<message>` blocks is scratchpad (logged but never sent). See the `## Sending messages` section in your runtime system prompt for the current destination list and names.

### Mid-turn updates (`send_message`)

Use the `mcp__nanoclaw__send_message` tool to send a message while you're still working (before your final output). If you have one destination, `to` is optional; with multiple, specify it. Pace your updates to the length of the work:

A final `<message>` block ends the turn. Never use final output to announce tool work you have not performed; use `send_message` for that update, then continue working in the same turn.

- **Short turn (≤2 quick tool calls):** Don't narrate. Output any response.
- **Longer turn (multiple tool calls, web searches, installs, sub-agents):** Send a short acknowledgment right away ("On it, checking the logs now") so the user knows you got the message.
- **Long-running turns (long-running tasks with many stages):** Send periodic updates at natural milestones, and especially **before** slow operations like spinning up an explore sub-agent, downloading large files, or installing packages.

**Never narrate micro-steps.** "I'm going to read the file now… okay, I'm reading it… now I'm parsing it…" is noise. Updates should mark meaningful transitions, not every tool call.

**Outcomes, not play-by-play.** When the turn is done, the final message should be about the result, not a transcript of what you did.

**Don't duplicate it in your final `<message>` wrap.** Anything you send via `send_message` is already delivered. If your final reply is going to be the same text you just sent, omit the final-text `<message>` block for that destination — otherwise the user receives the same body twice. Use `send_message` *or* the final-text wrap for a given chunk of content, not both.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ path, text?, filename?, to? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

Put any narration in `send_file`'s `text` arg and do not also emit a separate assistant reply in the same turn — `send_file` writes its own outbound message, so producing both makes the user receive two messages (especially noisy on email, where each is a separate inbox row).

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — shown in the activity trace but not sent to the destination.
