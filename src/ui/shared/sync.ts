import type { ConversationApproval } from './approval.js';
import type { AttentionTarget } from './attention.js';
import type { ConversationSnapshot } from './conversation-protocol.js';
import type { ThreadSummary } from './thread.js';
import type { VoiceInputCapability } from './voice.js';

export interface SyncResponse {
  approvals: ConversationApproval[];
  attention: AttentionTarget[];
  threads?: ThreadSummary[];
  conversation?: ConversationSnapshot;
  voiceInput?: VoiceInputCapability;
}
