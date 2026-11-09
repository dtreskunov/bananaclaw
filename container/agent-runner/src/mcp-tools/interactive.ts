/**
 * Response suggestions and display cards.
 */
import { getTurnContext } from '../current-batch.js';
import { isSuggestedResponses, stageSuggestedResponses } from '../suggested-responses.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './tool-registry.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const suggestResponses: McpToolDefinition = {
  tool: {
    name: 'suggest_responses',
    description:
      "Suggest optional reply drafts beneath your final response in BananaClaw's browser transcript. For inline placement, use [label](reply:<URI-encoded draft>) in your final Markdown instead; the label may differ from the draft and no tool call is needed. Other channel apps receive your normal response without draft buttons. Finish explaining in your response; this tool sends no separate message and never waits for input. Clicking a suggestion fills the normal composer for editing, not sending. Users may ignore every suggestion. A later call replaces this turn's suggestions. Suggestions are discarded if the turn has no successful final reply. Never use this for authorization.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        responses: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 240 },
          description: 'Up to six distinct suggested user messages; button text is exactly the editable draft text.',
        },
      },
      required: ['responses'],
    },
  },
  async handler(args) {
    if (!isSuggestedResponses(args.responses))
      return err('responses must contain 1–6 distinct nonblank messages, each at most 240 characters');
    const context = getTurnContext();
    if (!context) return err('suggest_responses requires an active response turn');
    stageSuggestedResponses(context, args.responses);
    log(`suggest_responses: ${context.turnId}`);
    return ok(
      JSON.stringify({
        status: 'registered',
        message: 'Finish your response. Optional reply drafts will appear beneath its final message.',
      }),
    );
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: 'Send a structured card (interactive or display-only) to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          description: 'Display card with text content and optional URL actions',
          properties: {
            title: { type: 'string', description: 'Compact card heading' },
            description: { type: 'string', description: 'Primary card body text' },
            children: {
              type: 'array',
              description: 'Additional text blocks',
              items: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                ],
              },
            },
            actions: {
              type: 'array',
              description: 'Links displayed as buttons; callback actions are not supported',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  url: { type: 'string', description: 'Absolute http, https, or mailto URL' },
                  style: { type: 'string', enum: ['primary', 'danger', 'default'] },
                },
                required: ['label', 'url'],
              },
            },
          },
        },
        fallbackText: { type: 'string', description: 'Text fallback for platforms without card support' },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');

    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card, fallbackText: (args.fallbackText as string) || '' }),
    });

    log(`send_card: ${id}`);
    return ok(`Card sent (id: ${id})`);
  },
};

registerTools([suggestResponses, sendCard]);
