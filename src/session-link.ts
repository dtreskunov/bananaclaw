import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { reduceActivityLines, type ActivityStep } from './activity.js';
import type { ActivityLine, UsageSnapshot } from './channels/adapter.js';
import { CONTAINER_MAX_OUTPUT_SIZE, DATA_DIR } from './config.js';
import { log } from './log.js';
import { applyDurableRunnerEvent } from './session-link-durable.js';

const PROTOCOL_VERSION = 3;
export const SESSION_LINK_VERSION = 'v3';
const MAX_LIVE_FRAME_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = Math.ceil((CONTAINER_MAX_OUTPUT_SIZE * 4) / 3) + 2 * 1024 * 1024;
const MAX_FRAME_BYTES_PER_SECOND = 24 * 1024 * 1024;
const MAX_GLOBAL_FRAMES_PER_SECOND = 512;
const MAX_GLOBAL_FRAME_BYTES_PER_SECOND = 32 * 1024 * 1024;
const MAX_FRAMES_PER_SECOND = 256;
const MAX_CONNECTIONS_PER_SECOND = 32;
const MAX_ACTIVITY_LINES = 128;
const MAX_ID_CHARS = 256;
const MAX_TEXT_CHARS = 2_000;
const HOST_ACK_TIMEOUT_MS = 10_000;

type SignalKind = 'disconnected' | 'heartbeat' | 'activity' | 'usage' | 'turn.end' | 'turn.state';

export interface SessionActiveTurn {
  id: string;
  status: 'running' | 'stopping';
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type SessionTurnStopResult =
  | { accepted: true; turn: SessionActiveTurn }
  | { accepted: false; error: 'invalid_turn_id' | 'not_active' | 'disconnected' };

export function isSessionTurnId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isTurnRoutingText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  );
}

interface SessionSignalState {
  connected: boolean;
  serverStartedAt: number;
  lastSeenAt: number;
  rateWindowStartedAt: number;
  framesThisWindow: number;
  frameBytesThisWindow: number;
  connectionWindowStartedAt: number;
  connectionsThisWindow: number;
  activity: ActivityLine[];
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

export function notifySessionHostState(sessionId: string): void {
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

function boundedString(value: unknown, max = MAX_TEXT_CHARS): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT_CHARS) return null;
  return value;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function sanitizeActivityStep(value: unknown): ActivityStep | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const id = boundedString(input.id, MAX_ID_CHARS);
  if (!id || typeof input.kind !== 'string') return null;

