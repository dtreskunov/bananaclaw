import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';

import { createElevenLabs, type ElevenLabsProviderSettings } from '@ai-sdk/elevenlabs';
import { experimental_streamTranscribe, NoTranscriptGeneratedError, type TranscriptionStreamPart } from 'ai';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { getAgentGroup } from '../../../db/agent-groups.js';
import { log } from '../../../log.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { authenticate } from '../auth.js';
import {
  VOICE_BYTES_PER_SECOND as BYTES_PER_SECOND,
  VOICE_MAX_BUFFER_BYTES as MAX_BUFFER_BYTES,
  VOICE_MAX_FRAME_BYTES as MAX_FRAME_BYTES,
  VOICE_SAMPLE_RATE as SAMPLE_RATE,
  isVoiceAttemptId,
} from '../../shared/voice.js';
import { getVoiceInputApiKey, resolveVoiceInputConfig, VOICE_INPUT_MODEL } from './voice-input-config.js';

const MAX_BURST_BYTES = MAX_BUFFER_BYTES;
const MAX_SESSION_MS = 5 * 60_000;
const FINALIZE_TIMEOUT_MS = 10_000;
const MAX_SESSIONS = 8;
const PROVIDER_ERROR_EVENT_TYPES = new Set([
  'auth_error',
  'chunk_size_exceeded',
  'commit_throttled',
  'error',
  'input_error',
  'insufficient_audio_activity',
  'queue_overflow',
  'quota_exceeded',
  'rate_limited',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'transcriber_error',
  'unaccepted_terms',
]);

export interface VoiceTranscript {
  type: 'transcript';
  id: string;
  sequence: number;
  text: string;
  final: boolean;
}

export class VoiceTranscriptNormalizer {
  private readonly segments = new Map<string, VoiceTranscript>();
  private currentAnonymousId = 0;
  private sequence = 0;
  private lastFinalText: string | undefined;

  accept(part: TranscriptionStreamPart): VoiceTranscript | undefined {
    if (part.type !== 'transcript-delta' && part.type !== 'transcript-partial' && part.type !== 'transcript-final') {
      return undefined;
    }
    const key = part.id === undefined ? `anonymous:${this.currentAnonymousId}` : `provider:${part.id}`;
    const prior = this.segments.get(key);
    if (prior?.final) return undefined;
    const text = part.type === 'transcript-delta' ? (prior?.text ?? '') + part.delta : part.text;
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    if (part.type === 'transcript-final' && !prior && normalizedText && normalizedText === this.lastFinalText) {
      return undefined;
    }
    this.lastFinalText = part.type === 'transcript-final' ? normalizedText : undefined;
    const next: VoiceTranscript = {
      type: 'transcript',
      id: prior?.id ?? `segment-${this.segments.size}`,
      sequence: ++this.sequence,
      text,
      final: part.type === 'transcript-final',
    };
    this.segments.set(key, next);
    if (next.final && part.id === undefined) this.currentAnonymousId++;
    return next;
  }

  hasProvisionalText(): boolean {
    return [...this.segments.values()].some((segment) => !segment.final && segment.text.trim().length > 0);
  }

  finalizeProvisionalText(): VoiceTranscript[] {
    const finalized: VoiceTranscript[] = [];
    let previousFinalText: string | undefined;
    for (const [key, segment] of this.segments) {
      const normalizedText = segment.text.replace(/\s+/g, ' ').trim();
      if (segment.final) {
        previousFinalText = normalizedText || previousFinalText;
        continue;
      }
      if (!normalizedText) continue;
      if (normalizedText === previousFinalText) {
        this.segments.set(key, { ...segment, final: true });
        continue;
      }
      const next = { ...segment, sequence: ++this.sequence, final: true };
      this.segments.set(key, next);
      finalized.push(next);
      previousFinalText = normalizedText;
    }
    return finalized;
  }
}

export type VoiceTranscriber = (
  audio: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) => AsyncIterable<TranscriptionStreamPart>;

type ProviderSocketConstructor = NonNullable<ElevenLabsProviderSettings['webSocket']>;

