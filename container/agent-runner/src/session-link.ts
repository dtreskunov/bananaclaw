import net from 'node:net';

import type { ActivityStep, TurnUsage } from './providers/types.js';

const DEFAULT_SOCKET_PATH = '/run/nanoclaw/runner.sock';
const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_ACTIVITY_LINES = 128;
const INITIAL_RECONNECT_MS = 100;
const MAX_RECONNECT_MS = 5_000;

type SignalFrame =
  | { v: 1; type: 'heartbeat' }
  | { v: 1; type: 'activity.clear' }
  | { v: 1; type: 'activity'; step: ActivityStep }
  | { v: 1; type: 'usage.clear' }
  | { v: 1; type: 'usage'; usage: TurnUsage }
  | { v: 1; type: 'turn.resume' }
  | { v: 1; type: 'turn.end' };

export class SessionSignalClient {
  private socket: net.Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private running = false;
  private activity: ActivityStep[] = [];
  private usage: TurnUsage | null = null;
  private turnEnded = false;

  constructor(private readonly socketPath = DEFAULT_SOCKET_PATH) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
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
      this.replaySnapshot();
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
    return Buffer.byteLength(encoded) <= MAX_FRAME_BYTES ? encoded : null;
  }
}

const client = new SessionSignalClient();

export function startSessionSignalClient(): void {
  client.start();
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
