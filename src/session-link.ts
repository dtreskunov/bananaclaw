import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { reduceActivityLines } from './activity.js';
import type { ActivityLine, UsageSnapshot } from './channels/adapter.js';
import { CONTAINER_MAX_OUTPUT_SIZE, DATA_DIR } from './config.js';
import { log } from './log.js';
import { invalidateConversation } from './conversation-events.js';
import { applyDurableRunnerEvent, type DurableApplyResult } from './session-link-durable.js';
import {
  isAny,
  isCount,
  isRecord,
  isRecordValue,
  isSafeInteger,
  isSessionTurnId,
  isString,
  isTimestamp,
  isTrue,
  isTurnIdOrNull,
  parseTurnState,
  required,
  sanitizeActivityStep,
  sanitizeFields,
  sanitizeUsage,
  type FieldSpec,
} from './session-link-validate.js';
import { getSession } from './db/sessions.js';
import { indexMessage, deleteMessageFromIndex } from './search-index.js';
import { INPUT_EDIT_PREFIX, INPUT_CANCEL_PREFIX, type EditedInput } from './pending-input-edit.js';

const PROTOCOL_VERSION = 5;
export const SESSION_LINK_VERSION = 'v5';
const MAX_LIVE_FRAME_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = Math.ceil((CONTAINER_MAX_OUTPUT_SIZE * 4) / 3) + 2 * 1024 * 1024;
const MAX_FRAME_BYTES_PER_SECOND = 24 * 1024 * 1024;
const MAX_GLOBAL_FRAMES_PER_SECOND = 512;
const MAX_GLOBAL_FRAME_BYTES_PER_SECOND = 32 * 1024 * 1024;
const MAX_FRAMES_PER_SECOND = 256;
const MAX_CONNECTIONS_PER_SECOND = 32;
const MAX_ACTIVITY_LINES = 128;
const HOST_ACK_TIMEOUT_MS = 10_000;

type SignalKind = 'disconnected' | 'heartbeat' | 'activity' | 'usage' | 'turn.end' | 'turn.state' | 'input.state';

export interface SessionActiveTurn {
  id: string;
  status: 'running' | 'stopping';
  channelType: string;
  platformId: string;
  threadId: string | null;
  supportsSteering?: boolean;
  supportsInputEditing?: boolean;
  supportsInputCancellation?: boolean;
}

export type SessionTurnStopResult =
  | { accepted: true; turn: SessionActiveTurn }
  | { accepted: false; error: 'invalid_turn_id' | 'not_active' | 'disconnected' };

export { isSessionTurnId };

interface SessionSignalState {
  connected: boolean;
  serverStartedAt: number;
  lastSeenAt: number;
  rateWindowStartedAt: number;
  framesThisWindow: number;
  frameBytesThisWindow: number;
  connectionWindowStartedAt: number;
  connectionsThisWindow: number;
  activity: Array<ActivityLine & { turnId: string | null; ordinal: number; timelinePosition: number }>;
  usageTurnId: string | null;
  usage: UsageSnapshot | null;
  usageUpdatedAt: number;
  turnEndedAt: number;
  activeTurn: SessionActiveTurn | null;
  turnStateReady: boolean;
}

interface SessionSignalServer {
  agentGroupId: string | null;
  server: net.Server;
  connection: net.Socket | null;
  suspended: boolean;
  relistenTimer: NodeJS.Timeout | null;
  hostInFlight: { eventId: string; sequence: number } | null;
  hostAckTimer: NodeJS.Timeout | null;
  hostReadySent: boolean;
  stopRequest: { turnId: string; promise: Promise<SessionTurnStopResult> } | null;
}

type SignalListener = (sessionId: string, kind: SignalKind) => void;
type DurableMessageListener = (sessionId: string) => void;
type DurableProcessingListener = (sessionId: string) => void;

const servers = new Map<string, SessionSignalServer>();
const states = new Map<string, SessionSignalState>();
const listeners = new Set<SignalListener>();
const durableMessageListeners = new Set<DurableMessageListener>();
const durableProcessingListeners = new Set<DurableProcessingListener>();
export interface SessionTurnChange {
  turnIds: string[];
  settledTurnId?: string;
  reason: 'committed' | 'runner-exited';
}
const turnChangeListeners = new Set<(sessionId: string, change: SessionTurnChange) => void>();

