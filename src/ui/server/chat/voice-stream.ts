import type http from 'node:http';
import type { Duplex } from 'node:stream';

import { createElevenLabs, type ElevenLabsProviderSettings } from '@ai-sdk/elevenlabs';
import { experimental_streamTranscribe, type TranscriptionStreamPart } from 'ai';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { getAgentGroup } from '../../../db/agent-groups.js';
import { log } from '../../../log.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { authenticate } from '../auth.js';
import { getVoiceInputApiKey, resolveVoiceInputConfig, VOICE_INPUT_MODEL } from './voice-input-config.js';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MAX_FRAME_BYTES = 32_768;
const MAX_BUFFER_BYTES = BYTES_PER_SECOND * 4;
const MAX_SESSION_MS = 5 * 60_000;
const FINALIZE_TIMEOUT_MS = 10_000;
const MAX_SESSIONS = 8;

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

  accept(part: TranscriptionStreamPart): VoiceTranscript | undefined {
    if (part.type !== 'transcript-delta' && part.type !== 'transcript-partial' && part.type !== 'transcript-final') {
      return undefined;
    }
    const key = part.id === undefined ? `anonymous:${this.currentAnonymousId}` : `provider:${part.id}`;
    const prior = this.segments.get(key);
    if (prior?.final) return undefined;
    const text = part.type === 'transcript-delta' ? (prior?.text ?? '') + part.delta : part.text;
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
  ) {
    this.socket = new WebSocket(url, protocols, {
      ...options,
      handshakeTimeout: 10_000,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    });
    this.socket.on('open', () => this.onopen?.({}));
    this.socket.on('message', (data) => this.onmessage?.({ data: rawBuffer(data).toString('utf8') }));
    this.socket.on('error', (error) => this.onerror?.(error));
    this.socket.on('close', (code) => this.onclose?.({ code }));
  }

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
    this.socket.close(code, reason);
  }
}

export function elevenLabsTranscriber(
  apiKey: string,
  webSocket: ProviderSocketConstructor = VoiceProviderSocket,
): VoiceTranscriber {
  const provider = createElevenLabs({ apiKey, webSocket });
  return (audio, abortSignal) =>
    experimental_streamTranscribe({
      model: provider.transcription(VOICE_INPUT_MODEL),
      audio,
      inputAudioFormat: { type: 'audio/pcm', rate: SAMPLE_RATE },
      abortSignal,
      providerOptions: { elevenlabs: { streaming: { commitStrategy: 'vad', enableLogging: false } } },
    }).fullStream;
}

function rawBuffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export function attachVoiceStream(
  ws: WebSocket,
  transcribe: VoiceTranscriber,
  context: { userId: string; groupId: string },
  onClose: () => void,
): void {
  const abort = new AbortController();
  const transcript = new VoiceTranscriptNormalizer();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let inputEnded = false;
  let closed = false;
  let inputBytes = 0;
  let lastInput = Date.now();
  let allowance = BYTES_PER_SECOND * 2;
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

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(sessionTimer);
    clearTimeout(finalizingTimer);
    clearInterval(idleTimer);
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
    cleanup();
    ws.close(1008, code);
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
  ws.on('close', cleanup);
  ws.on('error', () => fail('connection_error', 'Voice connection failed. Your current text has been kept.'));
  ws.on('message', (raw, binary) => {
    if (closed) return;
    const data = rawBuffer(raw);
    if (data.byteLength > MAX_FRAME_BYTES) return fail('frame_limit', 'Voice audio frame is too large.');
    if (binary) {
      if (inputEnded) return fail('audio_after_finish', 'Audio arrived after the voice session finished.');
      if (data.byteLength === 0 || data.byteLength % 2 !== 0) return fail('invalid_audio', 'Invalid PCM audio frame.');
      const now = Date.now();
      allowance = Math.min(BYTES_PER_SECOND * 2, allowance + ((now - allowanceAt) * BYTES_PER_SECOND) / 1000);
      allowanceAt = now;
      allowance -= data.byteLength;
      if (allowance < 0) return fail('audio_rate_limit', 'Audio arrived faster than real time.');
      inputBytes += data.byteLength;
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
      cleanup();
      ws.close(1000);
    } else if (message.type === 'finish' && !inputEnded) {
      inputEnded = true;
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
        if (ws.bufferedAmount > MAX_BUFFER_BYTES) {
          fail('client_backpressure', 'Voice connection cannot keep up. Review your current text.');
          return;
        }
        const normalized = transcript.accept(part);
        if (normalized) send(normalized);
      }
      if (closed) return;
      if (!inputEnded || transcript.hasProvisionalText()) {
        fail('incomplete_transcript', 'Transcription ended before all speech was finalized. Review your current text.');
        return;
      }
      send({ type: 'finished' });
      cleanup();
      ws.close(1000);
    } catch {
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
  const reject = (status: number, reason: string): true => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return true;
  };
  if (req.headers.origin !== options.expectedOrigin) return reject(403, 'Forbidden');
  const session = authenticate(req);
  if (!session) return reject(401, 'Unauthorized');
  let groupId: string;
  try {
    groupId = decodeURIComponent(match[1]);
    const threadId = decodeURIComponent(match[2]);
    if (!threadId || threadId.length > 256 || /[\0/]/.test(threadId)) return reject(400, 'Bad Request');
  } catch {
    return reject(400, 'Bad Request');
  }
  if (!canAccessAgentGroup(session.userId, groupId).allowed) return reject(403, 'Forbidden');
  if (!getAgentGroup(groupId)) return reject(404, 'Not Found');
  if (!options.canSend(session.userId, groupId, url.searchParams)) return reject(403, 'Forbidden');
  const config = resolveVoiceInputConfig(groupId);
  const apiKey = getVoiceInputApiKey();
  if (!config.ready || config.backend !== 'elevenlabs' || !apiKey) return reject(503, 'Service Unavailable');
  if (activeUsers.has(session.userId) || activeUsers.size >= MAX_SESSIONS) return reject(429, 'Too Many Requests');
  voiceWss.handleUpgrade(req, socket, head, (ws) => {
    activeUsers.add(session.userId);
    attachVoiceStream(ws, elevenLabsTranscriber(apiKey), { userId: session.userId, groupId }, () => {
      activeUsers.delete(session.userId);
    });
  });
  return true;
}
