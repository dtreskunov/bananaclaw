import { describe, expect, it } from 'bun:test';

import { openRouterAudioFormat } from './transcribe.js';

describe('openRouterAudioFormat', () => {
  it('uses OpenRouter audio format names for attachment MIME types', () => {
    expect(openRouterAudioFormat('audio/mp4')).toBe('m4a');
    expect(openRouterAudioFormat('audio/mpeg')).toBe('mp3');
    expect(openRouterAudioFormat('audio/ogg')).toBe('ogg');
    expect(openRouterAudioFormat('audio/wav')).toBe('wav');
    expect(openRouterAudioFormat('audio/webm')).toBe('webm');
  });

  it('rejects unknown MIME types', () => {
    expect(openRouterAudioFormat('video/mp4')).toBeUndefined();
  });
});