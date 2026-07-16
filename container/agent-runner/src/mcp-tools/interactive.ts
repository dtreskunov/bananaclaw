/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question writes a durable question card and returns immediately.
 * The answer arrives as a future interactive_response provider turn.
 */
import { getCurrentInReplyTo } from '../current-batch.js';
import { openInboundDb, getOutboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
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

function hasOutstandingQuestion(): boolean {
  const outbound = getOutboundDb();
  const inbound = openInboundDb();
  try {
    const questions = outbound
      .prepare("SELECT content FROM messages_out WHERE kind = 'chat-sdk' AND content LIKE '%\"type\":\"ask_question\"%'")
      .all() as Array<{ content: string }>;
    const answered = new Set(
      (inbound
        .prepare("SELECT content FROM messages_in WHERE kind = 'interactive_response'")
        .all() as Array<{ content: string }>).flatMap((row) => {
          try {
            const content = JSON.parse(row.content) as { questionId?: string };
            return content.questionId ? [content.questionId] : [];
          } catch {
            return [];
          }
        }),
    );
    return questions.some((row) => {
      try {
        const content = JSON.parse(row.content) as { questionId?: string };
        return !!content.questionId && !answered.has(content.questionId);
      } catch {
        return false;
      }
    });
  } finally {
    inbound.close();
  }
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a durable question. The tool returns immediately; the answer arrives in a later turn. Supports choice, text, and choice_or_text responses.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
        responseMode: {
          type: 'string',
          enum: ['choice', 'text', 'choice_or_text'],
          description: 'How the user may answer',
        },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for choice and choice_or_text questions',
        },
        placeholder: { type: 'string', description: 'Placeholder for text input' },
        multiline: { type: 'boolean', description: 'Whether text input should allow multiple lines' },
      },
      required: ['title', 'question', 'responseMode'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const responseMode = args.responseMode as 'choice' | 'text' | 'choice_or_text';
    const rawOptions = (args.options as unknown[] | undefined) ?? [];
    if (!title || !question || !['choice', 'text', 'choice_or_text'].includes(responseMode)) {
      return err('title, question, and responseMode are required');
    }
    if (responseMode !== 'text' && rawOptions.length === 0) {
      return err('options are required for choice questions');
    }
    if (hasOutstandingQuestion()) {
      return err('A question is already awaiting the user response');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();

    // Write question card to outbound.db
    writeMessageOut({
      id: questionId,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        title,
        question,
        responseMode,
        options,
        placeholder: (args.placeholder as string) || undefined,
        multiline: args.multiline === true,
      }),
    });

    log(`ask_user_question: ${questionId} → "${question}"`);
    return ok(JSON.stringify({
      status: 'awaiting_user',
      questionId,
      message: 'The question was queued. Its answer will arrive in a later turn.',
    }));
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

registerTools([askUserQuestion, sendCard]);
