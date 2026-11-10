import type {
  Conversation,
  ConversationMessage,
  ConversationInteraction,
  ConversationTurn,
  ConversationActivity,
  ConversationTimelineRow,
} from './conversation.js';
import { isReadCursor } from './read-state.js';
import { isTurnUsageAdvisory } from './conversation.js';
import { isThinkingLevel } from './thinking-levels.js';
import { isEpochMs, UI_TIMESTAMP_PROTOCOL_VERSION } from './time.js';
import {
  applyCollection,
  diffCollection,
  entityId,
  sameValue,
  uniqueKeys,
  collectionPatchCheck,
  CollectionPatchError,
  type CollectionPatch,
} from './collection-patch.js';
import { accessRequestInput, ConnectionInputError } from './connection-input.js';
import {
  object,
  text,
  id,
  bool,
  number,
  integer,
  position,
  optional,
  nullable,
  array,
  oneOf,
  shape,
  type Check,
} from './validation.js';

export const CONVERSATION_PROTOCOL_VERSION = UI_TIMESTAMP_PROTOCOL_VERSION + 3;
export type EntityChanges<T> = CollectionPatch<T>;
export type ConversationTurnFields = Omit<ConversationTurn, 'activity'>;
export interface ConversationActivityPatch {
  turnId: string;
  changes: CollectionPatch<ConversationActivity, number>;
}
export interface ConversationChanges {
  readCursor?: Conversation['readCursor'] | null;
  messages?: EntityChanges<ConversationMessage>;
  turns?: EntityChanges<ConversationTurnFields>;
  activity?: ConversationActivityPatch[];
  interactions?: EntityChanges<ConversationInteraction>;
  connection?: Conversation['connection'];
  capabilities?: Conversation['capabilities'];
  timeline?: EntityChanges<ConversationTimelineRow>;
}
export interface ConversationSnapshot {
  kind: 'snapshot';
  protocolVersion: typeof CONVERSATION_PROTOCOL_VERSION;
  streamId: string;
  revision: number;
  conversation: Conversation;
}
export interface ConversationUpdate {
  kind: 'update';
  protocolVersion: typeof CONVERSATION_PROTOCOL_VERSION;
  streamId: string;
  baseRevision: number;
  revision: number;
  changes: ConversationChanges;
}
export type ConversationFrame = ConversationSnapshot | ConversationUpdate;

export class ConversationProtocolError extends Error {
  constructor(public readonly code: 'protocol_mismatch' | 'invalid_frame' | 'revision_gap' | 'unknown_stream') {
    super(
      code === 'protocol_mismatch'
        ? 'Chat protocol changed. Reload this page to load the current client.'
        : `Chat synchronization failed (${code}). Requesting a fresh snapshot.`,
    );
  }
}

