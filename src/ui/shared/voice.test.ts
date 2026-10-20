import { describe, expect, it } from 'vitest';
import { isVoiceAttemptId, isVoiceDiagnostic, type VoiceDiagnostic } from './voice.js';

const diagnostic: VoiceDiagnostic = {
  attemptId: '11111111-2222-4333-8444-555555555555',
  outcome: 'finished',
  elapsedMs: 1500,
  peakQueuedBytes: 6400,
  captureReadyMs: 100,
  socketReadyMs: 500,
  firstAudioMs: 300,
  firstTranscriptMs: 1200,
};

describe('privacy-safe voice diagnostics', () => {
  it('accepts only bounded counters, fixed categories and UUIDs', () => {
    expect(isVoiceDiagnostic(diagnostic)).toBe(true);
    expect(isVoiceDiagnostic({ ...diagnostic, outcome: 'failed', failure: 'permission' })).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { ...diagnostic, transcript: 'private words' },
    { ...diagnostic, message: 'xi-api-key: private' },
    { ...diagnostic, audio: 'private bytes' },
    { ...diagnostic, attemptId: 'private words' },
    { ...diagnostic, outcome: 'arbitrary' },
    { ...diagnostic, outcome: 'failed' },
    { ...diagnostic, outcome: 'failed', failure: 'xi-api-key: private' },
    { ...diagnostic, failure: 'permission' },
    { ...diagnostic, elapsedMs: -1 },
    { ...diagnostic, elapsedMs: 360001 },
    { ...diagnostic, audioBytes: 32000 },
    { ...diagnostic, peakQueuedBytes: 128001 },
    { ...diagnostic, firstAudioMs: 1.5 },
    { ...diagnostic, firstAudioMs: NaN },
  ])('rejects unsafe or invalid diagnostic payload %#', (payload) => {
    expect(isVoiceDiagnostic(payload)).toBe(false);
  });

  it('rejects untrusted correlation identifiers', () => {
    expect(isVoiceAttemptId('private')).toBe(false);
  });
});
