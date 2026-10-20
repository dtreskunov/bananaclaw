import { EventEmitter, once } from 'node:events';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { NoTranscriptGeneratedError, type TranscriptionStreamPart } from 'ai';

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
vi.mock('../../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { authenticate } from '../auth.js';
import { log } from '../../../log.js';
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
  attachVoiceStream(
    ws as unknown as WebSocket,
    transcribe,
    {
      userId: 'user',
      groupId: 'group',
      attemptId: '11111111-2222-4333-8444-555555555555',
    },
    release,
  );
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

  it('promotes provisional text when a committed stream ends without a final event', () => {
    const transcript = new VoiceTranscriptNormalizer();
    const partial = transcript.accept({ type: 'transcript-partial', id: 'one', text: 'Complete thought' });
    expect(transcript.finalizeProvisionalText()).toEqual([{ ...partial, sequence: 2, final: true }]);
    expect(transcript.hasProvisionalText()).toBe(false);
    expect(transcript.finalizeProvisionalText()).toEqual([]);
  });

  it('promotes nonempty provisional segments while dropping an adjacent copy of the last final', () => {
    const transcript = new VoiceTranscriptNormalizer();
    const first = transcript.accept({ type: 'transcript-final', id: 'one', text: 'Hello.' });
    transcript.accept({ type: 'transcript-partial', id: 'two', text: 'Hello.' });
    const next = transcript.accept({ type: 'transcript-partial', id: 'three', text: 'Next thought' });
    transcript.accept({ type: 'transcript-partial', id: 'four', text: '   ' });
    expect(transcript.finalizeProvisionalText()).toEqual([{ ...next, sequence: 5, final: true }]);
    expect(transcript.hasProvisionalText()).toBe(false);
    expect(transcript.finalizeProvisionalText()).toEqual([]);
    expect(transcript.accept({ type: 'transcript-partial', id: 'two', text: 'late' })).toBeUndefined();
    expect(first).toBeDefined();
  });

  it('drops an adjacent duplicate final with a new provider ID but preserves a newly started repetition', () => {
    const transcript = new VoiceTranscriptNormalizer();
    const first = transcript.accept({ type: 'transcript-final', id: 'one', text: 'Repeat me.' });
    expect(first).toBeDefined();
    expect(transcript.accept({ type: 'transcript-final', id: 'two', text: 'Repeat me.' })).toBeUndefined();
    const repeated = transcript.accept({ type: 'transcript-partial', id: 'three', text: 'Repeat me' });
    expect(repeated).toBeDefined();
    expect(transcript.accept({ type: 'transcript-final', id: 'three', text: 'Repeat me.' })).toMatchObject({
      id: repeated?.id,
      text: 'Repeat me.',
      final: true,
    });
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
  it('correlates provider readiness and audio-level statistics without logging transcript content', async () => {
    const { ws } = connect(async function* (audio) {
      yield { type: 'raw', rawValue: { message_type: 'session_started' } };
      await consume(audio);
      yield { type: 'transcript-final', text: 'private transcript content' };
    });
    const pcm = Buffer.alloc(6400);
    for (let i = 0; i < pcm.byteLength; i += 2) pcm.writeInt16LE(32767, i);
    ws.receive(pcm);
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(log.info).toHaveBeenCalledWith(
      'Voice input ended',
      expect.objectContaining({
        attemptId: '11111111-2222-4333-8444-555555555555',
        outcome: 'finished',
        inputBytes: 6400,
        audioMs: 200,
        rmsPcm: 32767,
        peakPcm: 32767,
        clippedSamples: 3200,
        providerReadyMs: expect.any(Number),
        firstAudioMs: expect.any(Number),
        firstTranscriptMs: expect.any(Number),
        finalizationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain('private transcript content');
    expect(ws.sent.some((event) => event.type === 'provider_ready')).toBe(false);
  });

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

  it('finalizes the latest provisional text after a clean user-requested finish', async () => {
    const { ws } = connect(async function* (audio) {
      yield { type: 'transcript-partial', text: 'unfinished' };
      await consume(audio);
    });
    ws.receive(Buffer.alloc(3200));
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.slice(-2)).toEqual([
      expect.objectContaining({ type: 'transcript', text: 'unfinished', final: true }),
      { type: 'finished' },
    ]);
  });

  it('recovers provisional text after an SDK empty result without a confirmed empty final', async () => {
    const { ws } = connect(async function* (audio) {
      yield { type: 'transcript-partial', text: 'recognized speech' };
      await consume(audio);
      throw new NoTranscriptGeneratedError({ responses: [] });
    });
    ws.receive(Buffer.alloc(3200));
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.slice(-2)).toEqual([
      expect.objectContaining({ type: 'transcript', text: 'recognized speech', final: true }),
      { type: 'finished' },
    ]);
    expect(log.warn).toHaveBeenCalledWith('Voice input finalized provisional text without a provider final', {
      userId: 'user',
      groupId: 'group',
      attemptId: '11111111-2222-4333-8444-555555555555',
      segmentCount: 1,
    });
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('recognized speech');
  });

  it.each([0, -32768])('distinguishes silent PCM from unrecognized audio (sample: %i)', async (sample) => {
    const { ws } = connect(async function* (audio) {
      await consume(audio);
      yield* [];
      throw new NoTranscriptGeneratedError({ responses: [] });
    });
    const pcm = Buffer.alloc(3200);
    pcm.writeInt16LE(sample);
    ws.receive(pcm);
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'error',
      code: 'no_speech',
      message:
        sample === 0
          ? 'The microphone produced silent audio. Check the selected microphone and try again.'
          : 'No speech was recognized. Speak clearly and try again.',
    });
    expect(log.warn).toHaveBeenCalledWith(
      'Voice transcription provider failed',
      expect.objectContaining({ failureKind: 'no_transcript', inputBytes: 3200, peakPcm: Math.abs(sample) }),
    );
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
  });

  it('does not promote provisional text on a provider failure other than an empty result', async () => {
    const { ws } = connect(async function* (audio) {
      yield { type: 'transcript-partial', text: 'Keep this draft' };
      await consume(audio);
      throw new Error('Network disconnected');
    });
    ws.receive(Buffer.alloc(3200));
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'transcription_failed' });
    expect(ws.sent.some((event) => event.type === 'finished' || event.final === true)).toBe(false);
  });

  it('does not claim success when the provider ends before the user finishes', async () => {
    const { ws } = connect(async function* () {
      yield { type: 'transcript-partial', text: 'unfinished' };
    });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'incomplete_transcript' });
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
  });

  it('surfaces provider errors without leaking headers or audio', async () => {
    const { ws } = connect(async function* () {
      const error = new Error('xi-api-key: secret; audio: private');
      error.name = 'ProviderError: private';
      yield { type: 'error', error };
    });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'transcription_failed' });
    expect(JSON.stringify(ws.sent)).not.toContain('secret');
    expect(JSON.stringify(ws.sent)).not.toContain('private');
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('secret');
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('private');
    expect(log.warn).toHaveBeenCalledWith(
      'Voice transcription provider failed',
      expect.objectContaining({ failureKind: 'provider_error' }),
    );
  });

  it.each(['cancel', 'timeout', 'disconnect'])('ignores a late empty-result rejection after %s', async (ending) => {
    vi.useFakeTimers();
    const { ws, release } = connect(async function* (_audio, signal) {
      yield { type: 'transcript-partial', text: 'Keep this draft' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new NoTranscriptGeneratedError({ responses: [] });
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'transcript', final: false });
    const close = vi.spyOn(ws, 'close');
    ws.receive(Buffer.alloc(3200));
    ws.receive({ type: 'finish' });
    if (ending === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
    else if (ending === 'disconnect') ws.close();
    else ws.receive({ type: 'cancel' });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(ws.sent.some((event) => event.type === 'finished' || event.final === true)).toBe(false);
    expect(log.warn).not.toHaveBeenCalledWith('Voice transcription provider failed', expect.anything());
  });

  it.each([false, true])(
    'checks browser backpressure before promoting provisional text (empty result: %s)',
    async (emptyResult) => {
      const { ws } = connect(async function* (audio) {
        yield { type: 'transcript-partial', text: 'Keep this draft' };
        await consume(audio);
        if (emptyResult) throw new NoTranscriptGeneratedError({ responses: [] });
      });
      await vi.waitFor(() => expect(ws.sent.at(-1)).toMatchObject({ type: 'transcript', final: false }));
      ws.receive(Buffer.alloc(3200));
      ws.bufferedAmount = 128_001;
      ws.receive({ type: 'finish' });
      await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
      expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'client_backpressure' });
      expect(ws.sent.some((event) => event.type === 'finished' || event.final === true)).toBe(false);
    },
  );

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
    ws.receive(Buffer.alloc(3200));
    ws.receive({ type: 'finish' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'finalize_timeout' });
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
  });

  it('allows a bounded burst of buffered browser audio', () => {
    const { ws } = connect(pendingTranscription);
    ws.receive(Buffer.alloc(32_000));
    ws.receive(Buffer.alloc(32_000));
    ws.receive(Buffer.alloc(32_000));
    expect(ws.sent.some((event) => event.type === 'error')).toBe(false);
  });

  it('rejects sustained audio faster than realtime instead of unbounded buffering', () => {
    const { ws } = connect(pendingTranscription);
    for (let second = 0; second < 5; second++) ws.receive(Buffer.alloc(32_000));
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
    ws.receive(Buffer.alloc(3200));
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
    ws.receive(Buffer.alloc(3200));
    ws.bufferedAmount = 128_001;
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'client_backpressure' });
    expect(ws.sent.some((event) => event.type === 'finished')).toBe(false);
  });

  it('finishes a zero-audio attempt by aborting, without closing input or promoting fabricated text', async () => {
    let inputClosed = false;
    let inputClosedAtAbort: boolean | undefined;
    let signal: AbortSignal | undefined;
    const { ws, release } = connect(async function* (audio, abortSignal) {
      signal = abortSignal;
      const reader = audio.getReader();
      const ended = reader.read().then(({ done }) => {
        inputClosed = !!done;
      });
      await Promise.race([
        ended,
        new Promise<void>((resolve) => abortSignal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      inputClosedAtAbort = inputClosed;
      await reader.cancel();
      reader.releaseLock();
      yield* [];
    });
    ws.receive({ type: 'finish' });
    await vi.waitFor(() => expect(inputClosedAtAbort).toBeDefined());
    expect(signal?.aborted).toBe(true);
    expect(inputClosedAtAbort).toBe(false);
    expect(ws.sent).toEqual([{ type: 'ready' }, { type: 'finished' }]);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('ElevenLabs cleanup through the real SDK', () => {
  it.each([
    ['filler-only', ''],
    ['filler-then-words', 'Useful words.'],
    ['words-then-filler', 'Keep this.'],
  ])('preserves provider-confirmed removals for %s', async (scenario, expected) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    server.on('connection', (socket) => {
      const send = (message_type: string, text?: string) => socket.send(JSON.stringify({ message_type, text }));
      socket.send(JSON.stringify({ message_type: 'session_started', session_id: 'fixture' }));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { commit: boolean };
        if (message.commit) {
          send('committed_transcript', scenario === 'filler-then-words' ? 'Useful words.' : '');
        } else if (scenario === 'words-then-filler') {
          send('partial_transcript', 'Keep this');
          send('committed_transcript', 'Keep this.');
          send('partial_transcript', 'uh');
        } else {
          send('partial_transcript', 'uh, um');
          send('committed_transcript', '');
          if (scenario === 'filler-then-words') send('partial_transcript', 'Useful words');
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
    const { ws } = connect(elevenLabsTranscriber('fixture-key', LocalProviderSocket));
    try {
      ws.receive(Buffer.alloc(6400));
      await vi.waitFor(() => {
        const transcripts = ws.sent.filter((event) => event.type === 'transcript');
        const last = transcripts.at(-1);
        expect(last?.text).toBe(
          scenario === 'filler-then-words' ? 'Useful words' : scenario === 'words-then-filler' ? 'uh' : '',
        );
        expect(transcripts.length).toBeGreaterThanOrEqual(2);
      });
      ws.receive({ type: 'finish' });
      await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
      expect(ws.sent.at(-1)).toEqual({ type: 'finished' });
      const segments = new Map<string, string>();
      const finals = new Map<string, boolean>();
      for (const event of ws.sent) {
        if (event.type === 'transcript' && typeof event.id === 'string' && typeof event.text === 'string') {
          segments.set(event.id, event.text);
          finals.set(event.id, event.final === true);
        }
      }
      expect([...segments.values()].filter(Boolean).join(' ')).toBe(expected);
      expect([...finals.values()].every(Boolean)).toBe(true);
      expect(log.warn).not.toHaveBeenCalledWith(
        'Voice input finalized provisional text without a provider final',
        expect.anything(),
      );
    } finally {
      ws.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('provider socket teardown diagnostics', () => {
  it.each([false, true])('distinguishes unexpected closes from local cleanup (local: %s)', async (local) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const remote = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
    const socket = new VoiceProviderSocket(`ws://127.0.0.1:${port}`, undefined, undefined, {
      attemptId: '11111111-2222-4333-8444-555555555555',
    });
    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
    });
    try {
      const peer = await remote;
      if (local) socket.close();
      else peer.terminate();
      await closed;
      expect(local ? log.debug : log.warn).toHaveBeenCalledWith(
        'ElevenLabs voice socket closed abnormally',
        expect.objectContaining({
          attemptId: '11111111-2222-4333-8444-555555555555',
          closeRequested: local,
          code: local ? expect.any(Number) : 1006,
        }),
      );
      if (local) expect(log.warn).not.toHaveBeenCalled();
    } finally {
      socket.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
    expect(log.warn).toHaveBeenCalledWith(
      'Voice upgrade rejected',
      expect.objectContaining({ status: 403, code: 'origin' }),
    );
  });

  it('does not log untrusted attempt identifiers on upgrade rejection', () => {
    const input = request();
    input.req.url += '?attempt=private-credential';
    handleVoiceUpgrade(input.req, input.socket, Buffer.alloc(0), options);
    expect(input.response()).toContain('400');
    expect(log.warn).toHaveBeenCalledWith(
      'Voice upgrade rejected',
      expect.objectContaining({ code: 'invalid_attempt' }),
    );
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('private-credential');
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
      const params = new URL(request.url!, 'http://localhost').searchParams;
      expect(params.get('no_verbatim')).toBe('true');
      expect(params.get('enable_logging')).toBe('false');
      expect(params.get('commit_strategy')).toBe('vad');
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
        super(`ws://127.0.0.1:${port}${new URL(_url).search}`, protocols, options);
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
