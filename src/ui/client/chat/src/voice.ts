import { signal } from '@preact/signals';
import {
  VOICE_BYTES_PER_SECOND,
  VOICE_MAX_BUFFER_BYTES,
  VOICE_MAX_FRAME_BYTES,
  VOICE_UPLOAD_BURST_BYTES,
  type VoiceDiagnostic,
  type VoiceFailure,
} from '../../../shared/voice';

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
  connected: boolean;
}
export interface VoiceSelection {
  start: number;
  end: number;
}
export interface VoiceTarget {
  key: string;
  groupId: string;
  threadId: string;
  channelType?: string;
  messagingGroupId?: string | null;
  getText(): string;
  setText(text: string, selection?: VoiceSelection): void;
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
  attemptId(): string;
  report(groupId: string, diagnostic: VoiceDiagnostic): void;
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
  const before = prefix && !/[\s([{]$/.test(prefix) && !/^[,.;:!?%)\]}]/.test(text) ? ' ' : '';
  const after = suffix && !/^[\s,.;:!?%)\]}]/.test(suffix) && !/[([{]$/.test(text) ? ' ' : '';
  return prefix + before + text + after + suffix;
}

const initialState = (): VoiceState => ({
  phase: 'idle',
  target: null,
  elapsedMs: 0,
  error: '',
  sending: false,
  connected: false,
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
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private audioQueue: ArrayBuffer[] = [];
  private queuedBytes = 0;
  private uploadAllowance = VOICE_UPLOAD_BURST_BYTES;
  private allowanceAt = 0;
  private captureFlushed = false;
  private startedAt = 0;
  private diagnostics: Omit<VoiceDiagnostic, 'outcome' | 'failure' | 'elapsedMs'> | null = null;
  private segments: VoiceSegment[] = [];
  private draft = '';
  private selection: VoiceSelection = { start: 0, end: 0 };
  private intent: 'stop' | 'send' = 'stop';
  private finishSent = false;

  constructor(private readonly deps: VoiceDependencies) {}

  private update(patch: Partial<VoiceState>): void {
    this.state.value = { ...this.state.value, ...patch };
  }

  private current(generation: number): boolean {
    return this.generation === generation && !!this.target?.isCurrent();
  }

  start(target: VoiceTarget, start = target.getText().length, end = start): void {
    if (this.state.value.sending || !['idle', 'error'].includes(this.state.value.phase)) return;
    this.detach();
    this.target = target;
    this.update({ target: target.key });
    this.connect(start, end);
  }

  private connect(start: number, end: number): void {
    const target = this.target!;
    const draft = target.getText();
    this.draft = draft;
    start = Math.max(0, Math.min(start, draft.length));
    end = Math.max(start, Math.min(end, draft.length));
    this.selection = { start, end };
    this.segments = [];
    this.intent = 'stop';
    this.finishSent = false;
    this.startedAt = Date.now();
    this.diagnostics = { attemptId: this.deps.attemptId(), peakQueuedBytes: 0 };
    this.captureFlushed = false;
    this.uploadAllowance = VOICE_UPLOAD_BURST_BYTES;
    const generation = ++this.generation;
    this.update({ phase: 'connecting', error: '' });
    void this.acquireCapture(generation);
    if (!this.current(generation)) return;
    const base = this.deps.origin().replace(/^http/, 'ws');
    const params = new URLSearchParams();
    params.set('attempt', this.diagnostics.attemptId);
    if (target.channelType && target.channelType !== 'web') {
      params.set('channel', target.channelType);
      if (target.messagingGroupId) params.set('mg', target.messagingGroupId);
    }
    let socket: WebSocket;
    try {
      socket = this.deps.socket(
        `${base}/ui/chat/api/groups/${encodeURIComponent(target.groupId)}/chat/${encodeURIComponent(target.threadId)}/voice/stream?${params}`,
      );
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not connect to voice input.', 'connection');
      return;
    }
    this.socket = socket;
    this.timeout = setTimeout(() => {
      if (this.current(generation)) this.fail('Voice input did not become ready. Try again.', 'connection');
    }, 15000);
    socket.onmessage = (event) => this.handleMessage(event.data, generation);
    socket.onerror = () => {
      if (this.current(generation)) this.fail('Voice connection failed. Current text has been kept.', 'connection');
    };
    socket.onclose = () => {
      if (this.current(generation))
        this.fail('Voice connection closed before finalization. Current text has been kept.', 'connection');
    };
  }

  private async acquireCapture(generation: number): Promise<void> {
    const abort = new AbortController();
    this.captureAbort = abort;
    try {
      const capture = await this.deps.capture(
        (chunk) => this.enqueueAudio(chunk, generation),
        (message) => {
          if (this.current(generation)) this.fail(message, 'capture');
        },
        abort.signal,
      );
      if (!this.current(generation)) {
        capture.cancel();
        return;
      }
      this.capture = capture;
      if (this.diagnostics) this.diagnostics.captureReadyMs = this.elapsed();
      this.update({ phase: 'listening' });
      const started = Date.now();
      this.timer = setInterval(() => this.update({ elapsedMs: Date.now() - started }), 250);
    } catch (error) {
      if (this.current(generation))
        this.fail(
          error instanceof Error ? error.message : 'Microphone unavailable.',
          error instanceof Error && error.name === 'NotAllowedError' ? 'permission' : 'capture',
        );
    }
  }

  private handleMessage(data: string, generation: number): void {
    if (!this.current(generation)) return;
    const target = this.target!;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data);
    } catch {
      this.fail('Invalid voice server response.', 'protocol');
      return;
    }
    if (!message || typeof message !== 'object') {
      this.fail('Invalid voice server response.', 'protocol');
      return;
    }
    if (message.type === 'ready' && !this.state.value.connected) {
      if (this.state.value.phase !== 'finalizing') {
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = null;
      }
      this.update({ connected: true });
      if (this.diagnostics) this.diagnostics.socketReadyMs = this.elapsed();
      this.allowanceAt = Date.now();
      this.drainAudio(generation);
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
        this.fail('Invalid transcript response. Current text has been kept.', 'protocol');
        return;
      }
      if (this.diagnostics && this.diagnostics.firstTranscriptMs === undefined && message.text.trim()) {
        this.diagnostics.firstTranscriptMs = this.elapsed();
      }
      this.segments = replaceSegment(this.segments, {
        id: message.id,
        sequence: message.sequence,
        text: message.text,
        final: message.final,
      });
      const text = this.segments
        .map((segment) => segment.text.trim())
        .filter(Boolean)
        .join(' ');
      if (text) {
        const prefix = this.draft.slice(0, this.selection.start);
        const suffix = this.draft.slice(this.selection.end);
        const caret = insertVoiceText(prefix, text, '').length;
        target.setText(insertVoiceText(prefix, text, suffix), { start: caret, end: caret });
      } else {
        target.setText(this.draft, this.selection);
      }
    } else if (message.type === 'finished' && this.state.value.phase === 'finalizing' && this.finishSent) {
      if (
        (this.intent === 'send' && !this.segments.some((segment) => segment.text.trim())) ||
        this.segments.some((segment) => segment.text.trim() && !segment.final)
      ) {
        this.fail('No complete transcript was received. Review current text before using it.', 'protocol');
        return;
      }
      const intent = this.intent;
      this.report('finished');
      this.release();
      if (intent === 'send') void this.sendDraft();
      else this.detach();
    } else if (message.type === 'error') {
      this.fail(
        typeof message.message === 'string' ? message.message : 'Voice input failed. Current text has been kept.',
      );
    }
  }

  private enqueueAudio(chunk: ArrayBuffer, generation: number): void {
    if (!this.current(generation) || this.finishSent) return;
    if (this.diagnostics && this.diagnostics.firstAudioMs === undefined) this.diagnostics.firstAudioMs = this.elapsed();
    if (this.queuedBytes + chunk.byteLength + (this.socket?.bufferedAmount ?? 0) > VOICE_MAX_BUFFER_BYTES) {
      this.fail('Voice connection is too slow. Current text has been kept; please try again.', 'buffer');
      return;
    }
    for (let offset = 0; offset < chunk.byteLength; offset += VOICE_MAX_FRAME_BYTES) {
      const frame = chunk.slice(offset, offset + VOICE_MAX_FRAME_BYTES);
      this.audioQueue.push(frame);
      this.queuedBytes += frame.byteLength;
    }
    if (this.diagnostics)
      this.diagnostics.peakQueuedBytes = Math.max(this.diagnostics.peakQueuedBytes, this.queuedBytes);
    this.drainAudio(generation);
  }

  private drainAudio(generation: number): void {
    const socket = this.socket;
    if (!this.current(generation) || !this.state.value.connected || socket?.readyState !== 1 || this.finishSent) return;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    const now = Date.now();
    this.uploadAllowance = Math.min(
      VOICE_UPLOAD_BURST_BYTES,
      this.uploadAllowance + ((now - this.allowanceAt) * VOICE_BYTES_PER_SECOND) / 1000,
    );
    this.allowanceAt = now;
    try {
      while (this.audioQueue.length) {
        const frame = this.audioQueue[0];
        if (
          frame.byteLength > this.uploadAllowance ||
          socket.bufferedAmount + frame.byteLength > VOICE_MAX_BUFFER_BYTES
        ) {
          this.drainTimer = setTimeout(() => this.drainAudio(generation), 25);
          return;
        }
        socket.send(frame);
        this.uploadAllowance -= frame.byteLength;
        this.audioQueue.shift();
        this.queuedBytes -= frame.byteLength;
      }
      if (this.captureFlushed) {
        socket.send(JSON.stringify({ type: 'finish' }));
        this.finishSent = true;
      }
    } catch {
      this.fail('Voice connection was interrupted. Current text has been kept.', 'connection');
    }
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
    if (this.timeout) clearTimeout(this.timeout);
    const generation = this.generation;
    this.timeout = setTimeout(() => {
      if (this.current(generation))
        this.fail('Finalization timed out. Current text is unconfirmed; review it before using it.', 'finalize');
    }, 20000);
    const capture = this.capture;
    void (capture?.stop() ?? Promise.resolve())
      .then(() => {
        if (!this.current(generation)) return;
        this.capture = null;
        this.captureFlushed = true;
        this.drainAudio(generation);
      })
      .catch(() => {
        if (this.current(generation))
          this.fail('Could not finalize voice input. Current text has been kept.', 'finalize');
      });
  }

  /** Navigation/unmount invalidates callbacks before stopping hardware. No automatic resume. */
  detach(): void {
    this.report('cancelled');
    this.release(true);
    this.target = null;
    this.state.value = initialState();
  }

  interrupt(
    reason = 'Microphone stopped because this page is no longer active. Review current text before sending or dictating again.',
  ): void {
    if (['connecting', 'listening', 'finalizing'].includes(this.state.value.phase)) {
      this.fail(reason, 'interrupted');
    }
  }

  private elapsed(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }

  private report(outcome: VoiceDiagnostic['outcome'], failure?: VoiceFailure): void {
    const diagnostic = this.diagnostics;
    if (!diagnostic || !this.target) return;
    this.diagnostics = null;
    this.deps.report(this.target.groupId, {
      ...diagnostic,
      outcome,
      elapsedMs: this.elapsed(),
      ...(failure ? { failure } : {}),
    });
  }

  private fail(error: string, failure: VoiceFailure = 'provider'): void {
    this.report('failed', failure);
    this.release(true);
    this.intent = 'stop';
    this.update({ phase: 'error', error, sending: false });
  }

  private release(cancel = false): void {
    ++this.generation;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.timer) clearInterval(this.timer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.timeout = this.timer = null;
    this.drainTimer = null;
    this.audioQueue = [];
    this.queuedBytes = 0;
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