/** Called only after commit (or confirmed runner exit), never from live frames. */
export function onSessionTurnChange(listener: (sessionId: string, change: SessionTurnChange) => void): () => void {
  turnChangeListeners.add(listener);
  return () => turnChangeListeners.delete(listener);
}

function notifyTurnChange(sessionId: string, change: SessionTurnChange): void {
  invalidateConversation(sessionId);
  for (const listener of turnChangeListeners) {
    try { listener(sessionId, change); }
    catch (err) { log.warn('Turn change listener failed', { sessionId, err }); }
  }
}

/** Exit is not successful settlement; a replacement runner journals interruption. */
export function confirmSessionRunnerExit(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  state.connected = false;
  state.turnStateReady = false;
  notifyTurnChange(sessionId, {
    turnIds: state.activeTurn ? [state.activeTurn.id] : [],
    reason: 'runner-exited',
  });
}
let globalRateWindowStartedAt = 0;
let globalFramesThisWindow = 0;
let globalFrameBytesThisWindow = 0;

function inboundPath(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
}

function hostWirePayload(eventType: string, value: unknown): unknown {
  if (eventType !== 'message.upsert') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid host message event');
  const payload = value as Record<string, unknown>;
  if (typeof payload.content_hex !== 'string' || !/^(?:[A-Fa-f0-9]{2})*$/.test(payload.content_hex)) {
    throw new Error('invalid host message content');
  }
  const content = Buffer.from(payload.content_hex, 'hex');
  if (content.length > CONTAINER_MAX_OUTPUT_SIZE) throw new Error('invalid host message content');
  const { content_hex: _contentHex, ...rest } = payload;
  return { ...rest, content_base64: content.toString('base64') };
}

function flushHostEvents(sessionId: string, entry: SessionSignalServer): void {
  const connection = entry.connection;
  if (!entry.agentGroupId || !connection?.writable || connection.connecting || entry.hostInFlight) return;
  const db = new Database(inboundPath(entry.agentGroupId, sessionId));
  try {
    const pending = db
      .prepare('SELECT sequence, event_id, event_type, payload FROM pending_host_events ORDER BY sequence LIMIT 1')
      .get() as { sequence: number; event_id: string; event_type: string; payload: string } | undefined;
    if (!pending) {
      if (!entry.hostReadySent) {
        connection.write(`${JSON.stringify({ v: PROTOCOL_VERSION, type: 'host.ready' })}\n`);
        entry.hostReadySent = true;
      }
      return;
    }
    const frame = {
      v: PROTOCOL_VERSION,
      type: 'host.event',
      eventId: pending.event_id,
      sequence: pending.sequence,
      event: { type: pending.event_type, payload: hostWirePayload(pending.event_type, JSON.parse(pending.payload)) },
    };
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES)
      throw new Error(`host event ${pending.sequence} exceeds wire limit`);
    connection.write(encoded);
    entry.hostInFlight = { eventId: pending.event_id, sequence: pending.sequence };
    entry.hostAckTimer = setTimeout(() => {
      if (entry.connection === connection && entry.hostInFlight?.eventId === pending.event_id) connection.destroy();
    }, HOST_ACK_TIMEOUT_MS);
    entry.hostAckTimer.unref?.();
  } catch (err) {
    log.error('Failed to send host session event', { sessionId, err });
    connection.destroy();
  } finally {
    db.close();
  }
}

function applyHostAck(frame: Record<string, unknown>, { sessionId, entry }: FrameContext): boolean {
  const inFlight = entry.hostInFlight;
  if (!entry.agentGroupId || !inFlight || inFlight.eventId !== frame.eventId) return false;
  const db = new Database(inboundPath(entry.agentGroupId, sessionId));
  try {
    db.prepare('DELETE FROM pending_host_events WHERE event_id = ? AND sequence = ?').run(
      inFlight.eventId,
      inFlight.sequence,
    );
  } finally {
    db.close();
  }
  if (entry.hostAckTimer) clearTimeout(entry.hostAckTimer);
  entry.hostAckTimer = null;
  entry.hostInFlight = null;
  flushHostEvents(sessionId, entry);
  return true;
}

function applyHostNack(frame: Record<string, unknown>, { sessionId, entry }: FrameContext): boolean {
  const inFlight = entry.hostInFlight;
  if (!inFlight || inFlight.eventId !== frame.eventId) return false;
  log.error('Runner rejected host session event', {
    sessionId,
    sequence: inFlight.sequence,
    error: (frame.error as string).slice(0, 256),
  });
  entry.connection?.destroy();
  return true;
}