  switch (input.kind) {
    case 'tool': {
      if (
        !hasOnlyKeys(
          input,
          ['kind', 'id', 'tool', 'status', 'detail', 'title', 'error', 'durationMs', 'rejectedBeforeExecution'].filter(
            (key) => input[key] !== undefined,
          ),
        )
      )
        return null;
      const tool = boundedString(input.tool, MAX_ID_CHARS);
      if (
        !tool ||
        !['pending', 'running', 'completed', 'error', 'interrupted', 'unknown'].includes(String(input.status))
      )
        return null;
      const detail = optionalString(input.detail);
      const title = optionalString(input.title);
      const error = optionalString(input.error);
      if (detail === null || title === null || error === null) return null;
      if (input.rejectedBeforeExecution !== undefined && typeof input.rejectedBeforeExecution !== 'boolean')
        return null;
      const durationMs =
        input.durationMs === undefined
          ? undefined
          : typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
            ? input.durationMs
            : null;
      if (durationMs === null) return null;
      return {
        kind: 'tool',
        id,
        tool,
        status: input.status as Extract<ActivityStep, { kind: 'tool' }>['status'],
        ...(detail !== undefined ? { detail } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(input.rejectedBeforeExecution !== undefined
          ? { rejectedBeforeExecution: input.rejectedBeforeExecution }
          : {}),
      };
    }
    case 'internal':
    case 'notification': {
      if (!hasOnlyKeys(input, ['kind', 'id', 'text'])) return null;
      const text = boundedString(input.text);
      return text ? { kind: input.kind, id, text } : null;
    }
    case 'file': {
      if (
        !hasOnlyKeys(
          input,
          ['kind', 'id', 'path', 'name', 'mime'].filter((key) => input[key] !== undefined),
        )
      ) {
        return null;
      }
      const filePath = optionalString(input.path);
      const name = optionalString(input.name);
      const mime = optionalString(input.mime);
      if (filePath === null || name === null || mime === null) return null;
      return {
        kind: 'file',
        id,
        ...(filePath !== undefined ? { path: filePath } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(mime !== undefined ? { mime } : {}),
      };
    }
    case 'patch': {
      if (!hasOnlyKeys(input, ['kind', 'id', 'files'])) return null;
      if (!Array.isArray(input.files) || input.files.length > 100) return null;
      const files = input.files.map((file) => boundedString(file));
      return files.every((file): file is string => file !== undefined) ? { kind: 'patch', id, files } : null;
    }
    case 'retry': {
      if (
        !hasOnlyKeys(
          input,
          ['kind', 'id', 'attempt', 'error'].filter((key) => input[key] !== undefined),
        )
      ) {
        return null;
      }
      const error = optionalString(input.error);
      if (error === null || !Number.isInteger(input.attempt) || Number(input.attempt) < 0) return null;
      return { kind: 'retry', id, attempt: Number(input.attempt), ...(error !== undefined ? { error } : {}) };
    }
    case 'compaction':
      return hasOnlyKeys(
        input,
        ['kind', 'id', 'auto'].filter((key) => input[key] !== undefined),
      ) &&
        (input.auto === undefined || typeof input.auto === 'boolean')
        ? { kind: 'compaction', id, ...(input.auto !== undefined ? { auto: input.auto } : {}) }
        : null;
    case 'subtask': {
      if (
        !hasOnlyKeys(
          input,
          ['kind', 'id', 'agent', 'description'].filter((key) => input[key] !== undefined),
        )
      ) {
        return null;
      }
      const agent = optionalString(input.agent);
      const description = optionalString(input.description);
      if (agent === null || description === null) return null;
      return {
        kind: 'subtask',
        id,
        ...(agent !== undefined ? { agent } : {}),
        ...(description !== undefined ? { description } : {}),
      };
    }
    default:
      return null;
  }
}

function sanitizeUsage(value: unknown): UsageSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(
      input,
      [
        'cost_usd',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'reasoning_tokens',
        'num_turns',
        'duration_ms',
        'duration_api_ms',
        'context_window',
        'max_output_tokens',
        'context_tokens',
        'model',
      ].filter((key) => input[key] !== undefined),
    )
  )
    return null;
  if (
    typeof input.cost_usd !== 'number' ||
    !Number.isFinite(input.cost_usd) ||
    input.cost_usd < 0 ||
    input.cost_usd > 1_000_000
  ) {
    return null;
  }
  const requiredIntegers = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const;
  if (requiredIntegers.some((key) => !Number.isSafeInteger(input[key]) || Number(input[key]) < 0)) return null;
  const model = boundedString(input.model, MAX_ID_CHARS);
  if (!model) return null;
  const output: UsageSnapshot = {
    cost_usd: Number(input.cost_usd),
    input_tokens: Number(input.input_tokens),
    output_tokens: Number(input.output_tokens),
    cache_read_tokens: Number(input.cache_read_tokens),
    cache_write_tokens: Number(input.cache_write_tokens),
    model,
  };
  for (const key of [
    'reasoning_tokens',
    'num_turns',
    'duration_ms',
    'duration_api_ms',
    'context_window',
    'max_output_tokens',
    'context_tokens',
  ] as const) {
    const candidate = input[key];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) return null;
    output[key] = Number(candidate);
  }
  return output;
}

