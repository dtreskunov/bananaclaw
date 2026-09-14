import net from 'node:net';

import { getOutboundDb } from './db/connection.js';
import { applyHostEvent } from './db/host-state.js';
import { acknowledgeRunnerEvent, listPendingRunnerEvents } from './db/runner-state.js';
import type { ActivityStep, TurnUsage } from './providers/types.js';

const DEFAULT_SOCKET_PATH = '/run/nanoclaw/runner.sock';
const PROTOCOL_VERSION = 3;
const MAX_LIVE_FRAME_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = Number.parseInt(process.env.NANOCLAW_MAX_OUTPUT_BYTES || '10485760', 10);
const MAX_DURABLE_FRAME_BYTES = Math.ceil((MAX_OUTPUT_BYTES * 4) / 3) + 2 * 1024 * 1024;
const MAX_ACTIVITY_LINES = 128;
const DURABLE_ACK_TIMEOUT_MS = 10_000;
const INITIAL_RECONNECT_MS = 100;
const MAX_RECONNECT_MS = 5_000;

type SignalFrame =
  | { v: 3; type: 'heartbeat' }
  | { v: 3; type: 'activity.clear' }
  | { v: 3; type: 'activity'; step: ActivityStep }
  | { v: 3; type: 'usage.clear' }
  | { v: 3; type: 'usage'; usage: TurnUsage }
  | { v: 3; type: 'turn.resume' }
  | { v: 3; type: 'turn.end' };

interface DurableFrame {
  v: 3;
  type: 'durable';
  eventId: string;
  sequence: number;
  event: { type: string; payload: unknown };
}

type HostEventListener = () => void;
const hostEventListeners = new Set<HostEventListener>();
let hostEventGeneration = 0;

function emitHostEvent(): void {
  hostEventGeneration++;
  for (const listener of hostEventListeners) listener();
}

export function emitHostEventForTesting(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('test-only host event hook');
  emitHostEvent();
}

export function resetHostEventsForTesting(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('test-only host event reset');
  hostEventListeners.clear();
  hostEventGeneration = 0;
}

export function onHostEvent(listener: HostEventListener): () => void {
  hostEventListeners.add(listener);
  return () => hostEventListeners.delete(listener);
}

export function getHostEventGeneration(): number {
  return hostEventGeneration;
}

export function waitForHostEvent(
  sinceGeneration: number,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  if (hostEventGeneration !== sinceGeneration || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      hostEventListeners.delete(finish);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    hostEventListeners.add(finish);
    signal?.addEventListener('abort', finish, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(finish, Math.max(0, timeoutMs));
      timer.unref?.();
    }
    if (hostEventGeneration !== sinceGeneration) finish();
  });
}

export class SessionSignalClient {
  private socket: net.Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private sentAt = new Map<string, number>();
  private running = false;
  private activity: ActivityStep[] = [];
  private usage: TurnUsage | null = null;
  private turnEnded = false;
  private durableBlocked = false;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;

  constructor(
    private readonly socketPath = DEFAULT_SOCKET_PATH,
    private readonly onDurableFailure: (message: string) => void = (message) => {
      console.error(`[session-link] ${message}`);
      process.exit(75);
    },
  ) {}

  start(): Promise<void> {
    if (this.running) return this.readyPromise as Promise<void>;
    this.running = true;
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    this.pumpTimer = setInterval(() => this.flushDurable(), 50);
    this.pumpTimer.unref?.();
    this.connect();
    return this.readyPromise;
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.sentAt.clear();
  }

  heartbeat(): void {
    this.send({ v: PROTOCOL_VERSION, type: 'heartbeat' });
  }

  clearActivity(): void {
    this.activity = [];
    this.send({ v: PROTOCOL_VERSION, type: 'activity.clear' });
  }

  appendActivity(step: ActivityStep): void {
    const frame = { v: PROTOCOL_VERSION, type: 'activity', step } as const;
    if (!this.encode(frame)) return;
    this.activity.push(step);
    if (this.activity.length > MAX_ACTIVITY_LINES) {
      this.activity.splice(0, this.activity.length - MAX_ACTIVITY_LINES);
    }
    this.send(frame);
  }