export function notifySessionHostState(sessionId: string): void {
  invalidateConversation(sessionId);
  const entry = servers.get(sessionId);
  if (entry) flushHostEvents(sessionId, entry);
}

function decodeDurablePayload(eventType: string, value: unknown): unknown {
  if (eventType !== 'message.upsert') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid wire message payload');
  const payload = value as Record<string, unknown>;
  if (typeof payload.content_base64 !== 'string' || 'content' in payload)
    throw new Error('invalid wire message content');
  const encoded = payload.content_base64;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('invalid base64 message content');
  }
  const content = Buffer.from(encoded, 'base64');
  if (content.length > CONTAINER_MAX_OUTPUT_SIZE || content.toString('base64') !== encoded) {
    throw new Error('invalid base64 message content');
  }
  const { content_base64: _contentBase64, ...rest } = payload;
  return { ...rest, content: content.toString('utf8') };
}

const DURABLE_EVENT_FIELDS: readonly FieldSpec[] = [required('type', isString), required('payload', isAny)];

function applyDurableFrame(frame: Record<string, unknown>, { sessionId, entry }: FrameContext): boolean {
  const agentGroupId = entry.agentGroupId;
  const wireEvent = frame.event as Record<string, unknown>;
  if (!agentGroupId || !sanitizeFields(wireEvent, DURABLE_EVENT_FIELDS)) return false;
  const eventId = frame.eventId as string;
  const event = {
    type: wireEvent.type as string,
    payload: decodeDurablePayload(wireEvent.type as string, wireEvent.payload),
  };
  const result = applyDurableRunnerEvent(agentGroupId, sessionId, {
    eventId,
    sequence: frame.sequence as number,
    event,
  });
  entry.connection?.write(`${JSON.stringify({ v: PROTOCOL_VERSION, type: 'ack', eventId })}\n`);
  publishDurableEffects(sessionId, entry, agentGroupId, event, result);
  return true;
}

/** Fan-out after a durable runner event has committed and been acknowledged. */
function publishDurableEffects(
  sessionId: string,
  entry: SessionSignalServer,
  agentGroupId: string,
  event: { type: string; payload: unknown },
  result: DurableApplyResult,
): void {
  if (result.changedTurnIds) {
    notifyTurnChange(sessionId, {
      turnIds: result.changedTurnIds,
      ...(result.settledTurnId ? { settledTurnId: result.settledTurnId } : {}),
      reason: 'committed',
    });
  }
  if (result.deliveryReady) {
    for (const listener of durableMessageListeners) listener(sessionId);
  }
  if (result.processingReady) {
    for (const listener of durableProcessingListeners) listener(sessionId);
  }
  if (result.editedInput) {
    reindexEditedInput(sessionId, agentGroupId, result.editedInput);
    flushHostEvents(sessionId, entry);
  }
  if (isInputStateEvent(event)) emit(sessionId, 'input.state');
}

function reindexEditedInput(sessionId: string, agentGroupId: string, input: EditedInput): void {
  try {
    if (input.cancelled) deleteMessageFromIndex(input.id, agentGroupId, sessionId);
    else
      indexMessage(
        {
          id: input.id,
          sessionId,
          agentGroupId,
          messagingGroupId: getSession(sessionId)?.messaging_group_id ?? null,
          channelType: input.channel_type,
          threadId: input.thread_id,
          direction: 'in',
          timestamp: input.timestamp,
          text: input.text,
          senderUserId: input.sender_user_id,
        },
        { replaceText: true },
      );
  } catch (err) {
    log.warn('Failed to update pending-input search index', { sessionId, messageId: input.id, err });
  }
}

function isInputStateEvent({ type, payload }: { type: string; payload: unknown }): boolean {
  if (type === 'processing.upsert' || type === 'processing.delete') return true;
  const key =
    type === 'state.upsert' && payload && typeof payload === 'object' && 'key' in payload ? payload.key : null;
  return (
    typeof key === 'string' &&
    (key.startsWith('input:') || key.startsWith(INPUT_EDIT_PREFIX) || key.startsWith(INPUT_CANCEL_PREFIX))
  );
}

