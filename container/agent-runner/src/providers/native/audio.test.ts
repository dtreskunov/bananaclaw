import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import { audioTesting, prepareAudio } from './audio.js';
import type { FileAttachment } from '../types.js';

let root: string;
let tempDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.audio-test-'));
  tempDir = path.join(root, 'temporary');
  fs.mkdirSync(tempDir);
});
afterEach(() => {
  try {
    expect(fs.readdirSync(tempDir)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const haveTools = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0,
);

function attachment(filename: string): FileAttachment {
  return { path: filename, filename: path.basename(filename), mime: 'application/octet-stream' };
}

function fixture(extension: string, codec: string, extra: string[] = []): FileAttachment {
  const filename = path.join(root, `voice.${extension}`);
  const result = spawnSync('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.3',
    '-c:a',
    codec,
    ...extra,
    filename,
  ]);
  if (result.status !== 0) throw new Error('Fixture generation failed');
  return attachment(filename);
}

function metadata(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: { format_name: 'wav', duration: '1.0' },
      streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '44100' }],
      ...overrides,
    }),
  );
}

describe('audio bounds and safe failure handling', () => {
  it('accepts only absolute local regular non-symlink files', async () => {
    for (const filename of ['https://example.invalid/a.mp3', 'voice.wav', 'file:///voice.wav', '/x\0y']) {
      expect(await prepareAudio(attachment(filename), { tempDir })).toEqual({
        kind: 'file-reference',
        reason: 'audio-path-not-local',
      });
    }
    expect(await prepareAudio(attachment(root), { tempDir })).toEqual({
      kind: 'file-reference',
      reason: 'audio-input-not-regular',
    });
    const source = path.join(root, 'original');
    fs.writeFileSync(source, 'not audio');
    const link = path.join(root, 'link');
    fs.symlinkSync(source, link);
    for (const filename of [link, path.join(root, 'missing')]) {
      expect(await prepareAudio(attachment(filename), { tempDir })).toEqual({
        kind: 'file-reference',
        reason: 'audio-input-unavailable',
      });
    }
  });

  it('rejects empty and oversized files before launching tools', async () => {
    const filename = path.join(root, 'large.wav');
    fs.writeFileSync(filename, '');
    expect(await prepareAudio(attachment(filename), { tempDir })).toEqual({
      kind: 'file-reference',
      reason: 'audio-input-empty',
    });
    fs.truncateSync(filename, 20 * 1024 * 1024 + 1);
    expect(await prepareAudio(attachment(filename), { tempDir })).toEqual({
      kind: 'file-reference',
      reason: 'audio-input-size-limit',
    });
  });

  it('rejects playlists and arbitrary files without trusting MIME or extension', async () => {
    const filename = path.join(root, 'voice.mp3');
    fs.writeFileSync(filename, '#EXTM3U\nhttps://example.invalid/live\n');
    expect(await prepareAudio({ ...attachment(filename), mime: 'audio/mpeg' }, { tempDir })).toEqual({
      kind: 'file-reference',
      reason: 'unsupported-audio-container',
    });
  });

  it('validates caller bounds and honors cancellation', async () => {
    await expect(prepareAudio(attachment('/missing'), { maxOutputBytes: NaN })).rejects.toThrow(
      'Invalid audio output limit',
    );
    const controller = new AbortController();
    controller.abort();
    await expect(prepareAudio(attachment('/missing'), { signal: controller.signal })).rejects.toThrow();
  });

  it('validates ffprobe JSON, duration, codecs, channels, and sample rates', () => {
    const parse = (bytes: Buffer) => audioTesting.parseProbe(bytes, 'wav');
    expect(parse(metadata()).codec).toBe('pcm_s16le');
    for (const invalid of [
      Buffer.from('not JSON'),
      Buffer.from('null'),
      Buffer.from('[]'),
      metadata({ format: null }),
      metadata({ streams: [] }),
      metadata({ streams: [null] }),
      metadata({ format: { format_name: 'hls', duration: '1' } }),
      ...['601', 'NaN', '-1', {}].map((duration) => metadata({ format: { format_name: 'wav', duration } })),
      ...[
        { codec_type: 'video' },
        { codec_name: 'unknown' },
        { channels: 9 },
        { channels: '2' },
        { sample_rate: '0' },
        { sample_rate: '384000' },
        { duration: '601' },
        { duration: 'bad' },
      ].map((overrides) =>
        metadata({
          streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '44100', ...overrides }],
        }),
      ),
    ])
      expect(() => parse(invalid)).toThrow();
  });

  it('bounds subprocess time, stdout and stderr without exposing diagnostics', async () => {
    const run = (script: string, timeout = 1000, max = 100) =>
      audioTesting.runTool(process.execPath, ['-e', script], timeout, max, 'test');
    await expect(run('setTimeout(() => {}, 10000)', 20)).rejects.toThrow('test-timeout');
    await expect(run('process.stdout.write("x".repeat(101))')).rejects.toThrow('test-output-limit');
    await expect(run('process.stderr.write("secret".repeat(12000))')).rejects.toThrow('test-diagnostic-limit');
    await expect(run('process.stderr.write("secret"); process.exit(1)')).rejects.toThrow('test-failed');
    expect((await run('process.stdout.write("ok")')).toString()).toBe('ok');
    const controller = new AbortController();
    const pending = audioTesting.runTool(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)'],
      1000,
      100,
      'test',
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe.skipIf(!haveTools)('real ffmpeg audio inspection and conversion', () => {
  it.each([1, 601])(
    'measures duration-less live WebM (%s seconds) without accepting a truncated prefix',
    async (duration) => {
      const filename = path.join(root, 'live.webm');
      const generated = spawnSync(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=48000:cl=mono',
          '-t',
          String(duration),
          '-c:a',
          'libopus',
          '-live',
          '1',
          '-f',
          'webm',
          'pipe:1',
        ],
        { maxBuffer: 20 * 1024 * 1024 },
      );
      expect(generated.status).toBe(0);
      fs.writeFileSync(filename, generated.stdout);
      const inspected = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filename],
        { encoding: 'utf8' },
      );
      expect(inspected.status).toBe(0);
      expect(JSON.parse(inspected.stdout).format.duration).toBeUndefined();
      const prepared = await prepareAudio(attachment(filename), { tempDir });
      if (duration > 600) expect(prepared).toEqual({ kind: 'file-reference', reason: 'audio-duration-limit' });
      else {
        if (prepared.kind !== 'inline') throw new Error(prepared.reason);
        expect(prepared.converted).toBe(true);
        expect(prepared.file.mime).toBe('audio/mpeg');
      }
      expect(fs.readFileSync(filename)).toEqual(generated.stdout);
    },
    30_000,
  );

  it('passes compatible WAV and MP3 bytes unchanged using actual canonical MIME', async () => {
    for (const [extension, codec, mime] of [
      ['wav', 'pcm_s16le', 'audio/wav'],
      ['mp3', 'libmp3lame', 'audio/mpeg'],
    ]) {
      const file = fixture(extension, codec);
      const original = fs.readFileSync(file.path);
      const result = await prepareAudio(file, { tempDir });
      if (result.kind !== 'inline') throw new Error(result.reason);
      expect(result.bytes).toEqual(original);
      expect(result.file.mime).toBe(mime);
      expect(result.converted).toBe(false);
    }
  });

  it.each([
    ['ogg', 'libopus'],
    ['webm', 'libopus'],
    ['m4a', 'aac'],
    ['aac', 'aac'],
    ['flac', 'flac'],
    ['wav', 'pcm_s24le'],
  ])(
    'converts %s to normalized MP3, preserving the source without retaining output files',
    async (extension, codec) => {
      const file = fixture(extension, codec);
      const original = fs.readFileSync(file.path);
      const result = await prepareAudio(file, { tempDir });
      if (result.kind !== 'inline') throw new Error(result.reason);
      expect(result.converted).toBe(true);
      expect(result.file).toEqual({ mime: 'audio/mpeg', filename: 'voice.mp3' });
      expect(fs.readFileSync(file.path)).toEqual(original);
      expect(fs.readdirSync(tempDir)).toEqual([]);
      const info = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-f',
          'mp3',
          '-show_entries',
          'stream=codec_name,channels,sample_rate',
          '-of',
          'json',
          'pipe:0',
        ],
        { input: result.bytes, encoding: 'utf8' },
      );
      expect(info.status).toBe(0);
      expect(JSON.parse(info.stdout).streams).toEqual([{ codec_name: 'mp3', sample_rate: '48000', channels: 2 }]);
    },
  );

  it('normalizes multichannel high-rate WAV rather than passing it directly', async () => {
    const result = await prepareAudio(fixture('wav', 'pcm_s16le', ['-ac', '6', '-ar', '96000']), { tempDir });
    if (result.kind !== 'inline') throw new Error(result.reason);
    expect(result.converted).toBe(true);
    expect(result.file.mime).toBe('audio/mpeg');
  });

  it('keeps concurrent preparations independent and cleans their temporary files', async () => {
    const file = fixture('ogg', 'libopus');
    const results = await Promise.all(Array.from({ length: 5 }, () => prepareAudio(file, { tempDir })));
    for (const result of results) {
      if (result.kind !== 'inline') throw new Error(result.reason);
      expect(result.converted).toBe(true);
      expect(result.bytes.length).toBeGreaterThan(0);
    }
  });

  it('prepares identical recordings again instead of reusing a prior conversion', async () => {
    const file = fixture('flac', 'flac');
    expect((await prepareAudio(file, { tempDir })).kind).toBe('inline');
    expect(fs.readdirSync(tempDir)).toEqual([]);
    const originalPath = process.env.PATH;
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
    try {
      process.env.PATH = `${bin}:${originalPath}`;
      expect(await prepareAudio(file, { tempDir })).toEqual({ kind: 'file-reference', reason: 'conversion-failed' });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('enforces caller output bounds for direct and converted media', async () => {
    for (const file of [fixture('wav', 'pcm_s16le'), fixture('ogg', 'libopus')]) {
      expect(await prepareAudio(file, { tempDir, maxOutputBytes: 1 })).toEqual({
        kind: 'file-reference',
        reason: 'audio-output-size-limit',
      });
    }
  });

  it('reports unavailable temporary storage and corrupt media explicitly', async () => {
    const file = fixture('wav', 'pcm_s16le');
    expect(await prepareAudio(file, { tempDir: path.join(root, 'missing') })).toEqual({
      kind: 'file-reference',
      reason: 'audio-temp-unavailable',
    });
    fs.writeFileSync(file.path, 'RIFFxxxxWAVEbroken');
    expect(await prepareAudio(file, { tempDir })).toEqual({ kind: 'file-reference', reason: 'probe-failed' });
  });

  it('cleans private temporary files when preparation is cancelled', async () => {
    const file = fixture('flac', 'flac');
    const originalPath = process.env.PATH;
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ffprobe'), `#!${process.execPath}\nsetTimeout(() => {}, 10000);\n`, {
      mode: 0o700,
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      process.env.PATH = `${bin}:${originalPath}`;
      const pending = prepareAudio(file, { tempDir, signal: controller.signal });
      const entry = await (async () => {
        for (let i = 0; i < 100; i++) {
          const entries = fs.readdirSync(tempDir);
          if (entries[0]) return path.join(tempDir, entries[0]);
          await Bun.sleep(5);
        }
        throw new Error('Temporary directory was not created');
      })();
      expect(fs.statSync(entry).mode & 0o777).toBe(0o700);
      timer = setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toThrow();
    } finally {
      controller.abort();
      clearTimeout(timer);
      process.env.PATH = originalPath;
    }
  });

  it('falls back on missing ffprobe and conversion failure without retaining partial output', async () => {
    const file = fixture('flac', 'flac');
    const originalPath = process.env.PATH;
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    try {
      process.env.PATH = bin;
      expect(await prepareAudio(file, { tempDir })).toEqual({ kind: 'file-reference', reason: 'probe-unavailable' });
      process.env.PATH = `${bin}:${originalPath}`;
      fs.writeFileSync(
        path.join(bin, 'ffmpeg'),
        [
          `#!${process.execPath}`,
          'process.stdout.write("partial");',
          'process.stderr.write("private diagnostic");',
          'process.exit(1);',
        ].join('\n'),
        { mode: 0o700 },
      );
      expect(await prepareAudio(file, { tempDir })).toEqual({ kind: 'file-reference', reason: 'conversion-failed' });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('rejects video-bearing WebM instead of treating an arbitrary container as audio', async () => {
    const filename = path.join(root, 'video.webm');
    const result = spawnSync('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=size=16x16:duration=0.1',
      '-c:v',
      'libvpx',
      filename,
    ]);
    expect(result.status).toBe(0);
    expect((await prepareAudio(attachment(filename), { tempDir })).kind).toBe('file-reference');
  });

  it('rejects actual audio longer than ten minutes without truncation', async () => {
    const filename = path.join(root, 'long.flac');
    const result = spawnSync('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono',
      '-t',
      '601',
      '-c:a',
      'flac',
      filename,
    ]);
    expect(result.status).toBe(0);
    expect(await prepareAudio(attachment(filename), { tempDir })).toEqual({
      kind: 'file-reference',
      reason: 'audio-duration-limit',
    });
  });

  it('enforces the hard 10MiB output cap even when the caller allows more', async () => {
    const filename = path.join(root, 'large.wav');
    const result = spawnSync('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      '60',
      '-c:a',
      'pcm_s16le',
      filename,
    ]);
    expect(result.status).toBe(0);
    expect(fs.statSync(filename).size).toBeGreaterThan(10 * 1024 * 1024);
    expect(await prepareAudio(attachment(filename), { tempDir, maxOutputBytes: 30 * 1024 * 1024 })).toEqual({
      kind: 'file-reference',
      reason: 'audio-output-size-limit',
    });
  });
});
