import { EventEmitter, once } from 'node:events';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { TranscriptionStreamPart } from 'ai';

vi.mock('./voice-input-config.js', () => ({
  VOICE_INPUT_MODEL: 'scribe_v2_realtime',
  getVoiceInputApiKey: vi.fn(() => 'test-key'),
  resolveVoiceInputConfig: vi.fn(() => ({ backend: 'elevenlabs', ready: true })),
}));
vi.mock('../auth.js', () => ({ authenticate: vi.fn(() => ({ userId: 'user' })) }));
vi.mock('../../../db/agent-groups.js', () => ({ getAgentGroup: vi.fn(() => ({ id: 'group' })) }));
vi.mock('../../../modules/permissions/access.js', () => ({
  canAccessAgentGroup: vi.fn(() => ({ allowed: true })),
}));
vi.mock('../../../log.js', () => ({ log: { warn: vi.fn() } }));

import { authenticate } from '../auth.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { resolveVoiceInputConfig } from './voice-input-config.js';
import {
  attachVoiceStream,
  elevenLabsTranscriber,
  handleVoiceUpgrade,
  VoiceProviderSocket,
  VoiceTranscriptNormalizer,
  type VoiceTranscriber,
} from './voice-stream.js';

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send(message: string): void {
    this.sent.push(JSON.parse(message));
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  receive(message: object | Buffer): void {
    this.emit(
      'message',
      Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message)),
      Buffer.isBuffer(message),
    );
  }
}

const sockets: TestSocket[] = [];
function connect(transcribe: VoiceTranscriber) {
  const ws = new TestSocket();
  sockets.push(ws);
  const release = vi.fn();
  attachVoiceStream(ws as unknown as WebSocket, transcribe, { userId: 'user', groupId: 'group' }, release);
  return { ws, release };
}

async function consume(audio: ReadableStream<Uint8Array>): Promise<number> {
  const reader = audio.getReader();
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.length;
  }
  reader.releaseLock();
  return bytes;
}

const pendingTranscription: VoiceTranscriber = async function* (_audio, signal) {
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  yield* [];
};

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('voice transcript normalization', () => {
  it('replaces provisional words and freezes final text without duplicate appends', () => {
    const transcript = new VoiceTranscriptNormalizer();
    const first = transcript.accept({ type: 'transcript-partial', id: 'one', text: 'cash' });
    const second = transcript.accept({ type: 'transcript-partial', id: 'one', text: 'cache' });
    expect(first?.id).toBe(second?.id);
    expect(second).toMatchObject({ text: 'cache', sequence: 2, final: false });
    expect(transcript.hasProvisionalText()).toBe(true);
    expect(transcript.accept({ type: 'transcript-final', id: 'one', text: 'Cache.' })).toMatchObject({ final: true });
    expect(transcript.hasProvisionalText()).toBe(false);
    expect(transcript.accept({ type: 'transcript-partial', id: 'one', text: 'late' })).toBeUndefined();
  });

  it('accumulates deltas, accepts replacement finals, and assigns anonymous segments', () => {
    const transcript = new VoiceTranscriptNormalizer();
    transcript.accept({ type: 'transcript-delta', delta: 'hel' });
    expect(transcript.accept({ type: 'transcript-delta', delta: 'lo' })?.text).toBe('hello');
    const final = transcript.accept({ type: 'transcript-final', text: 'Hello.' });
    const next = transcript.accept({ type: 'transcript-partial', text: 'Next' });
    expect(next?.id).not.toBe(final?.id);
    expect(next?.text).toBe('Next');
  });
});

describe('voice stream lifecycle', () => {
  it('streams revisions before finish and waits for the final provider result', async () => {
    let audioBytes = 0;
    const { ws, release } = connect(async function* (audio) {
      yield { type: 'transcript-partial', id: 'one', text: 'cash' };
      yield { type: 'transcript-partial', id: 'one', text: 'cache' };
      audioBytes = await consume(audio);
      yield { type: 'transcript-final', id: 'one', text: 'Cache.' };
    });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(3));
    expect(ws.sent[0]).toEqual({ type: 'ready' });
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
    ws.receive(Buffer.alloc(3200));
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(audioBytes).toBe(3200);
    expect(ws.sent.slice(-2)).toEqual([
      expect.objectContaining({ type: 'transcript', text: 'Cache.', final: true }),
      { type: 'finished' },
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not claim success for unfinalized speech', async () => {
    const { ws } = connect(async function* (audio) {
      yield { type: 'transcript-partial', text: 'unfinished' };
      await consume(audio);
    });
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'incomplete_transcript' });
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
  });

  it('surfaces provider errors without leaking headers or audio', async () => {
    const { ws } = connect(async function* () {
      yield { type: 'error', error: new Error('xi-api-key: secret; audio: private') };
    });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'transcription_failed' });
    expect(JSON.stringify(ws.sent)).not.toContain('secret');
    expect(JSON.stringify(ws.sent)).not.toContain('private');
  });

  it('cancels the provider and releases the slot once on disconnect', async () => {
    let signal: AbortSignal | undefined;
    const { ws, release } = connect(async function* (_audio, abortSignal) {
      signal = abortSignal;
      yield* pendingTranscription(_audio, abortSignal);
    });
    ws.close();
    ws.close();
    expect(signal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
  });

  it.each([
    [Buffer.alloc(3), 'invalid_audio'],
    [Buffer.alloc(32_770), 'frame_limit'],
    [{ type: 'unknown' }, 'invalid_message'],
  ])('rejects invalid input without invoking more work', async (input, code) => {
    const { ws } = connect(pendingTranscription);
    ws.receive(input);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code });
  });

  it('bounds finalization time and never emits finished after a timeout', async () => {
    vi.useFakeTimers();
    const { ws } = connect(pendingTranscription);
    ws.receive({ type: 'finish' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'finalize_timeout' });
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
  });

  it('rejects audio faster than realtime instead of unbounded buffering', () => {
    const { ws } = connect(pendingTranscription);
    ws.receive(Buffer.alloc(32_000));
    ws.receive(Buffer.alloc(32_000));
    ws.receive(Buffer.alloc(32_000));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'audio_rate_limit' });
  });

  it('bounds queued input when the provider stops consuming', async () => {
    vi.useFakeTimers();
    const { ws } = connect(pendingTranscription);
    for (let second = 0; second < 5; second++) {
      ws.receive(Buffer.alloc(32_000));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'audio_backpressure' });
  });

  it('releases the microphone relay when no audio arrives', async () => {
    vi.useFakeTimers();
    const { ws, release } = connect(pendingTranscription);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'audio_timeout' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects input after finish rather than transcribing a second implicit turn', () => {
    const { ws } = connect(pendingTranscription);
    ws.receive({ type: 'finish' });
    ws.receive(Buffer.alloc(3200));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'audio_after_finish' });
  });

  it('ends capture at the five-minute wall-clock limit', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { ws, release } = connect(pendingTranscription);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'session_limit' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('stops rather than buffering transcripts for a stalled browser', async () => {
    const { ws } = connect(async function* (audio) {
      await consume(audio);
      yield { type: 'transcript-final', text: 'Final text' };
    });
    ws.bufferedAmount = 128_001;
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'client_backpressure' });
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
  });
});