function emptyState(): SessionSignalState {
  return {
    connected: false,
    serverStartedAt: 0,
    lastSeenAt: 0,
    rateWindowStartedAt: 0,
    framesThisWindow: 0,
    frameBytesThisWindow: 0,
    connectionWindowStartedAt: 0,
    connectionsThisWindow: 0,
    activity: [],
    usageTurnId: null,
    usage: null,
    usageUpdatedAt: 0,
    turnEndedAt: 0,
    activeTurn: null,
    turnStateReady: false,
  };
}

function stateFor(sessionId: string): SessionSignalState {
  let state = states.get(sessionId);
  if (!state) {
    state = emptyState();
    states.set(sessionId, state);
  }
  return state;
}

function emit(sessionId: string, kind: SignalKind): void {
  if (kind !== 'heartbeat') invalidateConversation(sessionId);
  for (const listener of listeners) {
    try {
      listener(sessionId, kind);
    } catch (err) {
      log.warn('Session link listener failed', { sessionId, kind, err });
    }
  }
}

export function onSessionSignal(listener: SignalListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onSessionDurableMessage(listener: DurableMessageListener): () => void {
  durableMessageListeners.add(listener);
  return () => durableMessageListeners.delete(listener);
}

export function onSessionDurableProcessing(listener: DurableProcessingListener): () => void {
  durableProcessingListeners.add(listener);
  return () => durableProcessingListeners.delete(listener);
}

function socketKey(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
}

export function sessionLinkDir(sessionId: string): string {
  return path.join(DATA_DIR, '.session-links', socketKey(sessionId));
}

export function sessionLinkSocketPath(sessionId: string): string {
  const socketPath = path.join(sessionLinkDir(sessionId), 'runner.sock');
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error(`Session link socket path is too long for a Unix socket: ${socketPath}`);
  }
  return socketPath;
}

interface FrameContext {
  sessionId: string;
  entry: SessionSignalServer;
  state: SessionSignalState;
  now: number;
}

type FrameHandler = (frame: Record<string, unknown>, ctx: FrameContext) => boolean;

/** Mutates live state and names the signal to emit ('silent' for none), or returns false to reject. */
type LiveFrameHandler = (frame: Record<string, unknown>, ctx: FrameContext) => SignalKind | 'silent' | false;

/** Live frames are telemetry: they refresh `lastSeenAt` and never touch the session DBs. */
function live(handler: LiveFrameHandler): FrameHandler {
  return (frame, ctx) => {
    const signal = handler(frame, ctx);
    if (signal === false) return false;
    ctx.state.lastSeenAt = ctx.now;
    if (signal !== 'silent') emit(ctx.sessionId, signal);
    return true;
  };
}

/** Keeps a host-initiated 'stopping' status when the runner replays the same turn as running. */
function mergeStopping(
  next: SessionActiveTurn | null,
  current: SessionActiveTurn | null,
  stopRequest: SessionSignalServer['stopRequest'],
): SessionActiveTurn | null {
  const keep = next && next.id === current?.id && current.status === 'stopping' && stopRequest?.turnId === next.id;
  return keep ? { ...next, status: 'stopping' } : next;
}

function applyTurnState(frame: Record<string, unknown>, { entry, state }: FrameContext): SignalKind | false {
  const turn = parseTurnState(frame.turn);
  if (turn === false) return false;
  if (entry.stopRequest?.turnId !== turn?.id) entry.stopRequest = null;
  state.activeTurn = mergeStopping(turn, state.activeTurn, entry.stopRequest);
  state.turnStateReady = true;
  return 'turn.state';
}

function applyActivity(frame: Record<string, unknown>, { state }: FrameContext): SignalKind | false {
  const step = sanitizeActivityStep(frame.step);
  if (!step) return false;
  const turnId = frame.turnId as string | null;
  const ordinal = frame.ordinal as number;
  state.activity = state.activity.filter((line) => line.turnId !== turnId || line.ordinal !== ordinal);
  state.activity.push({ ts: frame.ts as string, text: JSON.stringify(step), turnId, ordinal,
    timelinePosition: frame.timelinePosition as number });
  if (state.activity.length > MAX_ACTIVITY_LINES) state.activity.splice(0, state.activity.length - MAX_ACTIVITY_LINES);
  return 'activity';
}

function applyUsage(frame: Record<string, unknown>, { state }: FrameContext): SignalKind | false {
  const usage = sanitizeUsage(frame.usage);
  if (!usage) return false;
  state.usage = usage;
  state.usageUpdatedAt = Number(frame.ts);
  state.usageTurnId = frame.turnId as string | null;
  return 'usage';
}