  clearUsage(): void {
    this.usage = null;
    this.send({ v: PROTOCOL_VERSION, type: 'usage.clear' });
  }

  updateUsage(usage: TurnUsage): void {
    const frame = { v: PROTOCOL_VERSION, type: 'usage', usage } as const;
    if (!this.encode(frame)) return;
    this.usage = usage;
    this.send(frame);
  }

  resumeTurn(): void {
    this.turnEnded = false;
    this.send({ v: PROTOCOL_VERSION, type: 'turn.resume' });
  }

  endTurn(): void {
    this.turnEnded = true;
    this.send({ v: PROTOCOL_VERSION, type: 'turn.end' });
  }

  private connect(): void {
    if (!this.running || this.socket) return;
    const socket = net.createConnection(this.socketPath);
    const connectionStartedAt = Date.now();
    this.socket = socket;
    socket.once('connect', () => {
      if (this.socket !== socket) return;
      this.sentAt.clear();
      this.replaySnapshot();
      this.flushDurable();
    });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_DURABLE_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        let frame: Record<string, unknown> | null = null;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.v !== PROTOCOL_VERSION || typeof frame.type !== 'string') {
            socket.destroy();
            return;
          }
          if (frame.type === 'host.ready' && Object.keys(frame).every((key) => ['v', 'type'].includes(key))) {
            this.resolveReady?.();
            this.resolveReady = null;
          } else if (
            frame.type === 'host.event' &&
            typeof frame.eventId === 'string' &&
            Number.isSafeInteger(frame.sequence) &&
            frame.event &&
            typeof frame.event === 'object' &&
            !Array.isArray(frame.event) &&
            Object.keys(frame).every((key) => ['v', 'type', 'eventId', 'sequence', 'event'].includes(key))
          ) {
            const event = frame.event as Record<string, unknown>;
            if (!Object.keys(event).every((key) => ['type', 'payload'].includes(key)) || typeof event.type !== 'string') {
              socket.destroy();
              return;
            }
            const applied = applyHostEvent({
              eventId: frame.eventId,
              sequence: Number(frame.sequence),
              event: { type: event.type, payload: event.payload },
            });
            socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, type: 'host.ack', eventId: frame.eventId })}\n`);
            if (applied) emitHostEvent();
          } else if (
            typeof frame.eventId === 'string' &&
            frame.type === 'ack' &&
            Object.keys(frame).every((key) => ['v', 'type', 'eventId'].includes(key))
          ) {
            acknowledgeRunnerEvent(getOutboundDb(), frame.eventId);
            this.sentAt.delete(frame.eventId);
            this.flushDurable();
          } else if (
            frame.type === 'nack' &&
            frame.fatal === true &&
            frame.code === 'durable_rejected' &&
            typeof frame.error === 'string' &&
            Object.keys(frame).every((key) => ['v', 'type', 'eventId', 'fatal', 'code', 'error'].includes(key))
          ) {
            const pending = getOutboundDb()
              .prepare('SELECT sequence FROM pending_runner_events WHERE event_id = ?')
              .get(frame.eventId as string) as { sequence: number } | undefined;
            if (!pending) {
              socket.destroy();
              return;
            }
            this.blockDurable(pending.sequence, `host rejected event: ${frame.error}`);
          } else {
            socket.destroy();
            return;
          }
        } catch (error) {
          if (frame?.type === 'host.event' && typeof frame.eventId === 'string') {
            const message = error instanceof Error ? error.message.slice(0, 256) : 'rejected';
            socket.write(
              `${JSON.stringify({
                v: PROTOCOL_VERSION,
                type: 'host.nack',
                eventId: frame.eventId,
                fatal: true,
                error: message,
              })}\n`,
            );
            this.blockHostEvent(Number(frame.sequence), message);
          } else {
            socket.destroy();
          }
          return;
        }
      }
      if (Buffer.byteLength(buffer) > MAX_DURABLE_FRAME_BYTES) socket.destroy();
    });
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      if (this.socket === socket) this.socket = null;
      if (!this.running) return;
      if (Date.now() - connectionStartedAt >= 10_000) this.reconnectMs = INITIAL_RECONNECT_MS;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectMs);
      this.reconnectTimer.unref?.();
      this.reconnectMs = Math.min(MAX_RECONNECT_MS, this.reconnectMs * 2);
    });
  }

  private replaySnapshot(): void {
    this.send({ v: PROTOCOL_VERSION, type: 'heartbeat' });
    this.send({ v: PROTOCOL_VERSION, type: 'activity.clear' });
    for (const step of this.activity) this.send({ v: PROTOCOL_VERSION, type: 'activity', step });
    this.send(
      this.usage
        ? { v: PROTOCOL_VERSION, type: 'usage', usage: this.usage }
        : { v: PROTOCOL_VERSION, type: 'usage.clear' },
    );
    this.send({ v: PROTOCOL_VERSION, type: this.turnEnded ? 'turn.end' : 'turn.resume' });
  }

  private send(frame: SignalFrame): void {
    if (!this.socket?.writable || this.socket.connecting) return;
    const encoded = this.encode(frame);
    if (encoded) this.socket.write(encoded);
  }

  private encode(frame: SignalFrame): string | null {
    const encoded = `${JSON.stringify(frame)}\n`;
    return Buffer.byteLength(encoded) <= MAX_LIVE_FRAME_BYTES ? encoded : null;
  }

  private flushDurable(): void {
    if (this.durableBlocked || !this.socket?.writable || this.socket.connecting) return;
    const now = Date.now();
    if (this.sentAt.size > 0) {
      const oldestSentAt = Math.min(...this.sentAt.values());
      if (now - oldestSentAt >= DURABLE_ACK_TIMEOUT_MS) this.socket.destroy();
      return;
    }
    for (const pending of listPendingRunnerEvents(getOutboundDb(), 1)) {
      let payload: unknown;
      try {
        payload = JSON.parse(pending.payload);
      } catch {
        this.blockDurable(pending.sequence, 'invalid journal JSON');
        return;
      }
      if (pending.event_type === 'message.upsert') {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          this.blockDurable(pending.sequence, 'invalid message payload');
          return;
        }
        const row = payload as Record<string, unknown>;
        if (typeof row.content !== 'string') {
          this.blockDurable(pending.sequence, 'missing message content');
          return;
        }
        const { content, ...rest } = row;
        payload = { ...rest, content_base64: Buffer.from(content, 'utf8').toString('base64') };
      }
      const frame: DurableFrame = {
        v: PROTOCOL_VERSION,
        type: 'durable',
        eventId: pending.event_id,
        sequence: pending.sequence,
        event: { type: pending.event_type, payload },
      };
      const encoded = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(encoded) > MAX_DURABLE_FRAME_BYTES) {
        this.blockDurable(pending.sequence, 'event exceeds wire limit');
        return;
      }
      this.socket.write(encoded);
      this.sentAt.set(pending.event_id, now);
    }
  }

  private blockDurable(sequence: number, reason: string): void {
    this.durableBlocked = true;
    this.stop();
    this.onDurableFailure(`durable event ${sequence} blocked: ${reason}`);
  }

  private blockHostEvent(sequence: number, reason: string): void {
    this.durableBlocked = true;
    this.stop();
    this.onDurableFailure(`host event ${sequence} blocked: ${reason}`);
  }
}

const client = new SessionSignalClient();

export function startSessionSignalClient(): Promise<void> {
  return client.start();
}

export function signalHeartbeat(): void {
  client.heartbeat();
}

export function clearActivitySignal(): void {
  client.clearActivity();
}

export function emitActivitySignal(step: ActivityStep): void {
  client.appendActivity(step);
}

export function clearUsageSignal(): void {
  client.clearUsage();
}

export function emitUsageSignal(usage: TurnUsage): void {
  client.updateUsage(usage);
}

export function resumeTurnSignal(): void {
  client.resumeTurn();
}

export function endTurnSignal(): void {
  client.endTurn();
}
