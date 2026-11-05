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
import {
  applyCollection,
  collectionPatchCheck,
  diffCollection,
  entityId,
  sameValue,
  uniqueKeys,
  CollectionPatchError,
  type CollectionPatch,
} from './collection-patch.js';

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
export interface ProjectionCursor {
  streamId: string;
  revision: number;
}
export interface GlobalSnapshot extends ProjectionCursor {
  kind: 'snapshot';
  data: GlobalSyncState;
}
export interface GlobalChanges {
  approvals?: CollectionPatch<ConversationApproval>;
  attention?: CollectionPatch<AttentionTarget>;
  group?:
    | { kind: 'replace'; value: SyncGroupState | null }
    | {
        kind: 'update';
        threads?: CollectionPatch<ThreadSummary>;
        voiceInput?: VoiceInputCapability;
      };
}
export interface GlobalUpdate extends ProjectionCursor {
  kind: 'update';
  baseRevision: number;
  changes: GlobalChanges;
}
export type GlobalFrame = GlobalSnapshot | GlobalUpdate;
export interface GlobalProjection extends GlobalSnapshot {
  groupId: string | null;
}
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
  globalCursor: ProjectionCursor | null;
}
export interface SyncFrame {
  kind: 'sync';
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  subscriptionId: number;
  groupId: string | null;
  global?: GlobalFrame;
  conversation?: ConversationFrame | null;
}
export type AppliedSyncFrame = Omit<SyncFrame, 'global'> & { global?: GlobalSyncState };

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
  activity: oneOf('idle', 'running', 'waiting'),
  activityStale: optional(bool),
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
const cursor = shape({ streamId: id, revision: integer });
const voiceInput = shape({ backend: oneOf('disabled', 'elevenlabs'), ready: bool, reason: optional(text) });
const groupState = shape({ threads: array(thread), voiceInput });
const globalState = shape({
  approvals: array(isConversationApproval),
  attention: isAttentionTargets,
  group: nullable(groupState),
});
const groupChanges = (value: unknown) =>
  shape({ kind: oneOf('replace'), value: nullable(groupState) })(value) ||
  shape({
    kind: oneOf('update'),
    threads: optional(collectionPatchCheck(thread, id)),
    voiceInput: optional(voiceInput),
  })(value);
const globalFrame = (value: unknown) =>
  cursor(value) &&
  (shape({ kind: oneOf('snapshot'), data: globalState })(value) ||
    (object(value) &&
      integer(value.baseRevision) &&
      value.revision === Number(value.baseRevision) + 1 &&
      shape({
        kind: oneOf('update'),
        changes: shape({
          approvals: optional(collectionPatchCheck(isConversationApproval, id)),
          attention: optional(collectionPatchCheck((item) => isAttentionTargets([item]), id)),
          group: optional(groupChanges),
        }),
      })(value)));
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
  globalCursor: nullable(cursor),
});
const frame = shape({
  kind: oneOf('sync'),
  subscriptionId: integer,
  groupId: nullable(groupId),
  global: optional(globalFrame),
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
    (value.groupId === null &&
      (value.conversation != null || (value.global?.kind === 'snapshot' && value.global.data.group !== null)))
  )
    throw new Error('Invalid synchronization frame. Reconnect or reload.');
  if (value.conversation != null) {
    if (object(value.conversation) && value.conversation.protocolVersion !== SYNC_PROTOCOL_VERSION)
      throw new SyncProtocolError();
    parseConversationFrame(value.conversation);
  }
  return value;
}

export class SyncStateError extends Error {
  constructor(public readonly code: 'invalid_frame' | 'revision_gap' | 'unknown_stream') {
    super(`Metadata synchronization failed (${code}). Reconnect for a fresh snapshot.`);
  }
}

export const threadKey = (thread: Pick<ThreadSummary, 'threadId' | 'channelType' | 'messagingGroupId'>): string =>
  JSON.stringify([thread.channelType, thread.messagingGroupId, thread.threadId]);

export function diffGlobal(before: GlobalProjection, after: GlobalSyncState, groupId: string | null): GlobalChanges {
  let group: GlobalChanges['group'];
  if (before.groupId !== groupId || (before.data.group === null) !== (after.group === null))
    group = { kind: 'replace', value: after.group };
  else if (before.data.group && after.group) {
    const threads = diffCollection(before.data.group.threads, after.group.threads, threadKey);
    const voiceInput = sameValue(before.data.group.voiceInput, after.group.voiceInput)
      ? undefined
      : after.group.voiceInput;
    if (threads || voiceInput) group = { kind: 'update', threads, voiceInput };
  }
  return {
    approvals: diffCollection(before.data.approvals, after.approvals, entityId),
    attention: diffCollection(before.data.attention, after.attention, entityId),
    group,
  };
}

export function reduceGlobal(
  state: GlobalProjection | null,
  frame: GlobalFrame,
  groupId: string | null,
): GlobalProjection {
  try {
    let data: GlobalSyncState;
    if (frame.kind === 'snapshot') {
      if (state?.streamId === frame.streamId && frame.revision <= state.revision) return state;
      data = frame.data;
    } else {
      if (!state || state.streamId !== frame.streamId) throw new SyncStateError('unknown_stream');
      if (frame.revision <= state.revision) return state;
      if (frame.baseRevision !== state.revision) throw new SyncStateError('revision_gap');
      const patch = frame.changes;
      let group = state.data.group;
      if (patch.group?.kind === 'replace') group = patch.group.value;
      else {
        if (state.groupId !== groupId) throw new SyncStateError('invalid_frame');
        if (patch.group) {
          if (!group) throw new SyncStateError('invalid_frame');
          group = {
            threads: applyCollection(group.threads, patch.group.threads, threadKey),
            voiceInput: patch.group.voiceInput ?? group.voiceInput,
          };
        }
      }
      data = {
        approvals: applyCollection(state.data.approvals, patch.approvals, entityId),
        attention: applyCollection(state.data.attention, patch.attention, entityId),
        group,
      };
    }
    if (!globalState(data) || (groupId === null && data.group !== null)) throw new SyncStateError('invalid_frame');
    uniqueKeys(data.approvals, entityId);
    uniqueKeys(data.attention, entityId);
    if (data.group) uniqueKeys(data.group.threads, threadKey);
    return { kind: 'snapshot', streamId: frame.streamId, revision: frame.revision, groupId, data };
  } catch (error) {
    if (error instanceof CollectionPatchError) throw new SyncStateError('invalid_frame');
    throw error;
  }
}