interface FrameSpec {
  fields: readonly FieldSpec[];
  apply: FrameHandler;
}

/** Frame fields are all required; nested records are validated by the handler. */
function frameSpec(fields: readonly FieldSpec[], apply: FrameHandler): FrameSpec {
  return { fields: [required('v', isAny), required('type', isAny), ...fields], apply };
}

const FRAME_SPECS = new Map<string, FrameSpec>([
  ['host.ack', frameSpec([required('eventId', isString)], applyHostAck)],
  [
    'host.nack',
    frameSpec([required('eventId', isString), required('fatal', isTrue), required('error', isString)], applyHostNack),
  ],
  [
    'durable',
    frameSpec(
      [required('eventId', isString), required('sequence', isSafeInteger), required('event', isRecordValue)],
      applyDurableFrame,
    ),
  ],
  ['turn.state', frameSpec([required('turn', isAny)], live(applyTurnState))],
  [
    'activity',
    frameSpec(
      [
        required('step', isAny),
        required('turnId', isTurnIdOrNull),
        required('ts', isTimestamp),
        required('ordinal', isCount),
        required('timelinePosition', (value) => Number.isSafeInteger(value) && Number(value) > 0),
      ],
      live(applyActivity),
    ),
  ],
  [
    'usage',
    frameSpec(
      [required('usage', isAny), required('turnId', isTurnIdOrNull), required('ts', isTimestamp)],
      live(applyUsage),
    ),
  ],
  [
    'heartbeat',
    frameSpec(
      [],
      live(() => 'heartbeat'),
    ),
  ],
  [
    'activity.clear',
    frameSpec(
      [],
      live((_frame, { state }) => {
        state.activity = [];
        return 'activity';
      }),
    ),
  ],
  [
    'usage.clear',
    frameSpec(
      [],
      live((_frame, { state }) => {
        state.usage = null;
        state.usageUpdatedAt = 0;
        return 'usage';
      }),
    ),
  ],
  [
    'turn.resume',
    frameSpec(
      [],
      live((_frame, { state }) => {
        state.turnEndedAt = 0;
        return 'silent';
      }),
    ),
  ],
  [
    'turn.end',
    frameSpec(
      [],
      live((_frame, { state, now }) => {
        state.turnEndedAt = now;
        return 'turn.end';
      }),
    ),
  ],
]);

function applyFrame(sessionId: string, entry: SessionSignalServer, raw: unknown): boolean {
  if (!isRecord(raw) || raw.v !== PROTOCOL_VERSION || typeof raw.type !== 'string') return false;
  const spec = FRAME_SPECS.get(raw.type);
  if (!spec || !sanitizeFields(raw, spec.fields)) return false;
  return spec.apply(raw, { sessionId, entry, state: stateFor(sessionId), now: Date.now() });
}