const strings = array(id);
const usageFields = {
  reported_tokens: nullable(integer),
  cost_source: nullable(oneOf('reported', 'estimated', 'unavailable', 'mixed')),
  cost_usd: number,
  input_tokens: number,
  output_tokens: number,
  cache_read_tokens: number,
  cache_write_tokens: number,
  model: text,
  reasoning_tokens: optional(number),
  num_turns: optional(number),
  context_window: optional(number),
  max_output_tokens: optional(number),
  context_tokens: optional(number),
  duration_ms: optional(number),
  duration_api_ms: optional(number),
};
const reportedUsage = shape(
  Object.fromEntries(Object.entries(usageFields).map(([key, check]) => [key, optional(check)])),
);
const message = shape({
  id,
  direction: oneOf('in', 'out', 'event'),
  timestamp: isEpochMs,
  text,
  turnId: optional(id),
  timelinePosition: optional(integer),
  inputState: optional(
    shape({
      messageId: id,
      status: oneOf('queued', 'steering', 'applied', 'processing', 'cancelled'),
      turnId: optional(text),
      timelinePosition: optional(integer),
      queuedForNextTurn: optional(bool),
      reason: optional(oneOf('turn_finished', 'different_conversation', 'unsupported')),
    }),
  ),
  canEditPending: optional(bool),
  thinkingLevel: optional(isThinkingLevel),
  author: optional(
    (value) =>
      object(value) &&
      text(value.displayName) &&
      ((id(value.userId) && value.agentGroupId === undefined) ||
        (id(value.agentGroupId) && value.userId === undefined)),
  ),
  recipient: optional(shape({ agentGroupId: id, displayName: text })),
  deliveryOrigin: optional(oneOf('send_message', 'send_file', 'response')),
  systemGenerated: optional(bool),
  suggestedAction: optional(oneOf('continue', 'retry', 'report')),
  files: optional(
    array(
      shape({
        filename: text,
        size: number,
        path: optional(text),
        url: optional(text),
        contentType: optional(text),
      }),
    ),
  ),
  card: optional(
    shape({
      title: text,
      description: text,
      children: array(text),
      actions: array(shape({ label: text, url: text, style: optional(oneOf('primary', 'danger', 'default')) })),
    }),
  ),
  reactions: optional(array(shape({ emoji: text, ts: isEpochMs }))),
  event: optional(
    shape({
      kind: oneOf('task-run'),
      summary: text,
      taskId: optional(text),
      recurrence: optional(nullable(text)),
      status: optional(oneOf('running', 'ready', 'skipped', 'failed', 'timed_out', 'completed')),
      triggerSource: optional(oneOf('scheduled', 'manual')),
      error: optional(nullable(text)),
      autoPaused: optional(bool),
    }),
  ),
});
const activityLine = shape({ ordinal: integer, ts: isEpochMs, text, timelinePosition: position });
const turnFields = {
  id,
  phase: oneOf('running', 'stopping', 'settling', 'settled'),
  outcome: oneOf('pending', 'replied', 'warning', 'silent', 'stopped', 'failed', 'unknown', 'interrupted'),
  startedAt: nullable(isEpochMs),
  requestedAt: optional(nullable(isEpochMs)),
  endedAt: nullable(isEpochMs),
  inputIds: strings,
  outputIds: strings,
  usage: array(shape({ id, value: reportedUsage })),
  metadata: shape({
    status: oneOf('provisional', 'partial', 'final', 'unavailable'),
    model: nullable(text),
    durationMs: nullable(number),
    usageAdvisory: optional(nullable(isTurnUsageAdvisory)),
    thinkingLevel: optional(isThinkingLevel),
  }),
};
const turn = shape({ ...turnFields, activity: array(activityLine) });
const consentContext = {
  id,
  agentGroupId: nullable(text),
  agentGroupName: nullable(text),
  createdAt: isEpochMs,
  origin: optional(nullable(shape({ agentGroupId: id, threadId: id, channelType: id, messagingGroupId: id }))),
  decision: optional(nullable(text)),
  respondedBy: optional(nullable(shape({ userId: id, displayName: text }))),
  responseMessage: optional(nullable(text)),
  outcomeMessage: optional(nullable(text)),
  resolvedAt: optional(nullable(isEpochMs)),
};
const approval = shape({
  ...consentContext,
  kind: oneOf('confirmation'),
  action: text,
  title: text,
  details: nullable(text),
  packages: nullable(shape({ apt: array(text), npm: array(text), pip: array(text) })),
  options: array(shape({ label: text, selectedLabel: text, value: text })),
  status: oneOf('pending', 'applying', 'approved', 'rejected', 'failed', 'cancelled', 'expired'),
});
const requirements: Check = (value) => {
  try {
    accessRequestInput(value);
    return true;
  } catch (error) {
    if (error instanceof ConnectionInputError) return false;
    throw error;
  }
};
const account = shape({
  ...consentContext,
  kind: oneOf('account_setup', 'access_grant'),
  requirements,
  revision: integer,
  retryable: bool,
  expiresAt: nullable(isEpochMs),
  agentGroupId: id,
  agentGroupName: text,
  status: oneOf('pending', 'applying', 'completed', 'rejected', 'cancelled', 'expired', 'failed'),
  outcomeMessage: nullable(text),
  resolvedAt: nullable(isEpochMs),
});
const interaction: Check = (value) => approval(value) || account(value);
export function isConversationApproval(value: unknown): value is import('./approval.js').ConversationApproval {
  return approval(value) || account(value);
}
const tracePlacement = shape({ turnId: id, ordinals: array(integer), ownsTurn: bool });
const timelineRow: Check = (v) =>
  shape({ kind: oneOf('message'), messageId: id, trace: optional(tracePlacement), statsTurnId: optional(id) })(v) ||
  shape({ kind: oneOf('interaction'), interactionId: id, trace: optional(tracePlacement) })(v) ||
  shape({ kind: oneOf('turn'), turnId: id, afterId: nullable(id), trace: tracePlacement, status: bool })(v);
