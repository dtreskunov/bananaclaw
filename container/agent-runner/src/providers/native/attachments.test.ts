import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { audioRoutingReason, inlineHistoryBytes, prepareNativeUserMessage } from './attachments.js';
import type { prepareAudio } from './audio.js';
import { audioReferencePrompt, isAudioAttachment } from '../attachment-routing.js';

const audioModel = { protocol: 'openai-chat' as const, inputModalities: ['text', 'audio', 'image'] };
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-routing-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('audio routing', () => {
  it('recognizes common aliases without mistaking explicitly typed video for audio', () => {
    for (const mime of [' Audio/X-Wav; codecs=pcm ', 'application/ogg', 'application/octet-stream']) {
      expect(isAudioAttachment({ path: '/voice.opus', filename: 'voice.opus', mime })).toBe(true);
    }
    expect(isAudioAttachment({ path: '/video.webm', filename: 'video.webm', mime: 'video/webm' })).toBe(false);
  });
  it('returns explicit capability and transport reasons', () => {
    expect(audioRoutingReason()).toBe('model-audio-capability-unknown');
    expect(audioRoutingReason({ protocol: 'openai-chat', inputModalities: ['text'] })).toBe(
      'model-does-not-support-audio',
    );
    expect(audioRoutingReason({ ...audioModel, protocol: 'anthropic-messages' })).toBe(
      'adapter-does-not-support-audio',
    );
    expect(audioRoutingReason(audioModel)).toBeNull();
  });

  it('does not inspect files or run media tools for ineligible models', async () => {
    const prepare = mock<typeof prepareAudio>(async () => {
      throw new Error('Must not inspect');
    });
    const file = { path: '/missing/voice.ogg', filename: 'voice.ogg', mime: 'Audio/Ogg; codecs=opus' };
    for (const model of [
      undefined,
      { ...audioModel, inputModalities: ['text'] },
      { ...audioModel, protocol: 'anthropic-messages' as const },
    ]) {
      const result = await prepareNativeUserMessage('listen', [file], model, { prepare });
      expect(result.content).toContain(file.path);
      expect(result.content).toContain('"delivery":"file-reference"');
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns a truthful reference for failed preparations while retaining the prompt', async () => {
    const prepare: typeof prepareAudio = async () => ({ kind: 'file-reference', reason: 'probe-failed' });
    const file = { path: '/workspace/inbox/voice.webm', filename: 'voice.webm', mime: 'audio/webm' };
    const result = await prepareNativeUserMessage('original prompt', [file], audioModel, { prepare });
    expect(result.content).toContain('original prompt');
    expect(result.content).toContain(file.path);
    expect(result.content).toContain('probe-failed');
    expect(result.content).not.toContain('transcribed');
  });

  it('budgets base64 expansion across audio, images, and replayed history', async () => {
    const image = { path: path.join(root, 'image.png'), filename: 'image.png', mime: 'image/png' };
    fs.writeFileSync(image.path, Buffer.from([1, 2, 3]));
    const audio = { path: path.join(root, 'voice.ogg'), filename: 'voice.ogg', mime: 'audio/ogg' };
    const prepare = mock<typeof prepareAudio>(async (file) => ({
      kind: 'inline',
      file: { ...file, filename: 'voice.mp3', mime: 'audio/mpeg' },
      bytes: Buffer.from([4, 5, 6]),
      converted: true,
    }));
    const first = await prepareNativeUserMessage('listen', [image, audio, audio], audioModel, {
      prepare,
      maxInlineBytes: 8,
    });
    expect(inlineHistoryBytes([first])).toBe(8);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[1]?.maxOutputBytes).toBe(3);
    expect(JSON.stringify(first)).toContain('inline-payload-limit');
    expect(JSON.stringify(first)).toContain('"mediaType":"audio/mpeg"');
    const second = await prepareNativeUserMessage('follow up', [audio], audioModel, {
      prepare,
      maxInlineBytes: 8 - inlineHistoryBytes([first]),
    });
    expect(typeof second.content).toBe('string');
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('rejects preparation output exceeding the remaining inline limit', async () => {
    const file = { path: '/voice.wav', filename: 'voice.wav', mime: 'audio/wav' };
    const prepare: typeof prepareAudio = async () => ({
      kind: 'inline',
      file,
      bytes: Buffer.alloc(4),
      converted: false,
    });
    const result = await prepareNativeUserMessage('listen', [file], audioModel, { prepare, maxInlineBytes: 4 });
    expect(result.content).toContain('inline-payload-limit');
    expect(inlineHistoryBytes([result])).toBe(0);
  });

  it('stops aborted preparation instead of sending a fallback model request', async () => {
    const controller = new AbortController();
    const file = { path: '/voice.wav', filename: 'voice.wav', mime: 'audio/wav' };
    const prepare: typeof prepareAudio = async () => {
      controller.abort();
      return { kind: 'file-reference', reason: 'aborted' };
    };
    await expect(
      prepareNativeUserMessage('listen', [file], audioModel, {
        prepare,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('preserves generic references without affecting non-audio prompts', () => {
    expect(audioReferencePrompt('hello', undefined, 'adapter-does-not-support-audio')).toBe('hello');
    const text = audioReferencePrompt(
      'hello',
      [
        {
          path: '/voice.ogg',
          filename: 'voice.ogg',
          mime: 'audio/ogg',
        },
      ],
      'adapter-does-not-support-audio',
    );
    expect(text).toContain('/voice.ogg');
    expect(text).toContain('adapter-does-not-support-audio');
  });
});