function handleConnection(sessionId: string, entry: SessionSignalServer, connection: net.Socket): void {
  const state = stateFor(sessionId);
  const connectedAt = Date.now();
  if (connectedAt - state.connectionWindowStartedAt >= 1_000) {
    state.connectionWindowStartedAt = connectedAt;
    state.connectionsThisWindow = 0;
  }
  state.connectionsThisWindow++;
  if (state.connectionsThisWindow > MAX_CONNECTIONS_PER_SECOND) {
    connection.destroy();
    suspendSessionSignalServer(sessionId, entry);
    return;
  }
  if (entry.connection && !entry.connection.destroyed) {
    connection.destroy();
    return;
  }
  entry.connection = connection;
  state.connected = true;
  state.turnStateReady = false;
  entry.stopRequest = null;
  entry.hostReadySent = false;
  flushHostEvents(sessionId, entry);

  let buffer = '';
  connection.setEncoding('utf8');
  connection.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        connection.destroy();
        return;
      }
      const now = Date.now();
      if (now - state.rateWindowStartedAt >= 1_000) {
        state.rateWindowStartedAt = now;
        state.framesThisWindow = 0;
        state.frameBytesThisWindow = 0;
      }
      state.framesThisWindow++;
      state.frameBytesThisWindow += Buffer.byteLength(line);
      if (now - globalRateWindowStartedAt >= 1_000) {
        globalRateWindowStartedAt = now;
        globalFramesThisWindow = 0;
        globalFrameBytesThisWindow = 0;
      }
      globalFramesThisWindow++;
      globalFrameBytesThisWindow += Buffer.byteLength(line);
      if (
        state.framesThisWindow > MAX_FRAMES_PER_SECOND ||
        state.frameBytesThisWindow > MAX_FRAME_BYTES_PER_SECOND ||
        globalFramesThisWindow > MAX_GLOBAL_FRAMES_PER_SECOND ||
        globalFrameBytesThisWindow > MAX_GLOBAL_FRAME_BYTES_PER_SECOND
      ) {
        connection.destroy();
        return;
      }
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type !== 'durable' && Buffer.byteLength(line) > MAX_LIVE_FRAME_BYTES) {
          connection.destroy();
          return;
        }
        if (!applyFrame(sessionId, entry, parsed)) {
          log.warn('Rejected session link frame', {
            sessionId,
            type: typeof parsed.type === 'string' ? parsed.type.slice(0, 128) : 'invalid',
          });
          connection.destroy();
          return;
        }
        flushHostEvents(sessionId, entry);
      } catch (err) {
        if (parsed?.type === 'durable' && typeof parsed.eventId === 'string') {
          const error = err instanceof Error ? err.message.slice(0, 256) : 'rejected';
          connection.end(
            `${JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'nack',
              eventId: parsed.eventId,
              fatal: true,
              code: 'durable_rejected',
              error,
            })}\n`,
          );
        } else {
          connection.destroy();
        }
        log.warn('Rejected session link frame', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) connection.destroy();
  });
  connection.on('close', () => {
    if (entry.connection !== connection) return;
    entry.connection = null;
    if (entry.hostAckTimer) clearTimeout(entry.hostAckTimer);
    entry.hostAckTimer = null;
    entry.hostInFlight = null;
    state.connected = false;
    state.turnStateReady = false;
    entry.stopRequest = null;
    emit(sessionId, 'disconnected');
  });
  connection.on('error', () => {
    connection.destroy();
  });
}

function listen(entry: SessionSignalServer, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      entry.server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      entry.server.off('error', onError);
      fs.chmodSync(socketPath, 0o666);
      resolve();
    };
    entry.server.once('error', onError);
    entry.server.once('listening', onListening);
    entry.server.listen(socketPath);
  });
}

function suspendSessionSignalServer(sessionId: string, entry: SessionSignalServer): void {
  if (entry.suspended || servers.get(sessionId) !== entry) return;
  entry.suspended = true;
  fs.rmSync(sessionLinkSocketPath(sessionId), { force: true });
  entry.server.close(() => {
    if (servers.get(sessionId) !== entry) return;
    entry.relistenTimer = setTimeout(() => {
      entry.relistenTimer = null;
      if (servers.get(sessionId) !== entry) return;
      const socketPath = sessionLinkSocketPath(sessionId);
      fs.rmSync(socketPath, { force: true });
      listen(entry, socketPath)
        .then(() => {
          entry.suspended = false;
        })
        .catch((err) => {
          log.warn('Failed to resume rate-limited session link', { sessionId, err });
          void stopSessionSignalServer(sessionId, true);
        });
    }, 1_000);
    entry.relistenTimer.unref?.();
  });
}