const connection = shape({ connected: bool, activeTurnId: nullable(id) });
const capabilities = shape({
  thinking: optional(
    shape({
      levels: array(oneOf('none', 'low', 'medium', 'high', 'xhigh', 'max')),
      defaultLevel: nullable(text),
    }),
  ),
  canSend: bool,
  stop: bool,
  stopTool: optional(bool),
  steer: bool,
  editInput: bool,
  cancelInput: bool,
});
const conversation = shape({
  readCursor: optional(isReadCursor),
  threadId: id,
  messages: array(message),
  turns: array(turn),
  interactions: array(interaction),
  timeline: array(timelineRow),
  connection,
  capabilities,
});
const changes = (entity: Check) => optional(collectionPatchCheck(entity, id));

/** Validate before touching reactive state; unsupported servers never enter a legacy path. */
export function parseConversationFrame(value: unknown): ConversationFrame {
  if (!object(value) || value.protocolVersion !== CONVERSATION_PROTOCOL_VERSION)
    throw new ConversationProtocolError('protocol_mismatch');
  if (!id(value.streamId) || !integer(value.revision)) throw new ConversationProtocolError('invalid_frame');
  if (value.kind === 'snapshot' && conversation(value.conversation)) return value as unknown as ConversationSnapshot;
  if (
    value.kind === 'update' &&
    integer(value.baseRevision) &&
    value.revision === Number(value.baseRevision) + 1 &&
    shape({
      readCursor: optional(nullable(isReadCursor)),
      messages: changes(message),
      turns: changes((value) => shape(turnFields)(value) && object(value) && value.activity === undefined),
      activity: optional(array(shape({ turnId: id, changes: collectionPatchCheck(activityLine, integer) }))),
      interactions: changes(interaction),
      connection: optional(connection),
      capabilities: optional(capabilities),
      timeline: changes(timelineRow),
    })(value.changes)
  )
    return value as unknown as ConversationUpdate;
  throw new ConversationProtocolError('invalid_frame');
}

const activityOrdinal = (line: ConversationActivity) => line.ordinal;
const timelineKey = (row: ConversationTimelineRow): string =>
  row.kind === 'message'
    ? JSON.stringify([row.kind, row.messageId])
    : row.kind === 'interaction'
      ? JSON.stringify([row.kind, row.interactionId])
      : JSON.stringify([row.kind, row.turnId, row.afterId]);
function validateTimeline(view: Conversation): void {
  const messages = new Set(
    view.messages.filter((message) => message.inputState?.status !== 'cancelled').map((message) => message.id),
  );
  const interactions = new Set(view.interactions.map((item) => item.id));
  const turns = new Map(view.turns.map((turn) => [turn.id, turn]));
  for (const turn of view.turns) uniqueKeys(turn.activity, activityOrdinal);
  const seenRows = new Set<string>();
  const seenActivity = new Set<string>();
  const owners = new Set<string>();
  const statsHosts = new Set<string>();
  for (const row of view.timeline) {
    const key =
      row.kind === 'message'
        ? `message:${row.messageId}`
        : row.kind === 'interaction'
          ? `interaction:${row.interactionId}`
          : `turn:${row.turnId}:after:${row.afterId}`;
    if (seenRows.has(key)) throw new ConversationProtocolError('invalid_frame');
    seenRows.add(key);
    if (row.kind === 'message') {
      if (!messages.delete(row.messageId)) throw new ConversationProtocolError('invalid_frame');
      if (row.statsTurnId && turns.get(row.statsTurnId)?.phase !== 'settled')
        throw new ConversationProtocolError('invalid_frame');
      if (row.statsTurnId) {
        if (statsHosts.has(row.statsTurnId)) throw new ConversationProtocolError('invalid_frame');
        statsHosts.add(row.statsTurnId);
      }
    } else if (row.kind === 'interaction') {
      if (!interactions.delete(row.interactionId)) throw new ConversationProtocolError('invalid_frame');
    } else if (!turns.has(row.turnId) || row.trace.turnId !== row.turnId) {
      throw new ConversationProtocolError('invalid_frame');
    }
    if (!row.trace) continue;
    const turn = turns.get(row.trace.turnId);
    if (!turn) throw new ConversationProtocolError('invalid_frame');
    if (row.trace.ownsTurn) {
      if (owners.has(turn.id)) throw new ConversationProtocolError('invalid_frame');
      owners.add(turn.id);
    }
    const ordinals = new Set(turn.activity.map((line) => line.ordinal));
    for (const ordinal of row.trace.ordinals) {
      const activityKey = `${turn.id}:${ordinal}`;
      if (!ordinals.has(ordinal) || seenActivity.has(activityKey)) throw new ConversationProtocolError('invalid_frame');
      seenActivity.add(activityKey);
    }
  }
  if (
    messages.size ||
    interactions.size ||
    view.turns.some((turn) => turn.activity.some((line) => !seenActivity.has(`${turn.id}:${line.ordinal}`)))
  )
    throw new ConversationProtocolError('invalid_frame');
}

