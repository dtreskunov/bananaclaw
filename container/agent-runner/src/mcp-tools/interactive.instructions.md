## Interactive prompts

The two tools here solve different problems: `ask_user_question` queues a durable question whose answer arrives in a later turn; `send_card` displays structured content and moves on.

### Asking a durable question (`ask_user_question`)

`mcp__nanoclaw__ask_user_question({ title, question, responseMode, options?, placeholder?, multiline? })` presents the user with a durable question and returns immediately. The answer arrives as a `<question_response>` in a later turn. Only one question may be outstanding at a time.

`responseMode` is `choice`, `text`, or `choice_or_text`. Choice modes require `options`.

`options` can be plain strings or `{ label, selectedLabel?, value? }` objects:
- `label` — the button text shown before selection
- `selectedLabel` — the text shown on the button *after* selection (useful for confirmations, e.g. `"✓ Confirmed"`)
- `value` — the string returned to you when that option is chosen (defaults to `label`)

Use this when you genuinely cannot proceed without a decision or structured response. End the current turn after queueing it; continue when the later response arrives.

### Structured cards (`send_card`)

`mcp__nanoclaw__send_card({ card, fallbackText? })` renders a structured card and **returns immediately** — it does not pause your turn or collect a response.

`card` supports: `title`, `description`, `children` (strings or `{ text }` blocks), and `actions` (`{ label, url, style? }`). Action URLs must use `http`, `https`, or `mailto`; actions are links only and do not return a value. `fallbackText` is sent as a plain message on platforms without card support.

Use this for presenting information in a cleaner format than prose: summaries, options the user can read (but you're not waiting on), or results with contextual buttons. If you need the user to actually *choose* something and return a value, use `ask_user_question` instead.