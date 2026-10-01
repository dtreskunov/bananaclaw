import { InvalidToolInputError, jsonSchema, tool, type ToolCallRepairFunction, type ToolSet } from 'ai';

import { findByName, getAllDestinations } from '../../destinations.js';
import type { ProviderReply } from '../types.js';

export const REPLY_TOOL = 'reply';
export const NO_REPLY_TOOL = 'no_reply';

export function isReplyTool(name: unknown): boolean {
  return name === REPLY_TOOL || name === NO_REPLY_TOOL;
}

/** Sent as a transient user message when a reply only points at undelivered text. */
export const POINTER_REPLY_PROMPT =
  '<system>That reply was not sent: it refers to text the user cannot see. Text outside the reply tool is never delivered. Call reply again with the complete message itself.</system>';

const POINTER_MAX_CHARS = 300;
const POINTER_MIN_UNDELIVERED_CHARS = 400;
const POINTER_PATTERN = /\b(?:above|earlier|previous (?:message|response|reply))\b/i;

/** Replies and silence the model sent this turn through its reply tools. */
export class ReplyCollector {
  readonly replies: ProviderReply[] = [];
  silence: string | null = null;
  /** Reply-tool calls since the last `takeStepCalls()`. */
  private stepCalls = 0;
  private malformedReplies = 0;

  record(reply: ProviderReply): void {
    this.replies.push(reply);
    this.stepCalls++;
  }

  recordSilence(reason: string): void {
    this.silence = reason;
    this.stepCalls++;
  }

  takeStepCalls(): number {
    const calls = this.stepCalls;
    this.stepCalls = 0;
    return calls;
  }

  /** Drop the most recent `count` replies (a rejected pointer reply). */
  discardLast(count: number): ProviderReply[] {
    return this.replies.splice(this.replies.length - count, count);
  }

  noteMalformedReply(): number {
    return ++this.malformedReplies;
  }
}

function destinationNames(): string[] {
  try {
    return getAllDestinations().map((destination) => destination.name);
  } catch {
    return [];
  }
}

function knownDestination(name: string): boolean {
  try {
    return Boolean(findByName(name));
  } catch {
    // No session DB (e.g. a bare provider run): routing is validated at dispatch.
    return true;
  }
}

export function createReplyTools(collector: ReplyCollector): ToolSet {
  const names = destinationNames();
  const toDescription =
    names.length > 1
      ? `Destination name. Omit to answer the conversation you are replying to. One of: ${names.join(', ')}.`
      : 'Destination name. Omit to answer the conversation you are replying to.';
  return {
    [REPLY_TOOL]: tool({
      description:
        'Send your message to the user. This is the only way anything you write reaches them, and it ends your turn: finish all other work first, then call reply once with the complete message, written exactly as they should read it (Markdown is fine).',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The complete message, sent verbatim.' },
          to: { type: 'string', description: toDescription },
        },
        required: ['text'],
      }),
      execute: async (input) => {
        const { text, to } = input as { text: string; to?: string };
        if (!text.trim()) throw new Error('text is empty. Write the message, or call no_reply to send nothing.');
        const target = to?.trim() || undefined;
        if (target && !knownDestination(target)) {
          throw new Error(`Unknown destination "${target}". Known destinations: ${names.join(', ') || '(none)'}.`);
        }
        collector.record({ text, ...(target ? { to: target } : {}) });
        return 'Queued for delivery.';
      },
    }),
    [NO_REPLY_TOOL]: tool({
      description:
        'End your turn without sending anything, for example a scheduled check that found nothing worth reporting, or when everything was already delivered with send_message or send_file. Never use it to skip answering a person.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why nothing is sent. Shown only in the activity trace.' } },
        required: ['reason'],
      }),
      execute: async (input) => {
        collector.recordSilence(String((input as { reason: string }).reason ?? '').trim() || 'No reply needed.');
        return 'Ending the turn without a reply.';
      },
    }),
  };
}

/** True when a short reply only points at text the user never received. */
export function isPointerReply(text: string, undeliveredChars: number): boolean {
  return (
    undeliveredChars >= POINTER_MIN_UNDELIVERED_CHARS &&
    text.trim().length <= POINTER_MAX_CHARS &&
    POINTER_PATTERN.test(text)
  );
}

/** Best-effort recovery of `text` (and `to`) from reply arguments that are not valid JSON. */
export function salvageReplyInput(raw: string): { text: string; to?: string } | null {
  const start = /"text"\s*:\s*"/.exec(raw);
  if (!start) return null;
  let body = raw.slice(start.index + start[0].length);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      i++;
    } else if (body[i] === '"') {
      body = body.slice(0, i);
      break;
    }
  }
  body = body.replace(/\\$/, '');
  let text: string;
  try {
    text = JSON.parse(`"${body}"`) as string;
  } catch {
    text = body
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (!text.trim()) return null;
  const to = /"to"\s*:\s*"([^"\\]+)"/.exec(raw)?.[1];
  return { text, ...(to ? { to } : {}) };
}

/**
 * The first malformed `reply` goes back to the model as a tool error so it can
 * resend; a second one is salvaged from the raw arguments rather than lost.
 */
export function replyRepair(collector: ReplyCollector): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error }) => {
    if (toolCall.toolName !== REPLY_TOOL || !InvalidToolInputError.isInstance(error)) return null;
    if (collector.noteMalformedReply() < 2) return null;
    const salvaged = salvageReplyInput(toolCall.input);
    if (!salvaged) return null;
    console.error(`[native-provider] Salvaged a malformed reply (${salvaged.text.length} chars)`);
    return { ...toolCall, input: JSON.stringify(salvaged) };
  };
}