/** Atomic and pure. Duplicates are idempotent; gaps and unknown streams require a snapshot. */
function applyConversation(state: ConversationSnapshot | null, frame: ConversationFrame): ConversationSnapshot {
  if (frame.kind === 'snapshot') {
    if (state?.streamId === frame.streamId && frame.revision <= state.revision) return state;
    uniqueKeys(frame.conversation.messages, entityId);
    uniqueKeys(frame.conversation.turns, entityId);
    uniqueKeys(frame.conversation.interactions, entityId);
    validateTimeline(frame.conversation);
    return frame;
  }
  if (!state || state.streamId !== frame.streamId) throw new ConversationProtocolError('unknown_stream');
  if (frame.revision <= state.revision) return state;
  if (frame.baseRevision !== state.revision) throw new ConversationProtocolError('revision_gap');
  const changes = frame.changes;
  const oldTurns = new Map(state.conversation.turns.map((turn) => [turn.id, turn]));
  let turns = applyCollection(
    state.conversation.turns,
    changes.turns && {
      ...changes.turns,
      upserts: changes.turns.upserts.map((turn) => ({ ...turn, activity: oldTurns.get(turn.id)?.activity ?? [] })),
    },
    entityId,
  );
  if (changes.activity) {
    uniqueKeys(changes.activity, (patch) => patch.turnId);
    const patches = new Map(changes.activity.map((patch) => [patch.turnId, patch.changes]));
    if (changes.activity.some((patch) => !turns.some((turn) => turn.id === patch.turnId)))
      throw new ConversationProtocolError('invalid_frame');
    turns = turns.map((turn) =>
      patches.has(turn.id)
        ? { ...turn, activity: applyCollection(turn.activity, patches.get(turn.id), activityOrdinal) }
        : turn,
    );
  }
  const next: ConversationSnapshot = {
    kind: 'snapshot',
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    streamId: state.streamId,
    revision: frame.revision,
    conversation: {
      threadId: state.conversation.threadId,
      messages: applyCollection(state.conversation.messages, changes.messages, entityId),
      turns,
      interactions: applyCollection(state.conversation.interactions, changes.interactions, entityId),
      timeline: applyCollection(state.conversation.timeline, changes.timeline, timelineKey),
      connection: changes.connection ?? state.conversation.connection,
      capabilities: changes.capabilities ?? state.conversation.capabilities,
      readCursor: changes.readCursor === undefined ? state.conversation.readCursor : (changes.readCursor ?? undefined),
    },
  };
  validateTimeline(next.conversation);
  return next;
}

export function reduceConversation(state: ConversationSnapshot | null, frame: ConversationFrame): ConversationSnapshot {
  try {
    return applyConversation(state, frame);
  } catch (error) {
    if (error instanceof CollectionPatchError) throw new ConversationProtocolError('invalid_frame');
    throw error;
  }
}
export function diffConversation(before: Conversation, after: Conversation): ConversationChanges {
  if (before.threadId !== after.threadId) throw new ConversationProtocolError('invalid_frame');
  const fields = (turn: ConversationTurn): ConversationTurnFields => {
    const { activity: _activity, ...rest } = turn;
    return rest;
  };
  const oldTurns = new Map(before.turns.map((turn) => [turn.id, turn]));
  const activity = after.turns.flatMap((turn): ConversationActivityPatch[] => {
    const changes = diffCollection(oldTurns.get(turn.id)?.activity ?? [], turn.activity, activityOrdinal);
    return changes ? [{ turnId: turn.id, changes }] : [];
  });
  return {
    messages: diffCollection(before.messages, after.messages, entityId),
    turns: diffCollection(before.turns.map(fields), after.turns.map(fields), entityId),
    ...(activity.length ? { activity } : {}),
    interactions: diffCollection(before.interactions, after.interactions, entityId),
    connection: sameValue(before.connection, after.connection) ? undefined : after.connection,
    capabilities: sameValue(before.capabilities, after.capabilities) ? undefined : after.capabilities,
    readCursor: sameValue(before.readCursor, after.readCursor) ? undefined : (after.readCursor ?? null),
    timeline: diffCollection(before.timeline, after.timeline, timelineKey),
  };
}
