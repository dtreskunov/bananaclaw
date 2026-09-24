import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureVoice, voiceBrowserReason } from './voice-audio';

const contexts: FakeContext[] = [];
const nodes: FakeWorklet[] = [];
class FakeContext {
  audioWorklet = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  destination = {};
  source = { connect: vi.fn(), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  constructor(public options: { sampleRate: number }) {
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser voice capture', () => {
  it('uses the static worklet at 16kHz and flushes final PCM before releasing hardware', async () => {
    const chunks = vi.fn();
    const capture = await captureVoice(chunks, vi.fn());
    expect(contexts[0].options).toEqual({ sampleRate: 16000 });
    expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledWith('/ui/chat/voice-worklet.js');
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
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
