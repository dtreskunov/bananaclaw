/**
 * Audio recording module for the push-to-talk feature.
 *
 * Wraps MediaRecorder (for audio capture) and optionally the Web Speech API
 * (for live transcription in "transcribe" mode). Exports reactive signals for
 * the Composer to observe.
 */
import { signal } from '@preact/signals';

// ── Public signals ──────────────────────────────────────────────────

export const isRecording = signal(false);
export const recordingDuration = signal(0);

// ── Feature detection ───────────────────────────────────────────────

export function hasGetUserMedia(): boolean {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export function hasSpeechRecognition(): boolean {
  return !!(
    (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition
  );
}

function appendTranscriptDelta(text: string, delta: string): string {
  if (!text || !delta) return text + delta;
  if (/\s$/.test(text) || /^\s/.test(delta)) return text + delta;
  // LLM transcription tokens occasionally arrive without their leading space,
  // producing "Hello.World" or "okay,let's". Insert one when the boundary
  // looks like a word break — the previous chunk ends in a letter/digit or a
  // sentence-final / closing punctuation mark, and the new chunk starts with
  // a letter/digit or an opening bracket/quote.
  const endsWord = /[\p{L}\p{N}.,!?;:)\]}"]$/u.test(text);
  const startsWord = /^[\p{L}\p{N}([{"]/u.test(delta);
  if (endsWord && startsWord) return `${text} ${delta}`;
  return text + delta;
}

// ── Internals ───────────────────────────────────────────────────────

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let stream: MediaStream | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognition: any = null;
let transcript = '';
let durationTimer: ReturnType<typeof setInterval> | null = null;
let startTime = 0;
let recordingToken = 0;

const MIN_DURATION_MS = 2000;

// ── Public API ──────────────────────────────────────────────────────

export interface RecordingResult {
  blob: Blob;
  transcript: string | null;
  durationMs: number;
}

/**
 * Start recording audio from the user's microphone.
 * @param transcribe  If true, also start Web Speech API recognition.
 * @returns true on success, false if permission denied or unsupported.
 */
export async function startRecording(transcribe: boolean): Promise<boolean> {
  if (isRecording.value) return true;

  if (!hasGetUserMedia()) return false;

  const token = ++recordingToken;
  let nextStream: MediaStream;

  try {
    nextStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return false;
  }

  if (token !== recordingToken) {
    for (const track of nextStream.getTracks()) track.stop();
    return false;
  }

  stream = nextStream;

  audioChunks = [];
  transcript = '';

  // Pick the best available audio format. Prefer formats that model providers
  // accept (ogg, mp4/m4a). Chrome doesn't support ogg in MediaRecorder but
  // does support mp4. Firefox supports ogg. Avoid webm — most providers reject it.
  const mimeType = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
    ? 'audio/ogg;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/mp4;codecs=opus')
      ? 'audio/mp4;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : '';

  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) audioChunks.push(ev.data);
  };
  mediaRecorder.start(250); // collect chunks every 250ms for snappy stop

  // Duration tracking
  startTime = Date.now();
  recordingDuration.value = 0;
  durationTimer = setInterval(() => {
    recordingDuration.value = Date.now() - startTime;
  }, 1000);

  // Optional speech recognition
  if (transcribe && hasSpeechRecognition()) {
    const SpeechRecognitionCtor =
      (window as unknown as Record<string, unknown>).SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition = new (SpeechRecognitionCtor as any)();
    recognition.continuous = true;
    recognition.interimResults = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) {
          transcript += ev.results[i][0].transcript;
        }
      }
    };
    recognition.onerror = () => {
      /* best effort */
    };
    try {
      recognition.start();
    } catch {
      /* ignore if already started */
    }
  }

  isRecording.value = true;
  return true;
}

/**
 * Stop recording and return the result.
 * Returns null if the recording was too short (< 2s) — caller should
 * treat this as a discard.
 */
export function stopRecording(): Promise<RecordingResult | null> {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      cleanup();
      resolve(null);
      return;
    }

    mediaRecorder.onstop = () => {
      const durationMs = Date.now() - startTime;
      const mimeType = mediaRecorder?.mimeType || 'audio/webm';
      const chunks = audioChunks.slice();
      const finalTranscript = transcript.trim() || null;
      cleanup();

      if (durationMs < MIN_DURATION_MS) {
        resolve(null);
        return;
      }

      const ext = mimeType.includes('webm') ? 'webm' : 'ogg';
      const blob = new Blob(chunks, { type: mimeType });
      resolve({
        blob,
        transcript: finalTranscript,
        durationMs,
      });
    };

    // Stop recognition first
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    }

    mediaRecorder.stop();
  });
}

/**
 * Cancel recording without producing output.
 */
export function cancelRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
  }
  cleanup();
}

// ── Helpers ─────────────────────────────────────────────────────────

function cleanup(): void {
  recordingToken++;
  if (durationTimer) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  mediaRecorder = null;
  recognition = null;
  audioChunks = [];
  isRecording.value = false;
  recordingDuration.value = 0;
}

// ── Server-side streaming transcription ─────────────────────────────

export interface TranscribeCallbacks {
  onPartial: (delta: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

/**
 * POST audio to the server and stream SSE transcript chunks back.
 * Returns an AbortController for cancellation.
 */
export function transcribeViaServer(
  blob: Blob,
  groupId: string,
  threadId: string,
  callbacks: TranscribeCallbacks,
): AbortController {
  const controller = new AbortController();
  const fd = new FormData();
  const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'mp4' : 'ogg';
  fd.append('audio', blob, `voice.${ext}`);

  const url = `/ui/chat/api/groups/${encodeURIComponent(groupId)}/chat/${encodeURIComponent(threadId)}/voice/transcribe`;

  fetch(url, {
    method: 'POST',
    body: fd,
    signal: controller.signal,
    credentials: 'same-origin',
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        const errJson = await res.text().catch(() => '');
        callbacks.onError(errJson || `http_${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let fullText = '';
      let doneFired = false;
      const fireDone = (text: string): void => {
        if (doneFired) return;
        doneFired = true;
        callbacks.onDone(text);
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data) as { text?: string; error?: string };
              if (eventType === 'partial' && parsed.text) {
                const nextText = appendTranscriptDelta(fullText, parsed.text);
                const normalizedDelta = nextText.slice(fullText.length);
                fullText = nextText;
                callbacks.onPartial(normalizedDelta);
              } else if (eventType === 'done' && parsed.text) {
                fireDone(parsed.text);
              } else if (eventType === 'error') {
                callbacks.onError(parsed.error || 'transcription_failed');
              }
            } catch {
              /* skip malformed */
            }
            eventType = '';
          }
        }
      }
      // If we never got a done event but accumulated text, treat as done
      if (fullText && !controller.signal.aborted) {
        fireDone(fullText);
      }
    })
    .catch((err) => {
      if (!controller.signal.aborted) {
        callbacks.onError(err instanceof Error ? err.message : 'network_error');
      }
    });

  return controller;
}
