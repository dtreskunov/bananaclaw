import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolExecutionOptions } from 'ai';

import { MAX_INLINE_BYTES } from './attachments.js';
import { createNativeMediaTools, createNativeMediaBudget } from './media.js';

const options: ToolExecutionOptions = { toolCallId: 'media', messages: [] };
const model = { protocol: 'openai-chat' as const, inputModalities: ['image', 'pdf', 'audio', 'video'] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=', 'base64');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const wav = Buffer.alloc(46);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(2, 40);
const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.alloc(413)]);
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const webm = Buffer.from('1a45dfa3874282847765626d', 'hex');
const fixtures = [
  ['view_image', 'image/png', png],
  ['view_pdf', 'application/pdf', pdf],
  ['listen_audio', 'audio/wav', wav],
  ['listen_audio', 'audio/mpeg', mp3],
  ['view_video', 'video/mp4', mp4],
  ['view_video', 'video/webm', webm],
] as const;
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-media-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('native original-file media tools', () => {
  it.each(fixtures)('%s sends unchanged %s bytes without trusting extensions', async (name, mime, bytes) => {
    const filename = path.join(root, 'wrong.txt');
    fs.writeFileSync(filename, bytes);
    fs.symlinkSync(filename, path.join(root, 'linked'));
    const candidate = createNativeMediaTools(root, model, createNativeMediaBudget())[name]!;
    for (const inputPath of ['wrong.txt', filename, 'linked']) {
      const output = await candidate.execute!({ path: inputPath }, options);
      expect(output).toEqual({ path: path.resolve(root, inputPath), mime, data: bytes.toString('base64') });
      expect(await candidate.toModelOutput!({ toolCallId: 'media', input: { path: inputPath }, output })).toEqual({
        type: 'content', value: [
          { type: 'text', text: expect.stringContaining(path.resolve(root, inputPath)) },
          { type: 'file', mediaType: mime, data: { type: 'data', data: bytes.toString('base64') } },
        ],
      });
    }
  });

  it('recognizes MP3 after an ID3 tag but rejects truncated tags and other audio containers', async () => {
    const candidate = createNativeMediaTools(root, model, createNativeMediaBudget()).listen_audio!;
    const filename = path.join(root, 'sound');
    fs.writeFileSync(filename, Buffer.concat([Buffer.from('49443304000000000000', 'hex'), mp3]));
    expect(await candidate.execute!({ path: filename }, options)).toMatchObject({ mime: 'audio/mpeg' });
    for (const bytes of [
      Buffer.from('49443304000000000000', 'hex'), Buffer.from('OggS'), Buffer.from('fLaC'),
      Buffer.from([0xff, 0xf1, 0x50, 0x80]), wav.subarray(0, 40),
    ]) {
      fs.writeFileSync(filename, bytes);
      await expect(candidate.execute!({ path: filename }, options)).rejects.toThrow('Unsupported or truncated audio');
    }
  });

  it.each(['isom', 'iso2', 'avc1', 'mp41', 'mp42', 'dash', 'M4V '])(
    'accepts the aligned MP4 brand %s without requiring an mp4 substring',
    async (brand) => {
      const bytes = Buffer.from('000000106674797069736f6d00000200', 'hex');
      bytes.write(brand, 8);
      fs.writeFileSync(path.join(root, 'video'), bytes);
      expect(await createNativeMediaTools(root, model, createNativeMediaBudget()).view_video!
        .execute!({ path: 'video' }, options)).toMatchObject({ mime: 'video/mp4' });
    },
  );

  it.each(['qt  ', 'M4A ', 'xmp4'])('rejects unsupported or unaligned MP4-like brand %s', async (brand) => {
    const bytes = Buffer.from('000000106674797069736f6d00000200', 'hex');
    bytes.write(brand, 8);
    fs.writeFileSync(path.join(root, 'video'), bytes);
    await expect(createNativeMediaTools(root, model, createNativeMediaBudget()).view_video!
      .execute!({ path: 'video' }, options)).rejects.toThrow('Unsupported or truncated video');
  });

  it.each(['view_image', 'view_pdf', 'listen_audio', 'view_video'] as const)(
    '%s surfaces missing, nonregular, empty, invalid, and truncated files without consuming budget',
    async (name) => {
      const bytes = fixtures.find(([tool]) => tool === name)![2];
      const budget = createNativeMediaBudget(bytes.toString('base64').length);
      const candidate = createNativeMediaTools(root, model, budget)[name]!;
      await expect(candidate.execute!({ path: 'missing' }, options)).rejects.toThrow('ENOENT');
      await expect(candidate.execute!({ path: root }, options)).rejects.toThrow('regular');
      for (const invalid of [Buffer.alloc(0), Buffer.from('<html/>'), bytes.subarray(0, 7)]) {
        fs.writeFileSync(path.join(root, 'invalid'), invalid);
        await expect(candidate.execute!({ path: 'invalid' }, options)).rejects.toThrow(
          invalid.length ? 'Unsupported or truncated' : 'empty',
        );
      }
      fs.writeFileSync(path.join(root, 'valid'), bytes);
      expect(await candidate.execute!({ path: 'valid' }, options)).toMatchObject({ mime: fixtures.find(([tool]) => tool === name)![1] });
      expect(budget.remaining).toBe(0);
    },
  );

  it('shares one exact encoded budget across parallel PDF, audio, video, and image reads', async () => {
    const bytes = [pdf, wav, mp4, png];
    const size = bytes.reduce((sum, data) => sum + data.toString('base64').length, 0);
    const budget = createNativeMediaBudget(size);
    const candidates = createNativeMediaTools(root, model, budget);
    const tools = [candidates.view_pdf!, candidates.listen_audio!, candidates.view_video!, candidates.view_image!];
    bytes.forEach((data, index) => fs.writeFileSync(path.join(root, String(index)), data));
    expect(await Promise.allSettled(tools.map((candidate, index) =>
      candidate.execute!({ path: String(index) }, options)))).toEqual(
      tools.map(() => expect.objectContaining({ status: 'fulfilled' })),
    );
    expect(budget.remaining).toBe(0);
    await expect(candidates.view_pdf!.execute!({ path: '0' }, options)).rejects.toThrow('media budget');
  });

  it('signals recoverable pressure, rejects oversized files before reading, and honors cancellation', async () => {
    const filename = path.join(root, 'document');
    fs.writeFileSync(filename, pdf);
    let pressure = 0;
    const size = pdf.toString('base64').length;
    await expect(createNativeMediaTools(root, model, createNativeMediaBudget(size - 1), () => { pressure++; })
      .view_pdf!.execute!({ path: filename }, options)).rejects.toThrow('media budget');
    expect(pressure).toBe(1);
    fs.truncateSync(filename, Math.floor(MAX_INLINE_BYTES * 3 / 4) + 1);
    const read = spyOn(fs, 'readSync');
    const open = spyOn(fs, 'openSync');
    try {
      await expect(createNativeMediaTools(root, model, createNativeMediaBudget(), () => { pressure++; })
        .view_pdf!.execute!({ path: filename }, options)).rejects.toThrow('media budget');
      expect(pressure).toBe(1);
      expect(read).not.toHaveBeenCalled();
      open.mockClear();
      const controller = new AbortController();
      controller.abort();
      await expect(createNativeMediaTools(root, model, createNativeMediaBudget()).view_pdf!
        .execute!({ path: filename }, { ...options, abortSignal: controller.signal })).rejects.toThrow();
      expect(open).not.toHaveBeenCalled();
    } finally { read.mockRestore(); open.mockRestore(); }
  });

  it('detects changing files without spending the shared budget', async () => {
    const filename = path.join(root, 'document');
    fs.writeFileSync(filename, pdf);
    const originalRead = fs.readSync;
    const read = spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      fs.appendFileSync(filename, Buffer.from([0]));
      return originalRead(...args);
    });
    const budget = createNativeMediaBudget(pdf.toString('base64').length);
    try {
      await expect(createNativeMediaTools(root, model, budget).view_pdf!
        .execute!({ path: filename }, options)).rejects.toThrow('changed while being read');
      expect(budget.remaining).toBe(pdf.toString('base64').length);
    } finally { read.mockRestore(); }
  });

  it.each([-1, MAX_INLINE_BYTES + 1, 0.5, NaN])('rejects invalid budget %s', (size) => {
    expect(() => createNativeMediaBudget(size)).toThrow('Invalid native media byte budget');
  });
});
