import { VoiceController, type VoiceCapture } from './voice';
import type { VoiceDiagnostic } from '../../../shared/voice';

export function voiceBrowserReason(): string | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)
    return 'Microphone access requires a supported browser and HTTPS.';
  if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined')
    return 'Live voice requires AudioWorklet support in this browser.';
  return null;
}

export async function captureVoice(
  onChunk: (chunk: ArrayBuffer) => void,
  onError: (message: string) => void,
  signal?: AbortSignal,
): Promise<VoiceCapture> {
  const reason = voiceBrowserReason();
  if (reason) throw new Error(reason);
  const context = new AudioContext();
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let closed = false;
  const stopTracks = (): void => {
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      try {
        track.stop();
      } catch {
        /* Still stop the remaining tracks. */
      }
    }
  };
  const cancel = (): void => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', cancel);
    // Hardware release must not depend on successful worklet/graph teardown.
    stopTracks();
    try {
      source?.disconnect();
    } catch {
      /* The audio graph may already be disconnected. */
    }
    try {
      node?.disconnect();
    } catch {
      /* Continue closing the context after worklet failure. */
    }
    try {
      void context.close().catch(() => {});
    } catch {
      /* The context may already have closed. */
    }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const checkCancelled = (): void => {
    if (!closed) return;
    stopTracks();
    throw new Error('Microphone capture was cancelled.');
  };
  try {
    checkCancelled();
    // Resume before getUserMedia's permission prompt consumes the user gesture.
    const resumed = context.resume();
    const worklet = context.audioWorklet.addModule('/ui/chat/voice-worklet.js');
    const microphone = navigator.mediaDevices
      .getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      .then((value) => {
        stream = value;
        if (closed) {
          stopTracks();
          stream = null;
        }
        return value;
      });
    const [, , readyStream] = await Promise.all([resumed, worklet, microphone]);
    checkCancelled();
    node = new AudioWorkletNode(context, 'voice-pcm');
    source = context.createMediaStreamSource(readyStream);
    source.connect(node);
    node.connect(context.destination); // Worklet outputs silence; never monitor the microphone.
    node.port.onmessage = ({ data }) => {
      if (!closed && data instanceof ArrayBuffer) onChunk(data);
    };
    node.onprocessorerror = () => onError('Audio capture failed. Current text has been kept.');
    for (const track of readyStream.getTracks())
      track.onended = () => onError('Microphone disconnected. Current text has been kept.');
    return {
      cancel,
      stop: () =>
        new Promise<void>((resolve, reject) => {
          if (closed) {
            resolve();
            return;
          }
          const timeout = setTimeout(() => {
            cancel();
            reject(new Error('Audio flush timed out'));
          }, 1000);
          node!.port.onmessage = ({ data }) => {
            if (data instanceof ArrayBuffer) onChunk(data);
            else if (data === 'flushed') {
              clearTimeout(timeout);
              cancel();
              resolve();
            }
          };
          try {
            node!.port.postMessage('finish');
          } catch (error) {
            clearTimeout(timeout);
            cancel();
            reject(error);
          }
        }),
    };
  } catch (error) {
    cancel();
    throw error;
  }
}

export async function reportVoiceDiagnostic(groupId: string, diagnostic: VoiceDiagnostic): Promise<void> {
  try {
    const response = await fetch(`/ui/chat/api/groups/${encodeURIComponent(groupId)}/voice/diagnostics`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diagnostic),
    });
    if (!response.ok)
      console.warn('Voice diagnostics delivery failed', { attemptId: diagnostic.attemptId, status: response.status });
  } catch {
    console.warn('Voice diagnostics delivery failed', { attemptId: diagnostic.attemptId });
  }
}

export const voice = new VoiceController({
  socket: (url) => new WebSocket(url),
  capture: captureVoice,
  origin: () => location.origin,
  attemptId: () => crypto.randomUUID(),
  report: reportVoiceDiagnostic,
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) voice.interrupt();
  });
  window.addEventListener('pagehide', () => voice.interrupt());
}
