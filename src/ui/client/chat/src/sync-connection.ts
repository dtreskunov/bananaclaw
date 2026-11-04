import { parseSyncFrame, SyncProtocolError, SYNC_PROTOCOL_VERSION, type SyncResponse } from '../../../shared/sync';

export interface SyncConnectionOptions {
  socket: () => WebSocket;
  apply: (data: SyncResponse, groupId: string | null) => void;
  unavailable: (message: string) => void;
  reload: () => void;
  unauthorized: () => void;
}

export class SyncConnection {
  private socket: WebSocket | null = null;
  private groupId: string | null = null;
  private subscriptionId = 0;
  private streamId: string | null = null;
  private revision = -1;
  private attempt = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: {
    promise: Promise<SyncResponse>;
    resolve: (value: SyncResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(private readonly options: SyncConnectionOptions) {}

  start(): void {
    if (this.socket || this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.options.socket();
    this.socket = socket;
    this.streamId = null;
    this.revision = -1;
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
        if (this.streamId !== null && this.streamId !== frame.streamId) throw new Error('Unknown global sync stream');
        if (frame.revision <= this.revision) return;
        this.options.apply(frame.data, frame.groupId);
        this.streamId = frame.streamId;
        this.revision = frame.revision;
        this.attempt = 0;
        if (this.pending) {
          clearTimeout(this.pending.timer);
          this.pending.resolve(frame.data);
          this.pending = null;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Global synchronization failed';
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
      this.options.unavailable('Global updates disconnected. Reconnecting...');
      const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt++, 5));
      this.retryTimer = setTimeout(() => this.start(), delay * (0.75 + Math.random() * 0.5));
    };
  }

  setGroup(groupId: string | null): void {
    if (this.groupId === groupId) return;
    this.groupId = groupId;
    this.rejectPending(new Error('Global sync selection changed'));
    ++this.subscriptionId;
    this.sendSubscription();
  }

  refresh(groupId: string | null): Promise<SyncResponse> {
    if (this.stopped) return Promise.reject(new Error('Global synchronization is stopped. Reload this page.'));
    this.setGroup(groupId);
    if (this.pending) return this.pending.promise;
    let resolve!: (value: SyncResponse) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<SyncResponse>((yes, no) => {
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

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
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
