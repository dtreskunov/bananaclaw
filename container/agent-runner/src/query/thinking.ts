import type { MessageInRow } from '../db/messages-in.js';

export function messageThinkingLevel(message: MessageInRow): string | undefined {
  if (message.channel_type !== 'web' || message.kind !== 'chat' || message.trigger !== 1) return undefined;
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  if (!content || typeof content !== 'object' || !('thinkingLevel' in content)) return undefined;
  if (typeof content.thinkingLevel !== 'string') throw new Error('Invalid message thinking level');
  return content.thinkingLevel;
}

/** An override owns its turn; accumulated context may precede it, but no other triggered input. */
export function thinkingBatch(messages: MessageInRow[]): MessageInRow[] {
  const index = messages.findIndex((message) => messageThinkingLevel(message) !== undefined);
  if (index < 0) return messages;
  return messages.slice(0, messages.slice(0, index).some((message) => message.trigger === 1) ? index : index + 1);
}

export function batchThinkingLevel(messages: MessageInRow[]): string | undefined {
  return messages.map(messageThinkingLevel).find((level) => level !== undefined);
}
