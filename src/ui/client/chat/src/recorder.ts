/** Audio attachments only. Live dictation is handled by voice.ts. */
import { signal } from '@preact/signals';

export const isRecording = signal(false);
export const recordingDuration = signal(0);
export function hasGetUserMedia(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
let startedAt = 0;
let chunks: Blob[] = [];

export async function startRecording(): Promise<boolean> {
  if (isRecording.value || !hasGetUserMedia() || typeof MediaRecorder === 'undefined') return false;
  const token = ++generation;
  isRecording.value = true;
  try {
    const next = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (token !== generation) {
      next.getTracks().forEach((track) => track.stop());
      return false;
    }
    stream = next;
    const mimeType = ['audio/ogg;codecs=opus', 'audio/mp4;codecs=opus', 'audio/mp4', 'audio/webm;codecs=opus'].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    recorder = new MediaRecorder(next, mimeType ? { mimeType } : undefined);
    chunks = [];
    recorder.ondataavailable = ({ data }) => {
      if (token === generation && data.size) chunks.push(data);
    };
    recorder.onerror = () => {
      if (token === generation) cancelRecording();
    };
    recorder.start(250);
    startedAt = Date.now();
    timer = setInterval(() => {
      recordingDuration.value = Date.now() - startedAt;
    }, 250);
    return true;
  } catch {
    if (token === generation) cancelRecording();
    return false;
  }
}

export function stopRecording(): Promise<{ blob: Blob; durationMs: number } | null> {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') {
      cancelRecording();
      resolve(null);
      return;
    }
    const active = recorder;
    const token = generation;
    active.onstop = () => {
      if (token !== generation) {
        resolve(null);
        return;
      }
      const durationMs = Date.now() - startedAt;
      const blob = new Blob(chunks, { type: active.mimeType || 'audio/webm' });
      cleanup();
      resolve(durationMs < 2000 ? null : { blob, durationMs });
    };
    active.stop();
  });
}

export function cancelRecording(): void {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  cleanup();
}

function cleanup(): void {
  generation++;
  if (timer) clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  recorder = null;
  chunks = [];
  isRecording.value = false;
  recordingDuration.value = 0;
}
