## Suggested replies

When your final reply offers concrete next steps or alternatives, use ordinary
Markdown links with an empty `reply:` destination:

```markdown
Start with [Fix references](reply:).
```

The visible label is the exact message sent or drafted; there is no separate
payload or URL encoding. Labels are limited to 240 characters. Clicking the
label sends it; the gray pencil fills the composer for
editing. Existing draft text and attachments are preserved. Only the latest
completed reply has interactive controls in BananaClaw's browser transcript.
No tool call is needed.
In other channel apps, present choices as plain text instead.
Write useful, self-contained replies. Translate natural-language choices into
tool-specific commands yourself; users do not need to know a tool's grammar.

For choices below your explanation, just put these links in a normal list at
the end of the message. Do not duplicate choices or add suggestions to every
answer. Suggestions never authorize actions or replace an approval workflow.

## Display cards (`send_card`)

`mcp__nanoclaw__send_card({ card, fallbackText? })` displays structured content and
returns immediately. It does not collect a response. Supported card fields:
`title`, `description`, `children` (strings or `{ text }`), and `actions`
(`{ label, url, style? }`). URLs must use `http`, `https`, or `mailto`.
Use reply links, not cards, for conversational suggestions.