describe('voice upgrade authorization', () => {
  function request(origin = 'https://chat.example') {
    const socket = new PassThrough();
    let response = '';
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
    });
    const req = {
      url: '/ui/chat/api/groups/group/chat/thread/voice/stream',
      headers: { origin },
    } as http.IncomingMessage;
    return { socket, req, response: () => response };
  }
  const options = { expectedOrigin: 'https://chat.example', canSend: () => true };

  it('rejects cross-origin microphone relays', () => {
    const input = request('https://attacker.example');
    expect(handleVoiceUpgrade(input.req, input.socket, Buffer.alloc(0), options)).toBe(true);
    expect(input.response()).toContain('403');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('uses the actual AI SDK ElevenLabs adapter with header auth, raw audio, revisions and final commit', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    let receivedKey: string | string[] | undefined;
    let receivedAudio = false;
    let committed = false;
    server.on('connection', (socket, request) => {
      receivedKey = request.headers['xi-api-key'];
      socket.send(JSON.stringify({ message_type: 'session_started', session_id: 'test-session' }));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { audio_base_64: string; commit: boolean; sample_rate: number };
        expect(message.sample_rate).toBe(16_000);
        if (message.commit) {
          committed = true;
          socket.send(JSON.stringify({ message_type: 'committed_transcript', text: 'Cache.' }));
        } else {
          receivedAudio = Buffer.from(message.audio_base_64, 'base64').length === 3200;
          socket.send(JSON.stringify({ message_type: 'partial_transcript', text: 'cash' }));
          socket.send(JSON.stringify({ message_type: 'partial_transcript', text: 'cache' }));
        }
      });
    });
    class LocalProviderSocket extends VoiceProviderSocket {
      constructor(
        _url: string | URL,
        protocols?: string | string[],
        options?: { headers?: Record<string, string | undefined> },
      ) {
        super(`ws://127.0.0.1:${port}`, protocols, options);
      }
    }
    const audio = new TransformStream<Uint8Array, Uint8Array>();
    const writer = audio.writable.getWriter();
    const abort = new AbortController();
    const parts: TranscriptionStreamPart[] = [];
    const pending = (async () => {
      for await (const part of elevenLabsTranscriber('fixture-key', LocalProviderSocket)(
        audio.readable,
        abort.signal,
      )) {
        parts.push(part);
      }
    })();
    try {
      await writer.write(new Uint8Array(3200));
      await vi.waitFor(() => expect(parts.filter((part) => part.type === 'transcript-partial')).toHaveLength(2));
      expect(committed).toBe(false);
      expect(receivedKey).toBe('fixture-key');
      expect(receivedAudio).toBe(true);
      await writer.close();
      await pending;
      expect(committed).toBe(true);
      expect(parts.at(-1)).toMatchObject({ type: 'transcript-final', text: 'Cache.' });
    } finally {
      abort.abort();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('requires authentication', () => {
    vi.mocked(authenticate).mockReturnValueOnce(null);
    const input = request();
    handleVoiceUpgrade(input.req, input.socket, Buffer.alloc(0), options);
    expect(input.response()).toContain('401');
  });
  it('rejects inaccessible groups and read-only targets', () => {
    vi.mocked(canAccessAgentGroup).mockReturnValueOnce({ allowed: false, reason: 'not_member' });
    const input = request();
    handleVoiceUpgrade(input.req, input.socket, Buffer.alloc(0), options);
    expect(input.response()).toContain('403');
    const spectator = request();
    handleVoiceUpgrade(spectator.req, spectator.socket, Buffer.alloc(0), { ...options, canSend: () => false });
    expect(spectator.response()).toContain('403');
  });
  it('does not open a provider connection when configuration is unavailable', () => {
    vi.mocked(resolveVoiceInputConfig).mockReturnValueOnce({ backend: 'disabled', ready: false, reason: 'Disabled' });
    const input = request();
    handleVoiceUpgrade(input.req, input.socket, Buffer.alloc(0), options);
    expect(input.response()).toContain('503');
  });
});