export async function startSessionSignalServer(sessionId: string, agentGroupId: string | null = null): Promise<void> {
  if (servers.has(sessionId)) return;
  const directory = sessionLinkDir(sessionId);
  const socketPath = sessionLinkSocketPath(sessionId);
  const root = path.dirname(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  fs.rmSync(socketPath, { force: true });

  const entry: SessionSignalServer = {
    agentGroupId,
    server: net.createServer(),
    connection: null,
    suspended: false,
    relistenTimer: null,
    hostInFlight: null,
    hostAckTimer: null,
    hostReadySent: false,
    stopRequest: null,
  };
  entry.server.on('connection', (connection) => handleConnection(sessionId, entry, connection));
  await listen(entry, socketPath);
  servers.set(sessionId, entry);
  stateFor(sessionId).serverStartedAt = Date.now();
}

export async function stopSessionSignalServer(sessionId: string, clearState = false): Promise<void> {
  const entry = servers.get(sessionId);
  if (!entry) {
    if (clearState) states.delete(sessionId);
    return;
  }
  servers.delete(sessionId);
  if (entry.relistenTimer) clearTimeout(entry.relistenTimer);
  if (entry.hostAckTimer) clearTimeout(entry.hostAckTimer);
  entry.connection?.destroy();
  fs.rmSync(sessionLinkSocketPath(sessionId), { force: true });
  if (clearState) states.delete(sessionId);
  if (entry.server.listening) {
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
}

export async function stopAllSessionSignalServers(): Promise<void> {
  await Promise.all([...servers.keys()].map((sessionId) => stopSessionSignalServer(sessionId, true)));
}

export function getSessionSignalServerStartedAt(sessionId: string): number {
  return states.get(sessionId)?.serverStartedAt ?? 0;
}

export function getSessionSignalLastSeenAt(sessionId: string): number {
  return states.get(sessionId)?.lastSeenAt ?? 0;
}

export function getSessionSignalActivity(sessionId: string, sinceMs?: number): ActivityLine[] {
  const lines = states.get(sessionId)?.activity ?? [];
  return reduceActivityLines(sinceMs === undefined ? lines : lines.filter((line) => Number(line.ts) >= sinceMs));
}

export function getSessionSignalUsage(sessionId: string, sinceMs?: number): UsageSnapshot | null {
  const state = states.get(sessionId);
  if (!state?.usage || (sinceMs !== undefined && state.usageUpdatedAt < sinceMs)) return null;
  return { ...state.usage };
}

/** Identity-preserving live input for the later authoritative conversation projector. */
export function getSessionTurnSignals(sessionId: string): {
  active: ReturnType<typeof getSessionActiveTurn>;
  activity: Array<ActivityLine & { turnId: string | null; ordinal: number; timelinePosition: number }>;
  usage: { turnId: string | null; ts: number; value: UsageSnapshot } | null;
} {
  const state = states.get(sessionId);
  return {
    active: getSessionActiveTurn(sessionId),
    activity: state?.activity.map((line) => ({ ...line })) ?? [],
    usage: state?.usage
      ? { turnId: state.usageTurnId, ts: state.usageUpdatedAt, value: { ...state.usage } }
      : null,
  };
}

export function getSessionSignalTurnEndedAt(sessionId: string): number {
  return states.get(sessionId)?.turnEndedAt ?? 0;
}

export function getSessionActiveTurn(sessionId: string): { turn: SessionActiveTurn | null; connected: boolean } {
  const state = states.get(sessionId);
  const connection = servers.get(sessionId)?.connection;
  return {
    turn: state?.activeTurn ? { ...state.activeTurn } : null,
    connected: !!(state?.connected && state.turnStateReady && connection?.writable && !connection.destroyed),
  };
}

/** Acceptance confirms transport, not completion; only runner turn.state clears a turn. */
export function requestSessionTurnStop(sessionId: string, turnId: string): Promise<SessionTurnStopResult> {
  if (!isSessionTurnId(turnId)) return Promise.resolve({ accepted: false, error: 'invalid_turn_id' });
  const current = getSessionActiveTurn(sessionId);
  if (!current.connected) return Promise.resolve({ accepted: false, error: 'disconnected' });
  if (current.turn?.id !== turnId) return Promise.resolve({ accepted: false, error: 'not_active' });
  const entry = servers.get(sessionId)!;
  if (entry.stopRequest?.turnId === turnId) return entry.stopRequest.promise;
  if (current.turn.status === 'stopping') return Promise.resolve({ accepted: true, turn: current.turn });
  const connection = entry.connection!;
  const promise = new Promise<SessionTurnStopResult>((resolve) => {
    const timer = setTimeout(() => {
      connection.destroy();
      resolve({ accepted: false, error: 'disconnected' });
    }, 5_000);
    timer.unref?.();
    const finish = (err?: Error | null) => {
      clearTimeout(timer);
      const latest = getSessionActiveTurn(sessionId);
      if (err || entry.connection !== connection || !latest.connected) {
        connection.destroy();
        resolve({ accepted: false, error: 'disconnected' });
      } else if (latest.turn?.id !== turnId) {
        resolve({ accepted: false, error: 'not_active' });
      } else {
        const turn: SessionActiveTurn = { ...latest.turn, status: 'stopping' };
        stateFor(sessionId).activeTurn = turn;
        emit(sessionId, 'turn.state');
        resolve({ accepted: true, turn: { ...turn } });
      }
    };
    try {
      connection.write(`${JSON.stringify({ v: PROTOCOL_VERSION, type: 'turn.stop', turnId })}\n`, finish);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
  entry.stopRequest = { turnId, promise };
  return promise;
}
