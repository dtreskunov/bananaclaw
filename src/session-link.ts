import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { reduceActivityLines, type ActivityStep } from './activity.js';
import type { ActivityLine, UsageSnapshot } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

const PROTOCOL_VERSION = 1;
export const SESSION_LINK_VERSION = 'v1';
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_FRAMES_PER_SECOND = 256;
const MAX_CONNECTIONS_PER_SECOND = 32;
const MAX_ACTIVITY_LINES = 128;
const MAX_ID_CHARS = 256;
const MAX_TEXT_CHARS = 2_000;

type SignalKind = 'disconnected' | 'heartbeat' | 'activity' | 'usage' | 'turn.end';

interface SessionSignalState {
  connected: boolean;
  serverStartedAt: number;
  lastSeenAt: number;
  rateWindowStartedAt: number;
  framesThisWindow: number;
  connectionWindowStartedAt: number;
  connectionsThisWindow: number;
  activity: ActivityLine[];
  usage: UsageSnapshot | null;
  usageUpdatedAt: number;
  turnEndedAt: number;
}

interface SessionSignalServer {
  server: net.Server;
  connection: net.Socket | null;
  suspended: boolean;
  relistenTimer: NodeJS.Timeout | null;
}

type SignalListener = (sessionId: string, kind: SignalKind) => void;

const servers = new Map<string, SessionSignalServer>();
const states = new Map<string, SessionSignalState>();
const listeners = new Set<SignalListener>();

function emptyState(): SessionSignalState {
  return {
    connected: false,
    serverStartedAt: 0,
    lastSeenAt: 0,
    rateWindowStartedAt: 0,
    framesThisWindow: 0,
    connectionWindowStartedAt: 0,
    connectionsThisWindow: 0,
    activity: [],
    usage: null,
    usageUpdatedAt: 0,
    turnEndedAt: 0,
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
      if (!tool || !['pending', 'running', 'completed', 'error'].includes(String(input.status))) return null;
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
        status: input.status as 'pending' | 'running' | 'completed' | 'error',
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

function applyFrame(sessionId: string, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const frame = raw as Record<string, unknown>;
  if (frame.v !== PROTOCOL_VERSION || typeof frame.type !== 'string') return false;

  const state = stateFor(sessionId);
  const now = Date.now();
  switch (frame.type) {
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
      }
      state.framesThisWindow++;
      if (state.framesThisWindow > MAX_FRAMES_PER_SECOND) {
        connection.destroy();
        return;
      }
      try {
        if (!applyFrame(sessionId, JSON.parse(line))) {
          connection.destroy();
          return;
        }
      } catch {
        connection.destroy();
        return;
      }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) connection.destroy();
  });
  connection.on('close', () => {
    if (entry.connection !== connection) return;
    entry.connection = null;
    state.connected = false;
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

export async function startSessionSignalServer(sessionId: string): Promise<void> {
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
    server: net.createServer(),
    connection: null,
    suspended: false,
    relistenTimer: null,
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
