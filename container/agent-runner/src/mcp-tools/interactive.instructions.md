## Optional reply drafts and display cards

### Suggesting responses (`suggest_responses`)

When your final reply offers concrete next steps or alternatives, or asks the user to choose, offer optional reply drafts using either inline links or `mcp__nanoclaw__suggest_responses({ responses })`. Do not wait until you are blocked: these are conversational shortcuts, not required answers.

For inline placement in a BananaClaw browser conversation, write a Markdown link with a `reply:` destination containing the URI-encoded full draft:

```markdown
Start with [Fix references](reply:Please%20fix%20the%20dangling%20references%20first.).
```

The short label and full draft can differ. The link renders as a distinctive inline reply control; hover or focus previews the draft. Clicking fills the composer and never sends. Encode spaces as `%20`, percent signs as `%25`, and other URL-reserved characters as needed. Inline drafts also have a 240-character limit after decoding. No tool call is needed for inline suggestions.

Use the tool for a separate row of buttons below your completed reply. You may combine inline and separate suggestions when useful, but do not duplicate the same choice in both places.

For example, after explaining a cleanup plan:

```json
{"responses":["Fix references first","Reclaim disk space","Run broader verification"]}
```

`responses` contains 1-6 distinct, nonblank messages of at most 240 characters each. Use concise, useful replies the user might actually send. These separate buttons use the draft itself as their label; inline links allow shorter labels.

Explain the choices in your final reply. The tool returns immediately and sends no separate message. Buttons appear beneath the completed reply in BananaClaw's browser transcript; clicking fills the normal composer without sending. The user can edit the draft, type something else, or ignore every suggestion. Their eventual message arrives as ordinary chat.

Only the latest completed reply offers active suggestions. After a follow-up, separate buttons disappear and inline labels remain as ordinary text. Older messages, file previews, and the full-screen reader do not offer interactive reply links.

Do not add suggestions to every answer: omit them when there is no useful next choice, when the user requested only a result, or when they would be repetitive. Suggestions never authorize actions or replace an approval workflow. Other channel apps receive your normal reply without these buttons.

A later call replaces this turn's suggestions. Finish with a normal final reply: suggestions are discarded if the turn is silent, fails, is stopped, or has no final response.

### Structured cards (`send_card`)

`mcp__nanoclaw__send_card({ card, fallbackText? })` renders a structured card and **returns immediately** — it does not pause your turn or collect a response.

`card` supports: `title`, `description`, `children` (strings or `{ text }` blocks), and `actions` (`{ label, url, style? }`). Action URLs must use `http`, `https`, or `mailto`; actions are links only and do not return a value. `fallbackText` is sent as a plain message on platforms without card support.

Use this for presenting information in a cleaner format than prose: summaries or results with contextual links. For optional conversational reply buttons, use `suggest_responses`, not a display card.