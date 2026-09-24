import { signal } from '@preact/signals';

export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'finalizing' | 'error';
export interface VoiceSegment {
  id: string;
  sequence: number;
  text: string;
  final: boolean;
}
export interface VoiceState {
  phase: VoicePhase;
  target: string | null;
  elapsedMs: number;
  error: string;
  sending: boolean;
}
export interface VoiceTarget {
  key: string;
  groupId: string;
  threadId: string;
  channelType?: string;
  messagingGroupId?: string | null;
  getText(): string;
  setText(text: string): void;
  isCurrent(): boolean;
  send(): boolean | Promise<boolean>;
}
export interface VoiceCapture {
  stop(): Promise<void>;
  cancel(): void;
}
export interface VoiceDependencies {
  socket(url: string): WebSocket;
  capture(
    onChunk: (chunk: ArrayBuffer) => void,
    onError: (message: string) => void,
    signal: AbortSignal,
  ): Promise<VoiceCapture>;
  origin(): string;
}

export function replaceSegment(segments: VoiceSegment[], next: VoiceSegment): VoiceSegment[] {
  const index = segments.findIndex((segment) => segment.id === next.id);
  if (index < 0) return [...segments, next];
  const previous = segments[index];
  if (previous.sequence >= next.sequence || (previous.final && !next.final)) return segments;
  return segments.map((segment, i) => (i === index ? next : segment));
}

export function insertVoiceText(prefix: string, text: string, suffix: string): string {
  if (!text) return prefix + suffix;
  return (
    prefix + (prefix && !/\s$/.test(prefix) ? ' ' : '') + text + (suffix && !/^\s/.test(suffix) ? ' ' : '') + suffix
  );
}

const initialState = (): VoiceState => ({
  phase: 'idle',
  target: null,
  elapsedMs: 0,
  error: '',
  sending: false,
});

/** A single owner for both composer and question dictation; callbacks are generation-scoped. */
export class VoiceController {
  readonly state = signal<VoiceState>(initialState());
  private target: VoiceTarget | null = null;
  private generation = 0;
  private socket: WebSocket | null = null;
  private capture: VoiceCapture | null = null;
  private captureAbort: AbortController | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private segments: VoiceSegment[] = [];
  private prefix = '';
  private suffix = '';
  private intent: 'stop' | 'send' = 'stop';
  private finishSent = false;

  constructor(private readonly deps: VoiceDependencies) {}

  private update(patch: Partial<VoiceState>): void {
    this.state.value = { ...this.state.value, ...patch };
  }

  private current(generation: number): boolean {
    return this.generation === generation && !!this.target?.isCurrent();
  }

  start(target: VoiceTarget, caret = target.getText().length): void {
    if (this.state.value.sending || !['idle', 'error'].includes(this.state.value.phase)) return;
    this.detach();
    this.target = target;
    this.update({ target: target.key });
    this.connect(caret);
  }

