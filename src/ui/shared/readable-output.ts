import type { ConversationMessage } from './conversation.js';
import { normalizeDisplayCardPayload } from '../../channels/display-card.js';
import { parseTimelinePosition } from './timeline.js';

export function chatSdkHistoryContent(content: string): Pick<ConversationMessage, 'text' | 'card' | 'timelinePosition'> | null {
  try {
    const payload = JSON.parse(content);
    const normalized = normalizeDisplayCardPayload(payload);
    if (!normalized || (!normalized.card && !normalized.fallbackText)) return null;
    const timelinePosition = parseTimelinePosition(payload?.timelinePosition);
    return {
      text: normalized.fallbackText,
      ...(normalized.card ? { card: normalized.card } : {}),
      ...(timelinePosition !== undefined ? { timelinePosition } : {}),
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function readableOutput(kind: string, content: string, turnPhase: string | null): boolean {
  if (kind === 'chat-sdk') return chatSdkHistoryContent(content) !== null;
  if (kind !== 'chat' && kind !== 'text') return false;
  const payload = JSON.parse(content) as {
    operation?: string; delivery_origin?: string; messageId?: string; text?: string; emoji?: string;
  } | null;
  if (payload?.operation === 'edit' && payload.messageId && typeof payload.text === 'string') return false;
  if (payload?.operation === 'reaction' && payload.messageId && payload.emoji) return false;
  return payload?.delivery_origin !== 'response' || turnPhase === null || turnPhase === 'settled';
}
