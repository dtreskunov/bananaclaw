import type { Conversation, ConversationMessage, ConversationQuestion, ConversationTurn } from './conversation.js';

export const CONVERSATION_PROTOCOL_VERSION = 1;
export interface EntityChanges<T> {
  upserts: T[];
  removeIds: string[];
  order: string[];
}
export interface ConversationChanges {
  messages: EntityChanges<ConversationMessage>;
  turns: EntityChanges<ConversationTurn>;
  questions: EntityChanges<ConversationQuestion>;
  connection: Conversation['connection'];
  capabilities: Conversation['capabilities'];
}
export interface ConversationSnapshot {
  kind: 'snapshot';
  protocolVersion: 1;
  streamId: string;
  revision: number;
  conversation: Conversation;
}
export interface ConversationUpdate {
  kind: 'update';
  protocolVersion: 1;
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

type Check = (v: unknown) => boolean;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text: Check = (v) => typeof v === 'string';
const id: Check = (v) => typeof v === 'string' && v.length > 0;
const bool: Check = (v) => typeof v === 'boolean';
const number: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer: Check = (v) => number(v) && Number.isSafeInteger(v);
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const array =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v);
const shape =
  (fields: Record<string, Check>): Check =>
  (v) =>
    object(v) && Object.entries(fields).every(([key, check]) => check(v[key]));
const strings = array(id);
const trace = shape({ ts: text, text });
const usageFields = {
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
};
const usage = shape(usageFields);
const reportedUsage = shape(
  Object.fromEntries(Object.entries(usageFields).map(([key, check]) => [key, optional(check)])),
);
const message = shape({
  id,
  direction: oneOf('in', 'out', 'internal', 'event'),
  timestamp: text,
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
  author: optional(shape({ userId: id, displayName: text })),
  deliveryOrigin: optional(oneOf('send_message', 'send_file', 'response')),
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
  reactions: optional(array(shape({ emoji: text, ts: text }))),
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
const turn = shape({
  id,
  phase: oneOf('running', 'stopping', 'settling', 'settled'),
  outcome: oneOf('pending', 'replied', 'warning', 'silent', 'stopped', 'failed', 'unknown', 'interrupted'),
  startedAt: nullable(text),
  endedAt: nullable(text),
  inputIds: strings,
  outputIds: strings,
  activity: array(shape({ ordinal: integer, ts: text, text })),
  usage: array(shape({ id, value: reportedUsage })),
  metadata: shape({
    status: oneOf('provisional', 'partial', 'final', 'unavailable'),
    model: nullable(text),
    durationMs: nullable(number),
  }),
  liveUsage: nullable(usage),
});
const question = shape({
  questionId: id,
  title: text,
  question: text,
  responseMode: oneOf('choice', 'text', 'choice_or_text'),
  options: array(shape({ label: text, selectedLabel: text, value: text })),
  status: oneOf('pending', 'answered', 'cancelled'),
  answerValue: nullable(text),
  answerType: nullable(oneOf('choice', 'text')),
  answeredAt: nullable(text),
  activity: optional(array(trace)),
  turnId: optional(id),
  threadId: nullable(text),
  agentGroupId: id,
  createdAt: text,
});
const connection = shape({ connected: bool, activeTurnId: nullable(id) });
const capabilities = shape({ canSend: bool, stop: bool, steer: bool, editInput: bool, cancelInput: bool });
const conversation = shape({
  threadId: id,
  messages: array(message),
  turns: array(turn),
  questions: array(question),
  connection,
  capabilities,
});
const changes = (entity: Check) => shape({ upserts: array(entity), removeIds: strings, order: strings });

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
      messages: changes(message),
      turns: changes(turn),
      questions: changes(question),
      connection,
      capabilities,
    })(value.changes)
  )
    return value as unknown as ConversationUpdate;
  throw new ConversationProtocolError('invalid_frame');
}

function keyOf<T extends { id: string } | { questionId: string }>(entity: T): string {
  return 'id' in entity ? entity.id : entity.questionId;
}
function unique<T extends { id: string } | { questionId: string }>(entities: T[]): void {
  if (new Set(entities.map(keyOf)).size !== entities.length) throw new ConversationProtocolError('invalid_frame');
}
function applyEntities<T extends { id: string } | { questionId: string }>(prior: T[], delta: EntityChanges<T>): T[] {
  unique(delta.upserts);
  const values = new Map(prior.map((entity) => [keyOf(entity), entity]));
  for (const id of delta.removeIds) values.delete(id);
  for (const entity of delta.upserts) values.set(keyOf(entity), entity);
  if (
    new Set(delta.order).size !== delta.order.length ||
    delta.order.length !== values.size ||
    delta.order.some((id) => !values.has(id))
  )
    throw new ConversationProtocolError('invalid_frame');
  return delta.order.map((id) => values.get(id)!);
}

/** Atomic and pure. Duplicates are idempotent; gaps and unknown streams require a snapshot. */
export function reduceConversation(state: ConversationSnapshot | null, frame: ConversationFrame): ConversationSnapshot {
  if (frame.kind === 'snapshot') {
    if (state?.streamId === frame.streamId && frame.revision <= state.revision) return state;
    unique(frame.conversation.messages);
    unique(frame.conversation.turns);
    unique(frame.conversation.questions);
    return frame;
  }
  if (!state || state.streamId !== frame.streamId) throw new ConversationProtocolError('unknown_stream');
  if (frame.revision <= state.revision) return state;
  if (frame.baseRevision !== state.revision) throw new ConversationProtocolError('revision_gap');
  const changes = frame.changes;
  return {
    kind: 'snapshot',
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    streamId: state.streamId,
    revision: frame.revision,
    conversation: {
      threadId: state.conversation.threadId,
      messages: applyEntities(state.conversation.messages, changes.messages),
      turns: applyEntities(state.conversation.turns, changes.turns),
      questions: applyEntities(state.conversation.questions, changes.questions),
      connection: changes.connection,
      capabilities: changes.capabilities,
    },
  };
}

function diffEntities<T extends { id: string } | { questionId: string }>(before: T[], after: T[]): EntityChanges<T> {
  const old = new Map(before.map((entity) => [keyOf(entity), JSON.stringify(entity)]));
  const order = after.map(keyOf);
  const retained = new Set(order);
  return {
    upserts: after.filter((entity) => old.get(keyOf(entity)) !== JSON.stringify(entity)),
    removeIds: [...old.keys()].filter((id) => !retained.has(id)),
    order,
  };
}
export function diffConversation(before: Conversation, after: Conversation): ConversationChanges {
  if (before.threadId !== after.threadId) throw new ConversationProtocolError('invalid_frame');
  return {
    messages: diffEntities(before.messages, after.messages),
    turns: diffEntities(before.turns, after.turns),
    questions: diffEntities(before.questions, after.questions),
    connection: after.connection,
    capabilities: after.capabilities,
  };
}
