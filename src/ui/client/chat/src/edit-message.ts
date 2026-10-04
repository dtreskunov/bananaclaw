import type { ChatMessage } from './types';
import { splitQueuedFollowups } from './queued-followups';

/**
 * Return the message after which an edit branch should be cut. Non-conversation
 * timeline rows are deliberately skipped because the fork endpoint only needs
 * the conversational context that preceded the message being edited.
 */
export function findEditBranchAnchorId(messages: ChatMessage[], targetMessageId: string): string | null {
  let previousId: string | null = null;
  const { transcript } = splitQueuedFollowups(messages);
  for (const message of transcript) {
    if (message.id === targetMessageId) return previousId;
    if ((message.direction === 'in' || message.direction === 'out') && message.id) {
      previousId = message.id;
    }
  }
  return null;
}