// Adapt ws's narrower DOM event callbacks to the SDK's transport interface.
export class VoiceProviderSocket implements InstanceType<ProviderSocketConstructor> {
  private readonly socket: WebSocket;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    url: string | URL,
    protocols?: string | string[],
    options?: { headers?: Record<string, string | undefined> },
    private readonly context: { attemptId?: string } = {},
  ) {
    this.socket = new WebSocket(url, protocols, {
      ...options,
      handshakeTimeout: 10_000,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    });
    this.socket.on('open', () => this.onopen?.({}));
    this.socket.on('message', (data) => {
      const text = rawBuffer(data).toString('utf8');
      try {
        const event = JSON.parse(text) as { message_type?: unknown };
        if (typeof event.message_type === 'string' && PROVIDER_ERROR_EVENT_TYPES.has(event.message_type)) {
          log.warn('ElevenLabs voice stream error event', { ...this.context, eventType: event.message_type });
        }
      } catch {
        log.warn('ElevenLabs voice stream returned invalid JSON', this.context);
      }
      this.onmessage?.({ data: text });
    });
    this.socket.on('error', (error: Error & { code?: unknown }) => {
      const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
      const statusMatch = error.message.match(/^Unexpected server response: (\d{3})$/);
      const write = this.closeRequested ? log.debug : log.warn;
      write('ElevenLabs voice socket error', {
        ...this.context,
        closeRequested: this.closeRequested,
        ...(code ? { code } : {}),
        ...(statusMatch ? { httpStatus: Number(statusMatch[1]) } : {}),
      });
      this.onerror?.(error);
    });
    this.socket.on('close', (code) => {
      if (code !== 1000) {
        const write = this.closeRequested ? log.debug : log.warn;
        write('ElevenLabs voice socket closed abnormally', {
          ...this.context,
          code,
          closeRequested: this.closeRequested,
        });
      }
      this.onclose?.({ code });
    });
  }

  private closeRequested = false;

  get readyState(): number {
    return this.socket.readyState;
  }
  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }
  send(data: string | Uint8Array | ArrayBuffer): void {
    this.socket.send(data);
  }
  close(code?: number, reason?: string): void {
    this.closeRequested = true;
    this.socket.close(code, reason);
  }
}

export function elevenLabsTranscriber(
  apiKey: string,
  webSocket: ProviderSocketConstructor = VoiceProviderSocket,
): VoiceTranscriber {
  const provider = createElevenLabs({ apiKey, webSocket });
  return async function* (audio, abortSignal) {
    const result = experimental_streamTranscribe({
      model: provider.transcription(VOICE_INPUT_MODEL),
      audio,
      inputAudioFormat: { type: 'audio/pcm', rate: SAMPLE_RATE },
      abortSignal,
      includeRawChunks: true,
      providerOptions: { elevenlabs: { streaming: { commitStrategy: 'vad', enableLogging: false, noVerbatim: true } } },
    });
    let segment = 0;
    let confirmedEmpty = false;
    let provisionalText = false;
    try {
      for await (const part of result.fullStream) {
        if (part.type === 'raw') {
          const event = part.rawValue;
          if (
            event &&
            typeof event === 'object' &&
            'message_type' in event &&
            event.message_type === 'session_started'
          ) {
            yield { type: 'raw', rawValue: { message_type: 'session_started' } };
          }
          if (
            event &&
            typeof event === 'object' &&
            'message_type' in event &&
            (event.message_type === 'committed_transcript' || event.message_type === 'final_transcript') &&
            'text' in event &&
            typeof event.text === 'string' &&
            !event.text.trim()
          ) {
            // The SDK suppresses empty finals and reuses their provider ID. Give every commit its own ID.
            yield { type: 'transcript-final', id: `elevenlabs:${segment++}`, text: '' };
            confirmedEmpty = true;
            provisionalText = false;
          }
          continue;
        }
        if (part.type === 'error') {
          yield part;
          continue;
        }
        yield { ...part, id: `elevenlabs:${segment}` };
        provisionalText =
          part.type !== 'transcript-final' &&
          (part.type === 'transcript-delta' ? !!part.delta.trim() : !!part.text.trim());
        if (part.type === 'transcript-final') segment++;
      }
    } catch (error) {
      if (confirmedEmpty && !provisionalText && !abortSignal.aborted && NoTranscriptGeneratedError.isInstance(error))
        return;
      throw error;
    }
  };
}

function rawBuffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function transcriptionFailureKind(error: unknown): string {
  if (NoTranscriptGeneratedError.isInstance(error)) return 'no_transcript';
  if (!(error instanceof Error)) return 'unknown';
  if (error.message === 'ElevenLabs realtime transcription stream closed before completion.') return 'stream_closed';
  if (error.message.startsWith('ElevenLabs realtime transcription error.')) return 'socket_error';
  if (error.message === 'WebSocket is not connected.') return 'socket_not_connected';
  return 'provider_error';
}

export function attachVoiceStream(
  ws: WebSocket,
  transcribe: VoiceTranscriber,
  context: { userId: string; groupId: string; attemptId?: string },
  onClose: () => void,
): void {
  const abort = new AbortController();
  context = { ...context, attemptId: context.attemptId ?? randomUUID() };
  const startedAt = Date.now();
  const transcript = new VoiceTranscriptNormalizer();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let inputEnded = false;
  let closed = false;
  let inputBytes = 0;
  let peakPcm = 0;
  let squaredPcm = 0;
  let clippedSamples = 0;
  let peakQueuedBytes = 0;
  let providerReadyMs: number | undefined;
  let firstAudioMs: number | undefined;
  let firstTranscriptMs: number | undefined;
  let finalizingAt: number | undefined;
  let lastInput = Date.now();
  let allowance = MAX_BURST_BYTES;
  let allowanceAt = Date.now();
  let finalizingTimer: ReturnType<typeof setTimeout> | undefined;
  const audio = new ReadableStream<Uint8Array>(
    {
      start: (value) => {
        controller = value;
      },
    },
    { highWaterMark: MAX_BUFFER_BYTES, size: (chunk) => chunk.byteLength },
  );

  log.info('Voice input started', context);
  const cleanup = (outcome = 'disconnected', code = 'client_closed'): void => {
    if (closed) return;
    closed = true;
    clearTimeout(sessionTimer);
    clearTimeout(finalizingTimer);
    clearInterval(idleTimer);
    log.info('Voice input ended', {
      ...context,
      outcome,
      code,
      elapsedMs: Date.now() - startedAt,
      inputBytes,
      audioMs: Math.round((inputBytes * 1000) / BYTES_PER_SECOND),
      peakPcm,
      rmsPcm: inputBytes ? Math.round(Math.sqrt(squaredPcm / (inputBytes / 2))) : 0,
      clippedSamples,
      peakQueuedBytes,
      providerReadyMs,
      firstAudioMs,
      firstTranscriptMs,
      ...(finalizingAt === undefined ? {} : { finalizationMs: Date.now() - finalizingAt }),
    });
    abort.abort();
    onClose();
  };
  const send = (event: object): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  const fail = (code: string, message: string): void => {
    if (closed) return;
    log.warn('Voice input stopped', { ...context, code });
    send({ type: 'error', code, message });
    cleanup('failed', code);
    ws.close(1008, code);
  };
  const finish = (promoteProvisional = true): void => {
    if (closed) return;
    if (ws.bufferedAmount > MAX_BUFFER_BYTES) {
      fail('client_backpressure', 'Voice connection cannot keep up. Review your current text.');
      return;
    }
    const finalized = promoteProvisional ? transcript.finalizeProvisionalText() : [];
    if (finalized.length > 0) {
      log.warn('Voice input finalized provisional text without a provider final', {
        ...context,
        segmentCount: finalized.length,
      });
    }
    for (const segment of finalized) send(segment);
    send({ type: 'finished' });
    cleanup('finished', inputBytes ? 'completed' : 'empty_audio');
    ws.close(1000);
  };
  const sessionTimer = setTimeout(
    () =>
      fail(
        'session_limit',
        'Voice session reached the five-minute limit. Your text is kept; press the microphone to dictate again.',
      ),
    MAX_SESSION_MS,
  );
  const idleTimer = setInterval(() => {
    if (!inputEnded && Date.now() - lastInput > 15_000)
      fail('audio_timeout', 'Audio capture stopped. Press the microphone to reconnect.');
  }, 5_000);
  sessionTimer.unref();
  idleTimer.unref();
  ws.on('close', () => cleanup());
  ws.on('error', () => fail('connection_error', 'Voice connection failed. Your current text has been kept.'));
  ws.on('message', (raw, binary) => {
    if (closed) return;
    const data = rawBuffer(raw);
    if (data.byteLength > MAX_FRAME_BYTES) return fail('frame_limit', 'Voice audio frame is too large.');
    if (binary) {
      if (inputEnded) return fail('audio_after_finish', 'Audio arrived after the voice session finished.');
      if (data.byteLength === 0 || data.byteLength % 2 !== 0) return fail('invalid_audio', 'Invalid PCM audio frame.');
      const now = Date.now();
      allowance = Math.min(MAX_BURST_BYTES, allowance + ((now - allowanceAt) * BYTES_PER_SECOND) / 1000);
      allowanceAt = now;
      allowance -= data.byteLength;
      if (allowance < 0)
        return fail(
          'audio_rate_limit',
          'Audio upload stayed ahead of real time. Your text is kept; press the microphone to try again.',
        );
      inputBytes += data.byteLength;
      if (firstAudioMs === undefined) firstAudioMs = Date.now() - startedAt;
      for (let offset = 0; offset < data.byteLength; offset += 2) {
        const sample = data.readInt16LE(offset);
        peakPcm = Math.max(peakPcm, Math.abs(sample));
        squaredPcm += sample * sample;
        if (Math.abs(sample) >= 32767) clippedSamples++;
      }
      lastInput = now;
      if (inputBytes > (BYTES_PER_SECOND * MAX_SESSION_MS) / 1000)
        return fail('audio_limit', 'Voice audio limit reached.');
      if ((controller.desiredSize ?? 0) < data.byteLength) {
        return fail(
          'audio_backpressure',
          'Transcription cannot keep up. Your text is kept; press the microphone to try again.',
        );
      }
      controller.enqueue(new Uint8Array(data));
      peakQueuedBytes = Math.max(peakQueuedBytes, MAX_BUFFER_BYTES - (controller.desiredSize ?? MAX_BUFFER_BYTES));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return fail('invalid_message', 'Invalid voice control message.');
    }
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return fail('invalid_message', 'Invalid voice control message.');
    }
    if (message.type === 'cancel') {
      cleanup('cancelled', 'client_cancelled');
      ws.close(1000);
    } else if (message.type === 'finish' && !inputEnded) {
      inputEnded = true;
      finalizingAt = Date.now();
      if (inputBytes === 0) {
        finish(false);
        return;
      }
      controller.close();
      finalizingTimer = setTimeout(
        () =>
          fail('finalize_timeout', 'Transcription did not finish in time. Review your current text before sending.'),
        FINALIZE_TIMEOUT_MS,
      );
      finalizingTimer.unref();
    } else {
      fail('invalid_message', 'Unexpected voice control message.');
    }
  });

  send({ type: 'ready' });
  void (async () => {
    try {
      for await (const part of transcribe(audio, abort.signal)) {
        if (closed) return;
        if (part.type === 'error') throw part.error;
        if (
          providerReadyMs === undefined &&
          part.type === 'raw' &&
          part.rawValue &&
          typeof part.rawValue === 'object' &&
          'message_type' in part.rawValue &&
          part.rawValue.message_type === 'session_started'
        ) {
          providerReadyMs = Date.now() - startedAt;
        }
        if (ws.bufferedAmount > MAX_BUFFER_BYTES) {
          fail('client_backpressure', 'Voice connection cannot keep up. Review your current text.');
          return;
        }
        const normalized = transcript.accept(part);
        if (normalized) {
          if (firstTranscriptMs === undefined && normalized.text.trim()) {
            firstTranscriptMs = Date.now() - startedAt;
          }
          send(normalized);
        }
      }
      if (closed) return;
      if (!inputEnded) {
        fail('incomplete_transcript', 'Transcription ended before all speech was finalized. Review your current text.');
        return;
      }
      finish();
    } catch (error) {
      if (closed) return;
      if (inputEnded && transcript.hasProvisionalText() && NoTranscriptGeneratedError.isInstance(error)) {
        finish();
        return;
      }
      log.warn('Voice transcription provider failed', {
        ...context,
        failureKind: transcriptionFailureKind(error),
        inputBytes,
        peakPcm,
      });
      if (NoTranscriptGeneratedError.isInstance(error)) {
        fail(
          'no_speech',
          peakPcm === 0
            ? 'The microphone produced silent audio. Check the selected microphone and try again.'
            : 'No speech was recognized. Speak clearly and try again.',
        );
        return;
      }
      // Provider errors may contain authenticated request headers or audio.
      fail(
        'transcription_failed',
        'Speech service failed. Check the server credential and provider quota, then press the microphone to try again.',
      );
    }
  })();
}

const voiceWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
const activeUsers = new Set<string>();

export function handleVoiceUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: {
    expectedOrigin: string;
    canSend: (userId: string, groupId: string, query: URLSearchParams) => boolean;
  },
): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = url.pathname.match(/^\/ui\/chat\/api\/groups\/([^/]+)\/chat\/([^/]+)\/voice\/stream$/);
  if (!match) return false;
  const requestedAttempt = url.searchParams.get('attempt');
  const attemptId = isVoiceAttemptId(requestedAttempt) ? requestedAttempt : randomUUID();
  const reject = (status: number, reason: string, code: string): true => {
    log.warn('Voice upgrade rejected', { attemptId, status, code });
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return true;
  };
  if (requestedAttempt !== null && !isVoiceAttemptId(requestedAttempt))
    return reject(400, 'Bad Request', 'invalid_attempt');
  if (req.headers.origin !== options.expectedOrigin) return reject(403, 'Forbidden', 'origin');
  const session = authenticate(req);
  if (!session) return reject(401, 'Unauthorized', 'unauthenticated');
  let groupId: string;
  try {
    groupId = decodeURIComponent(match[1]);
    const threadId = decodeURIComponent(match[2]);
    if (!threadId || threadId.length > 256 || /[\0/]/.test(threadId))
      return reject(400, 'Bad Request', 'invalid_thread');
  } catch {
    return reject(400, 'Bad Request', 'invalid_path');
  }
  if (!canAccessAgentGroup(session.userId, groupId).allowed) return reject(403, 'Forbidden', 'group_access');
  if (!getAgentGroup(groupId)) return reject(404, 'Not Found', 'group_not_found');
  if (!options.canSend(session.userId, groupId, url.searchParams)) return reject(403, 'Forbidden', 'read_only');
  const config = resolveVoiceInputConfig(groupId);
  const apiKey = getVoiceInputApiKey();
  if (!config.ready || config.backend !== 'elevenlabs' || !apiKey)
    return reject(503, 'Service Unavailable', 'unconfigured');
  if (activeUsers.has(session.userId) || activeUsers.size >= MAX_SESSIONS)
    return reject(429, 'Too Many Requests', 'session_limit');
  voiceWss.handleUpgrade(req, socket, head, (ws) => {
    activeUsers.add(session.userId);
    class AttemptSocket extends VoiceProviderSocket {
      constructor(
        url: string | URL,
        protocols?: string | string[],
        options?: { headers?: Record<string, string | undefined> },
      ) {
        super(url, protocols, options, { attemptId });
      }
    }
    attachVoiceStream(
      ws,
      elevenLabsTranscriber(apiKey, AttemptSocket),
      { userId: session.userId, groupId, attemptId },
      () => {
        activeUsers.delete(session.userId);
      },
    );
  });
  return true;
}