  private connect(caret: number): void {
    const target = this.target!;
    const draft = target.getText();
    this.prefix = draft.slice(0, caret);
    this.suffix = draft.slice(caret);
    this.segments = [];
    this.intent = 'stop';
    this.finishSent = false;
    const generation = ++this.generation;
    this.update({ phase: 'connecting', error: '' });
    const base = this.deps.origin().replace(/^http/, 'ws');
    const params = new URLSearchParams();
    if (target.channelType && target.channelType !== 'web') {
      params.set('channel', target.channelType);
      if (target.messagingGroupId) params.set('mg', target.messagingGroupId);
    }
    const query = params.size ? `?${params.toString()}` : '';
    let socket: WebSocket;
    try {
      socket = this.deps.socket(
        `${base}/ui/chat/api/groups/${encodeURIComponent(target.groupId)}/chat/${encodeURIComponent(target.threadId)}/voice/stream${query}`,
      );
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not connect to voice input.');
      return;
    }
    this.socket = socket;
    this.timeout = setTimeout(() => {
      if (this.current(generation)) this.fail('Voice input did not become ready. Try again.');
    }, 15000);
    socket.onmessage = (event) => {
      if (!this.current(generation)) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data);
      } catch {
        this.fail('Invalid voice server response.');
        return;
      }
      if (!message || typeof message !== 'object') {
        this.fail('Invalid voice server response.');
        return;
      }
      if (message.type === 'ready' && this.state.value.phase === 'connecting') {
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = null;
        // Set phase before awaiting permission so duplicate ready events cannot open two microphones.
        this.update({ phase: 'listening' });
        const captureAbort = new AbortController();
        this.captureAbort = captureAbort;
        void this.deps
          .capture(
            (chunk) => {
              if (!this.current(generation) || this.finishSent || socket.readyState !== 1) return;
              if (socket.bufferedAmount > 1024 * 1024) {
                this.fail('Voice connection is too slow. Current text has been kept.');
                return;
              }
              try {
                for (let offset = 0; offset < chunk.byteLength; offset += 32768) {
                  socket.send(chunk.slice(offset, offset + 32768));
                }
              } catch {
                this.fail('Voice connection was interrupted. Current text has been kept.');
              }
            },
            (message) => {
              if (this.current(generation)) this.fail(message);
            },
            captureAbort.signal,
          )
          .then((capture) => {
            if (!this.current(generation) || this.state.value.phase !== 'listening') {
              capture.cancel();
              return;
            }
            this.capture = capture;
            const started = Date.now();
            const elapsed = this.state.value.elapsedMs;
            this.timer = setInterval(() => this.update({ elapsedMs: elapsed + Date.now() - started }), 250);
          })
          .catch((error: unknown) => {
            if (this.current(generation)) this.fail(error instanceof Error ? error.message : 'Microphone unavailable.');
          });
      } else if (
        message.type === 'transcript' &&
        (this.state.value.phase === 'listening' || this.state.value.phase === 'finalizing')
      ) {
        if (
          typeof message.id !== 'string' ||
          typeof message.sequence !== 'number' ||
          !Number.isSafeInteger(message.sequence) ||
          typeof message.text !== 'string' ||
          typeof message.final !== 'boolean'
        ) {
          this.fail('Invalid transcript response. Current text has been kept.');
          return;
        }
        this.segments = replaceSegment(this.segments, message as unknown as VoiceSegment);
        const text = this.segments
          .map((segment) => segment.text.trim())
          .filter(Boolean)
          .join(' ');
        target.setText(insertVoiceText(this.prefix, text, this.suffix));
      } else if (message.type === 'finished' && this.state.value.phase === 'finalizing' && this.finishSent) {
        if (
          (this.intent === 'send' && !this.segments.some((segment) => segment.text.trim())) ||
          this.segments.some((segment) => segment.text.trim() && !segment.final)
        ) {
          this.fail('No complete transcript was received. Review current text before using it.');
          return;
        }
        const intent = this.intent;
        this.release();
        if (intent === 'send') void this.sendDraft();
        else this.detach();
      } else if (message.type === 'error') {
        this.fail(
          typeof message.message === 'string' ? message.message : 'Voice input failed. Current text has been kept.',
        );
      }
    };
    socket.onerror = () => {
      if (this.current(generation)) this.fail('Voice connection failed. Current text has been kept.');
    };
    socket.onclose = () => {
      if (this.current(generation))
        this.fail('Voice connection closed before finalization. Current text has been kept.');
    };
  }

  stop(): void {
    if (this.state.value.sending) return;
    if (this.state.value.phase === 'connecting') this.detach();
    else this.finalize('stop');
  }

  send(): void {
    if (this.state.value.phase === 'listening') this.finalize('send');
    else if (this.state.value.phase === 'error') void this.sendDraft();
  }

  private async sendDraft(): Promise<void> {
    const target = this.target;
    if (!target?.isCurrent() || this.state.value.sending) return;
    this.update({ sending: true });
    const generation = this.generation;
    try {
      const sent = await target.send();
      if (!this.current(generation)) return;
      if (sent) this.detach();
      else this.fail('Message was not sent. Your draft is still available.');
    } catch {
      if (this.current(generation)) this.fail('Message was not sent. Your draft is still available.');
    } finally {
      if (this.current(generation)) this.update({ sending: false });
    }
  }

  private finalize(intent: 'stop' | 'send'): void {
    if (this.state.value.phase !== 'listening') return;
    this.intent = intent;
    this.update({ phase: 'finalizing' });
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const generation = this.generation;
    this.timeout = setTimeout(() => {
      if (this.current(generation))
        this.fail('Finalization timed out. Current text is unconfirmed; review it before using it.');
    }, 20000);
    const capture = this.capture;
    void (capture?.stop() ?? Promise.resolve())
      .then(() => {
        if (!this.current(generation)) return;
        this.capture = null;
        this.finishSent = true;
        this.socket?.send(JSON.stringify({ type: 'finish' }));
      })
      .catch(() => {
        if (this.current(generation)) this.fail('Could not finalize voice input. Current text has been kept.');
      });
  }

  /** Navigation/unmount invalidates callbacks before stopping hardware. No automatic resume. */
  detach(): void {
    this.release(true);
    this.target = null;
    this.state.value = initialState();
  }

  interrupt(
    reason = 'Microphone stopped because this page is no longer active. Review current text before sending or dictating again.',
  ): void {
    if (['connecting', 'listening', 'finalizing'].includes(this.state.value.phase)) {
      this.fail(reason);
    }
  }

  private fail(error: string): void {
    this.release(true);
    this.intent = 'stop';
    this.update({ phase: 'error', error, sending: false });
  }

  private release(cancel = false): void {
    ++this.generation;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.timer) clearInterval(this.timer);
    this.timeout = this.timer = null;
    this.captureAbort?.abort();
    this.captureAbort = null;
    this.capture?.cancel();
    this.capture = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        if (cancel && socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel' }));
        socket.close();
      } catch {
        /* The connection may already have closed. */
      }
    }
  }
}
