export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2;
export const VOICE_MAX_FRAME_BYTES = 32_768;
export const VOICE_MAX_BUFFER_BYTES = VOICE_BYTES_PER_SECOND * 4;
// Leave one frame of relay headroom for network jitter and provider startup.
export const VOICE_UPLOAD_BURST_BYTES = VOICE_MAX_BUFFER_BYTES - VOICE_MAX_FRAME_BYTES;

const FAILURES = [
  'capture',
  'permission',
  'connection',
  'protocol',
  'buffer',
  'finalize',
  'provider',
  'interrupted',
] as const;
export type VoiceFailure = (typeof FAILURES)[number];
const TIMING_KEYS = ['captureReadyMs', 'socketReadyMs', 'firstAudioMs', 'firstTranscriptMs'] as const;

export interface VoiceDiagnostic {
  attemptId: string;
  outcome: 'finished' | 'cancelled' | 'failed';
  failure?: VoiceFailure;
  elapsedMs: number;
  peakQueuedBytes: number;
  captureReadyMs?: number;
  socketReadyMs?: number;
  firstAudioMs?: number;
  firstTranscriptMs?: number;
}

export function isVoiceAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function boundedInteger(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function isVoiceDiagnostic(value: unknown): value is VoiceDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const allowed = ['attemptId', 'outcome', 'failure', 'elapsedMs', 'peakQueuedBytes', ...TIMING_KEYS];
  return (
    Object.keys(fields).every((key) => allowed.includes(key)) &&
    isVoiceAttemptId(fields.attemptId) &&
    oneOf(fields.outcome, ['finished', 'cancelled', 'failed']) &&
    (fields.outcome === 'failed' ? oneOf(fields.failure, FAILURES) : fields.failure === undefined) &&
    boundedInteger(fields.elapsedMs, 360_000) &&
    boundedInteger(fields.peakQueuedBytes, VOICE_MAX_BUFFER_BYTES) &&
    TIMING_KEYS.every((key) => fields[key] === undefined || boundedInteger(fields[key], 360_000))
  );
}
