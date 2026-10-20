import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureVoice, reportVoiceDiagnostic, voiceBrowserReason } from './voice-audio';
import type { VoiceDiagnostic } from '../../../shared/voice';

const contexts: FakeContext[] = [];
const nodes: FakeWorklet[] = [];
class FakeContext {
  audioWorklet = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  destination = {};
  source = { connect: vi.fn(), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  constructor(public options?: AudioContextOptions) {
    contexts.push(this);
  }
}
class FakeWorklet {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;
  constructor() {
    nodes.push(this);
  }
}
let track: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };
let media: { getTracks(): (typeof track)[] };
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  contexts.length = nodes.length = 0;
  track = { stop: vi.fn(), onended: null };
  media = { getTracks: () => [track] };
  getUserMedia = vi.fn(async () => media);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('voice diagnostic delivery', () => {
  const diagnostic: VoiceDiagnostic = {
    attemptId: '11111111-2222-4333-8444-555555555555',
    outcome: 'cancelled',
    elapsedMs: 300,
    peakQueuedBytes: 0,
  };

  it('uses an authenticated same-origin keepalive request so disconnects can still be diagnosed', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetch);
    const reporting = reportVoiceDiagnostic('a/b', diagnostic);
    expect(fetch).toHaveBeenCalledWith('/ui/chat/api/groups/a%2Fb/voice/diagnostics', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diagnostic),
    });
    await reporting;
  });

  it.each([false, true])('reports failed diagnostic delivery safely (network failure: %s)', async (networkFailure) => {
    const fetch = vi.fn();
    if (networkFailure) fetch.mockRejectedValue(new Error('private network error'));
    else fetch.mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal('fetch', fetch);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportVoiceDiagnostic('g', diagnostic);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });

  it('contains synchronous transport errors so diagnostics cannot break dictation cleanup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('private transport error');
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(reportVoiceDiagnostic('g', diagnostic)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });
});

describe('browser voice capture', () => {
  it('requests permission and loads the worklet without waiting for audio context resume', async () => {
    let resume!: () => void;
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        override resume = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resume = resolve;
            }),
        );
      },
    );
    const starting = captureVoice(vi.fn(), vi.fn());
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledOnce();
    resume();
    const capture = await starting;
    capture.cancel();
  });

  it('releases late-granted tracks when worklet initialization has already failed', async () => {
    let grant!: (value: typeof media) => void;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        override audioWorklet = {
          addModule: vi.fn(async () => {
            throw new Error('Worklet unavailable');
          }),
        };
      },
    );
    await expect(captureVoice(vi.fn(), vi.fn())).rejects.toThrow('Worklet unavailable');
    grant(media);
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it('uses the native capture rate and flushes resampled PCM before releasing hardware', async () => {
    const chunks = vi.fn();
    const capture = await captureVoice(chunks, vi.fn());
    expect(contexts[0].options).toBeUndefined();
    expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledWith('/ui/chat/voice-worklet.js');
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const stopping = capture.stop();
    expect(nodes[0].port.postMessage).toHaveBeenCalledWith('finish');
    const pcm = new ArrayBuffer(640);
    nodes[0].port.onmessage!({ data: pcm });
    nodes[0].port.onmessage!({ data: 'flushed' });
    await stopping;
    expect(chunks).toHaveBeenCalledWith(pcm);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(nodes[0].disconnect).toHaveBeenCalledOnce();
  });

  it('releases the audio context after microphone permission is denied', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(captureVoice(vi.fn(), vi.fn())).rejects.toThrow('Permission denied');
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(nodes).toHaveLength(0);
  });

  it('cancels during a pending permission prompt and stops late-granted tracks immediately', async () => {
    let resolve!: (value: typeof media) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const abort = new AbortController();
    const starting = captureVoice(vi.fn(), vi.fn(), abort.signal);
    await Promise.resolve();
    await Promise.resolve();
    abort.abort();
    resolve(media);
    await expect(starting).rejects.toThrow('cancelled');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(nodes).toHaveLength(0);
  });

  it('cancels an active capture, disconnects tracks, and ignores late PCM', async () => {
    const chunks = vi.fn();
    const abort = new AbortController();
    await captureVoice(chunks, vi.fn(), abort.signal);
    abort.abort();
    nodes[0].port.onmessage!({ data: new ArrayBuffer(320) });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(chunks).not.toHaveBeenCalled();
  });

  it('rejects rather than claiming success if the worklet cannot flush', async () => {
    const capture = await captureVoice(vi.fn(), vi.fn());
    const stopping = capture.stop();
    const rejected = expect(stopping).rejects.toThrow('flush timed out');
    vi.advanceTimersByTime(1000);
    await rejected;
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('stops every raw track and closes the context even when graph teardown throws', async () => {
    const secondTrack = { stop: vi.fn(), onended: null };
    media.getTracks = () => [track, secondTrack];
    const capture = await captureVoice(vi.fn(), vi.fn());
    track.stop.mockImplementationOnce(() => {
      throw new Error('Track already stopped');
    });
    contexts[0].source.disconnect.mockImplementationOnce(() => {
      throw new Error('Graph already disconnected');
    });
    nodes[0].disconnect.mockImplementationOnce(() => {
      throw new Error('Worklet failed');
    });
    expect(() => capture.cancel()).not.toThrow();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it('stops hardware immediately if posting the flush request throws', async () => {
    const capture = await captureVoice(vi.fn(), vi.fn());
    nodes[0].port.postMessage.mockImplementationOnce(() => {
      throw new Error('Port unavailable');
    });
    await expect(capture.stop()).rejects.toThrow('Port unavailable');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports disconnected microphones and processor errors', async () => {
    const error = vi.fn();
    const capture = await captureVoice(vi.fn(), error);
    track.onended!();
    nodes[0].onprocessorerror!();
    expect(error).toHaveBeenCalledTimes(2);
    capture.cancel();
    expect(track.onended).toBeNull();
  });

  it('provides explicit browser capability reasons', () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    expect(voiceBrowserReason()).toContain('AudioWorklet');
    vi.stubGlobal('navigator', {});
    expect(voiceBrowserReason()).toContain('HTTPS');
  });
});
