import {
  parseSyncFrame,
  SyncProtocolError,
  SYNC_PROTOCOL_VERSION,
  SYNC_RELOAD_CLOSE_CODE,
  type GlobalSyncState,
  type SyncConversation,
  type SyncFrame,
} from '../../../shared/sync';
import { startReconnectCountdown } from './reconnect-countdown';

export interface SyncConnectionOptions {
  socket: () => WebSocket;
  apply: (frame: SyncFrame) => void;
  connecting: () => void;
  unavailable: (message: string) => void;
  reload: () => void;
  unauthorized: () => void;
}

export class SyncConnection {
  private socket: WebSocket | null = null;
  private groupId: string | null = null;
  private conversation: SyncConversation | null = null;
  private subscriptionId = 0;
  private attempt = 0;
  private stopped = false;
  private failure: string | null = null;
  private retryCancel: (() => void) | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: {
    promise: Promise<GlobalSyncState>;
    resolve: (value: GlobalSyncState) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(private readonly options: SyncConnectionOptions) {}

  start(): void {
    if (this.socket || this.stopped) return;
    this.retryCancel?.();
    this.retryCancel = undefined;
    this.options.connecting();
    const socket = this.options.socket();
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      if (this.socket === socket) socket.close();
    }, 10_000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      this.sendSubscription();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const value: unknown = JSON.parse(event.data);
        const frame = parseSyncFrame(value);
        if (frame.subscriptionId !== this.subscriptionId || frame.groupId !== this.groupId) return;
        this.options.apply(frame);
        this.failure = null;
        this.attempt = 0;
        if (this.pending && frame.global && frame.subscriptionId === this.subscriptionId) {
          clearTimeout(this.pending.timer);
          this.pending.resolve(frame.global);
          this.pending = null;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Global synchronization failed';
        this.failure = message;
        this.options.unavailable(message);
        // A protocol mismatch needs new assets, not an endless reconnect loop.
        if (error instanceof SyncProtocolError) {
          this.options.reload();
          this.stop();
        } else socket.close(1008, 'Invalid global sync snapshot');
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) this.options.unavailable('Global updates unavailable. Reconnecting...');
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearTimeout(this.connectTimer);
      this.rejectPending(new Error('Global updates disconnected. Reconnecting...'));
      if (this.stopped) return;
      if (event.code === 4401) {
        this.stopped = true;
        this.options.unauthorized();
        return;
      }
      if (event.code === SYNC_RELOAD_CLOSE_CODE) {
        this.stopped = true;
        this.options.unavailable(new SyncProtocolError().message);
        this.options.reload();
        return;
      }
      this.options.unavailable('Global updates disconnected. Reconnecting...');
      const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt++, 5));
      this.retryCancel = startReconnectCountdown(
        delay * (0.75 + Math.random() * 0.5),
        (seconds) =>
          this.options.unavailable(
            `disconnected \u00b7 reconnecting in ${seconds}s\u2026${this.failure ? ` ${this.failure}` : ''}`,
          ),
        () => this.start(),
      );
    };
  }

  select(groupId: string | null, conversation: SyncConversation | null): void {
    if (this.groupId === groupId && JSON.stringify(this.conversation) === JSON.stringify(conversation)) return;
    this.groupId = groupId;
    this.conversation = conversation;
    this.rejectPending(new Error('Global sync selection changed'));
    ++this.subscriptionId;
    this.sendSubscription();
  }

  refresh(groupId: string | null): Promise<GlobalSyncState> {
    if (this.stopped) return Promise.reject(new Error('Global synchronization is stopped. Reload this page.'));
    this.select(groupId, groupId === this.groupId ? this.conversation : null);
    if (this.pending) return this.pending.promise;
    let resolve!: (value: GlobalSyncState) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<GlobalSyncState>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => {
      this.rejectPending(new Error('Global synchronization timed out. Reconnect or reload.'));
      this.socket?.close();
    }, 15_000);
    this.pending = { promise, resolve, reject, timer };
    ++this.subscriptionId;
    this.start();
    this.sendSubscription();
    return promise;
  }

  catchUp(): void {
    if (this.stopped) return;
    ++this.subscriptionId;
    this.start();
    this.sendSubscription();
  }

  reconnectNow(): void {
    if (this.stopped || this.socket) return;
    this.start();
  }

  stop(): void {
    this.stopped = true;
    this.retryCancel?.();
    clearTimeout(this.connectTimer);
    this.rejectPending(new Error('Global synchronization stopped'));
    this.socket?.close();
    this.socket = null;
  }

  private sendSubscription(): void {
    if (this.socket?.readyState !== 1) return;
    this.socket.send(
      JSON.stringify({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: this.subscriptionId,
        groupId: this.groupId,
        conversation: this.conversation,
      }),
    );
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }
}
