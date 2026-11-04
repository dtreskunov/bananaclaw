import type { ConversationApproval } from './approval.js';
import type { AttentionTarget } from './attention.js';
import type { ConversationSnapshot } from './conversation-protocol.js';
import type { ThreadSummary } from './thread.js';
import type { VoiceInputCapability } from './voice.js';
import { isAttentionTargets } from './attention.js';
import { isConversationApproval } from './conversation-protocol.js';

export interface SyncResponse {
  approvals: ConversationApproval[];
  attention: AttentionTarget[];
  threads?: ThreadSummary[];
  conversation?: ConversationSnapshot;
  voiceInput?: VoiceInputCapability;
  groupAccess?: boolean;
}

export const SYNC_PROTOCOL_VERSION = 1;
export interface SyncSubscription {
  kind: 'subscribe';
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  subscriptionId: number;
  groupId: string | null;
}
export interface SyncFrame {
  kind: 'sync';
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  streamId: string;
  subscriptionId: number;
  revision: number;
  groupId: string | null;
  data: Omit<SyncResponse, 'conversation'>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string';
const optional = (value: unknown, check: (v: unknown) => boolean) => value === undefined || check(value);
const nullableText = (value: unknown) => value === null || text(value);

function thread(value: unknown): value is ThreadSummary {
  if (!object(value)) return false;
  return (
    ['threadId', 'sessionId', 'channelType', 'messagingGroupId', 'platformId', 'title', 'lastActivityAt'].every((key) =>
      text(value[key]),
    ) &&
    ['per-thread', 'shared', 'agent-shared'].includes(String(value.sessionMode)) &&
    integer(value.messageCount) &&
    optional(value.canSend, (v) => typeof v === 'boolean') &&
    optional(value.kind, (v) => v === 'thread' || v === 'dm') &&
    optional(value.counterparty, text) &&
    ['totalCost', 'totalTokens', 'turnCount'].every((key) =>
      optional(value[key], (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    ) &&
    optional(
      value.liveTasks,
      (v) =>
        Array.isArray(v) &&
        v.every(
          (task) =>
            object(task) &&
            text(task.seriesId) &&
            nullableText(task.nextRunAt) &&
            nullableText(task.recurrence) &&
            text(task.summary) &&
            typeof task.paused === 'boolean',
        ),
    ) &&
    optional(
      value.forkedFrom,
      (v) =>
        object(v) &&
        text(v.threadId) &&
        text(v.messageId) &&
        nullableText(v.title) &&
        (v.fidelity === 'native' || v.fidelity === 'transcript') &&
        typeof v.deleted === 'boolean',
    ) &&
    optional(
      value.forkChildren,
      (v) =>
        Array.isArray(v) &&
        v.every((child) => object(child) && text(child.threadId) && text(child.messageId) && text(child.title)),
    )
  );
}

export function isSyncSubscription(value: unknown): value is SyncSubscription {
  return (
    object(value) &&
    value.kind === 'subscribe' &&
    value.protocolVersion === SYNC_PROTOCOL_VERSION &&
    integer(value.subscriptionId) &&
    (value.groupId === null || (text(value.groupId) && value.groupId.length > 0 && value.groupId.length <= 512))
  );
}

function isSyncFrame(value: unknown): value is SyncFrame {
  if (!object(value)) return false;
  const data = value.data;
  if (
    value.kind !== 'sync' ||
    !text(value.streamId) ||
    !value.streamId ||
    !integer(value.subscriptionId) ||
    !integer(value.revision) ||
    !(value.groupId === null || text(value.groupId)) ||
    !object(data) ||
    !Array.isArray(data.approvals) ||
    !data.approvals.every(isConversationApproval) ||
    !isAttentionTargets(data.attention) ||
    !optional(data.threads, (v) => Array.isArray(v) && v.every(thread)) ||
    !optional(data.groupAccess, (v) => typeof v === 'boolean') ||
    !optional(
      data.voiceInput,
      (v) =>
        object(v) &&
        (v.backend === 'disabled' || v.backend === 'elevenlabs') &&
        typeof v.ready === 'boolean' &&
        optional(v.reason, text),
    ) ||
    (value.groupId !== null &&
      (!Array.isArray(data.threads) || typeof data.groupAccess !== 'boolean' || !data.voiceInput))
  )
    return false;
  return true;
}

export class SyncProtocolError extends Error {
  constructor() {
    super('Sync protocol changed. Reload this page to load the current client.');
  }
}

export function parseSyncFrame(value: unknown): SyncFrame {
  if (!object(value) || value.protocolVersion !== SYNC_PROTOCOL_VERSION) throw new SyncProtocolError();
  if (!isSyncFrame(value)) throw new Error('Invalid global sync snapshot. Reconnect or reload.');
  return value;
}