function applyFrame(sessionId: string, entry: SessionSignalServer, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const frame = raw as Record<string, unknown>;
  if (frame.v !== PROTOCOL_VERSION || typeof frame.type !== 'string') return false;

  if (frame.type === 'host.ack') {
    if (
      !entry.agentGroupId ||
      !hasOnlyKeys(frame, ['v', 'type', 'eventId']) ||
      typeof frame.eventId !== 'string' ||
      entry.hostInFlight?.eventId !== frame.eventId
    ) {
      return false;
    }
    const db = new Database(inboundPath(entry.agentGroupId, sessionId));
    try {
      db.prepare('DELETE FROM pending_host_events WHERE event_id = ? AND sequence = ?').run(
        frame.eventId,
        entry.hostInFlight.sequence,
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

  if (frame.type === 'host.nack') {
    if (
      !hasOnlyKeys(frame, ['v', 'type', 'eventId', 'fatal', 'error']) ||
      typeof frame.eventId !== 'string' ||
      frame.fatal !== true ||
      typeof frame.error !== 'string' ||
      entry.hostInFlight?.eventId !== frame.eventId
    ) {
      return false;
    }
    log.error('Runner rejected host session event', {
      sessionId,
      sequence: entry.hostInFlight.sequence,
      error: frame.error.slice(0, 256),
    });
    entry.connection?.destroy();
    return true;
  }

  if (frame.type === 'durable') {
    if (
      !entry.agentGroupId ||
      !hasOnlyKeys(frame, ['v', 'type', 'eventId', 'sequence', 'event']) ||
      typeof frame.eventId !== 'string' ||
      !Number.isSafeInteger(frame.sequence) ||
      !frame.event ||
      typeof frame.event !== 'object' ||
      Array.isArray(frame.event)
    )
      return false;
    const event = frame.event as Record<string, unknown>;
    if (!hasOnlyKeys(event, ['type', 'payload']) || typeof event.type !== 'string') return false;
    const payload = decodeDurablePayload(event.type, event.payload);
    const result = applyDurableRunnerEvent(entry.agentGroupId, sessionId, {
      eventId: frame.eventId,
      sequence: Number(frame.sequence),
      event: { type: event.type, payload },
    });
    entry.connection?.write(`${JSON.stringify({ v: PROTOCOL_VERSION, type: 'ack', eventId: frame.eventId })}\n`);
    if (result.deliveryReady) {
      for (const listener of durableMessageListeners) listener(sessionId);
    }
    if (result.processingReady) {
      for (const listener of durableProcessingListeners) listener(sessionId);
    }
    return true;
  }

  const state = stateFor(sessionId);
  const now = Date.now();
  switch (frame.type) {
    case 'turn.state': {
      if (!hasOnlyKeys(frame, ['v', 'type', 'turn'])) return false;
      const turn = frame.turn as Record<string, unknown> | null;
      if (
        turn !== null &&
        (!turn ||
          typeof turn !== 'object' ||
          Array.isArray(turn) ||
          !hasOnlyKeys(turn, ['id', 'status', 'channelType', 'platformId', 'threadId']) ||
          !isSessionTurnId(turn.id) ||
          (turn.status !== 'running' && turn.status !== 'stopping') ||
          !isTurnRoutingText(turn.channelType) ||
          !isTurnRoutingText(turn.platformId) ||
          (turn.threadId !== null && !isTurnRoutingText(turn.threadId)))
      )
        return false;
      if (entry.stopRequest?.turnId !== turn?.id) entry.stopRequest = null;
      const activeTurn = turn === null ? null : ({ ...turn } as unknown as SessionActiveTurn);
      if (
        activeTurn &&
        activeTurn.id === state.activeTurn?.id &&
        state.activeTurn.status === 'stopping' &&
        entry.stopRequest?.turnId === activeTurn.id
      )
        activeTurn.status = 'stopping';
      state.activeTurn = activeTurn;
      state.turnStateReady = true;
      state.lastSeenAt = now;
      emit(sessionId, 'turn.state');
      return true;
    }
    case 'heartbeat':
      if (!hasOnlyKeys(frame, ['v', 'type'])) return false;
      state.lastSeenAt = now;
      emit(sessionId, 'heartbeat');
      return true;
    case 'activity.clear':
      if (!hasOnlyKeys(frame, ['v', 'type'])) return false;
      state.lastSeenAt = now;
      state.activity = [];
      emit(sessionId, 'activity');
      return true;
    case 'activity': {
      if (!hasOnlyKeys(frame, ['v', 'type', 'step'])) return false;
      const step = sanitizeActivityStep(frame.step);
      if (!step) return false;
      state.lastSeenAt = now;
      state.activity.push({ ts: String(now), text: JSON.stringify(step) });
      if (state.activity.length > MAX_ACTIVITY_LINES)
        state.activity.splice(0, state.activity.length - MAX_ACTIVITY_LINES);
      emit(sessionId, 'activity');
      return true;
    }
    case 'usage': {
      if (!hasOnlyKeys(frame, ['v', 'type', 'usage'])) return false;
      const usage = sanitizeUsage(frame.usage);
      if (!usage) return false;
      state.lastSeenAt = now;
      state.usage = usage;
      state.usageUpdatedAt = now;
      emit(sessionId, 'usage');
      return true;
    }
    case 'usage.clear':
      if (!hasOnlyKeys(frame, ['v', 'type'])) return false;
      state.lastSeenAt = now;
      state.usage = null;
      state.usageUpdatedAt = 0;
      emit(sessionId, 'usage');
      return true;
    case 'turn.resume':
      if (!hasOnlyKeys(frame, ['v', 'type'])) return false;
      state.lastSeenAt = now;
      state.turnEndedAt = 0;
      return true;
    case 'turn.end':
      if (!hasOnlyKeys(frame, ['v', 'type'])) return false;
      state.lastSeenAt = now;
      state.turnEndedAt = now;
      emit(sessionId, 'turn.end');
      return true;
    default:
      return false;
  }
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
