import type { ConversationApproval } from './approval.js';
import type { AttentionTarget } from './attention.js';
import {
  CONVERSATION_PROTOCOL_VERSION,
  parseConversationFrame,
  type ConversationFrame,
  type ConversationSnapshot,
} from './conversation-protocol.js';
import type { ThreadSummary } from './thread.js';
import type { VoiceInputCapability } from './voice.js';
import { isAttentionTargets } from './attention.js';
import { isConversationApproval } from './conversation-protocol.js';
import { object, text, id, bool, number, integer, optional, nullable, array, oneOf, shape } from './validation.js';

export interface SyncResponse {
  approvals: ConversationApproval[];
  attention: AttentionTarget[];
  threads?: ThreadSummary[];
  conversation?: ConversationSnapshot;
  voiceInput?: VoiceInputCapability;
}

export interface SyncGroupState {
  threads: ThreadSummary[];
  voiceInput: VoiceInputCapability;
}
export interface GlobalSyncState {
  approvals: ConversationApproval[];
  attention: AttentionTarget[];
  group: SyncGroupState | null;
}

export const SYNC_PROTOCOL_VERSION = CONVERSATION_PROTOCOL_VERSION;
export const SYNC_RELOAD_CLOSE_CODE = 4406;
export interface SyncConversation {
  threadId: string;
  channelType: string;
  messagingGroupId: string | null;
}
export interface SyncSubscription {
  kind: 'subscribe';
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  subscriptionId: number;
  groupId: string | null;
  conversation: SyncConversation | null;
}
export interface SyncFrame {
  kind: 'sync';
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  subscriptionId: number;
  groupId: string | null;
  global?: GlobalSyncState;
  conversation?: ConversationFrame | null;
}

const thread = shape({
  threadId: id,
  sessionId: id,
  channelType: id,
  messagingGroupId: id,
  platformId: text,
  title: text,
  lastActivityAt: text,
  sessionMode: oneOf('per-thread', 'shared', 'agent-shared'),
  messageCount: integer,
  canSend: optional(bool),
  kind: optional(oneOf('thread', 'dm')),
  counterparty: optional(text),
  totalCost: optional(number),
  totalTokens: optional(number),
  turnCount: optional(number),
  liveTasks: optional(
    array(
      shape({
        seriesId: id,
        nextRunAt: nullable(text),
        recurrence: nullable(text),
        summary: text,
        paused: bool,
      }),
    ),
  ),
  forkedFrom: optional(
    shape({
      threadId: id,
      messageId: id,
      title: nullable(text),
      fidelity: oneOf('native', 'transcript'),
      deleted: bool,
    }),
  ),
  forkChildren: optional(array(shape({ threadId: id, messageId: id, title: text }))),
});
const groupId = (value: unknown) => text(value) && value.length > 0 && value.length <= 512;
const subscription = shape({
  kind: oneOf('subscribe'),
  protocolVersion: (value) => value === SYNC_PROTOCOL_VERSION,
  subscriptionId: integer,
  groupId: nullable(groupId),
  conversation: nullable(
    shape({
      threadId: groupId,
      channelType: groupId,
      messagingGroupId: nullable(groupId),
    }),
  ),
});
const frame = shape({
  kind: oneOf('sync'),
  subscriptionId: integer,
  groupId: nullable(groupId),
  global: optional(
    shape({
      approvals: array(isConversationApproval),
      attention: isAttentionTargets,
      group: nullable(
        shape({
          threads: array(thread),
          voiceInput: shape({ backend: oneOf('disabled', 'elevenlabs'), ready: bool, reason: optional(text) }),
        }),
      ),
    }),
  ),
});

export function isSyncSubscription(value: unknown): value is SyncSubscription {
  return (
    object(value) &&
    subscription(value) &&
    (value.conversation === null ||
      (value.groupId !== null &&
        object(value.conversation) &&
        (value.conversation.channelType === 'web' || value.conversation.messagingGroupId !== null)))
  );
}

function isSyncFrame(value: unknown): value is SyncFrame {
  return frame(value);
}

export class SyncProtocolError extends Error {
  constructor() {
    super('Sync protocol changed. Reload this page to load the current client.');
  }
}

export function parseSyncFrame(value: unknown): SyncFrame {
  if (!object(value) || value.kind === 'protocol_mismatch' || value.protocolVersion !== SYNC_PROTOCOL_VERSION)
    throw new SyncProtocolError();
  if (
    !isSyncFrame(value) ||
    (value.global === undefined && value.conversation === undefined) ||
    (value.groupId === null && (value.global?.group != null || value.conversation != null))
  )
    throw new Error('Invalid synchronization frame. Reconnect or reload.');
  if (value.conversation != null) {
    if (object(value.conversation) && value.conversation.protocolVersion !== SYNC_PROTOCOL_VERSION)
      throw new SyncProtocolError();
    parseConversationFrame(value.conversation);
  }
  return value;
}
