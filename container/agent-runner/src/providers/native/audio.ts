import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FileAttachment } from '../types.js';

const MAX_INPUT = 20 * 1024 * 1024;
const MAX_OUTPUT = 10 * 1024 * 1024;
const MAX_DURATION = 600;
const EXPECTED_IO = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ELOOP',
  'ENOTDIR',
  'EISDIR',
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EIO',
]);

export type PreparedAudio =
  | { kind: 'inline'; file: Pick<FileAttachment, 'mime' | 'filename'>; bytes: Buffer; converted: boolean }
  | { kind: 'file-reference'; reason: string };

type Options = { tempDir?: string; maxOutputBytes?: number; signal?: AbortSignal };
type Family = 'mp3' | 'wav' | 'ogg' | 'matroska' | 'mov' | 'aac' | 'flac';
type Media = { family: Family; codec: string; channels: number; sampleRate: number; duration?: number };

class AudioFailure extends Error {}

function ioCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function fail(reason: string): never {
  throw new AudioFailure(reason);
}

async function localBytes(filename: string, max: number, reason: string): Promise<Buffer> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(`${reason}-not-regular`);
    if (stat.size === 0) fail(`${reason}-empty`);
    if (stat.size > max) fail(`${reason}-size-limit`);
    // Read one byte beyond the bound to detect a file growing after stat.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) fail(`${reason}-changed`);
    if (length !== stat.size) fail(`${reason}-changed`);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function familyOf(bytes: Buffer): Family {
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'matroska';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'mov';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE')
    return 'wav';
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (bytes.length >= 2 && bytes[0] === 0xff) {
    if ((bytes[1] & 0xf6) === 0xf0) return 'aac';
    if ((bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return 'mp3';
  }
  return fail('unsupported-audio-container');
}

async function runTool(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxStdout: number,
  stage: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const chunks: Buffer[] = [];
    let stdout = 0;
    let stderr = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new DOMException('Audio preparation aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new AudioFailure(`${stage}-timeout`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.length;
      if (stdout > maxStdout) stop(new AudioFailure(`${stage}-output-limit`));
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.length;
      if (stderr > 64 * 1024) stop(new AudioFailure(`${stage}-diagnostic-limit`));
    });
    child.on('error', (error) => {
      failure ??= EXPECTED_IO.has(ioCode(error) ?? '')
        ? new AudioFailure(`${stage}-unavailable`)
        : new Error(`Unexpected audio ${stage} process error`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new AudioFailure(`${stage}-failed`));
      else resolve(Buffer.concat(chunks, stdout));
    });
    if (signal?.aborted) abort();
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveNumber(value: unknown): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isFinite(number) && number > 0 ? number : NaN;
}

function parseProbe(bytes: Buffer, family: Family): Media {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail('probe-invalid-metadata');
  }
  if (
    !object(data) ||
    !object(data.format) ||
    !Array.isArray(data.streams) ||
    data.streams.length !== 1 ||
    !object(data.streams[0])
  )
    fail('probe-invalid-metadata');
  const stream = data.streams[0];
  const format = data.format;
  const names: Record<Family, string> = {
    mp3: 'mp3',
    wav: 'wav',
    ogg: 'ogg',
    matroska: 'matroska,webm',
    mov: 'mov,mp4,m4a,3gp,3g2,mj2',
    aac: 'aac',
    flac: 'flac',
  };
  if (format.format_name !== names[family] || stream.codec_type !== 'audio' || typeof stream.codec_name !== 'string')
    fail('unsupported-audio-streams');
  const codecs: Record<Family, RegExp> = {
    mp3: /^mp3$/,
    wav: /^(pcm_[a-z0-9_]+|mp3|aac|adpcm_[a-z0-9_]+)$/,
    ogg: /^(opus|vorbis|flac)$/,
    matroska: /^(opus|vorbis)$/,
    mov: /^(aac|alac|mp3)$/,
    aac: /^aac$/,
    flac: /^flac$/,
  };
  if (!codecs[family].test(stream.codec_name)) fail('unsupported-audio-codec');
  const channels = stream.channels;
  const sampleRate = positiveNumber(stream.sample_rate);
  const duration =
    format.duration === undefined || format.duration === 'N/A' ? undefined : positiveNumber(format.duration);
  if (
    typeof channels !== 'number' ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 8 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    (duration !== undefined && !Number.isFinite(duration))
  )
    fail('probe-invalid-metadata');
  const streamDuration =
    stream.duration === undefined || stream.duration === 'N/A' ? duration : positiveNumber(stream.duration);
  if (streamDuration !== undefined && !Number.isFinite(streamDuration)) fail('probe-invalid-metadata');
  const longest = Math.max(duration ?? 0, streamDuration ?? 0);
  if (longest > MAX_DURATION) fail('audio-duration-limit');
  return { family, codec: stream.codec_name, channels, sampleRate, duration: longest || undefined };
}

async function measureDuration(filename: string, family: Family, signal?: AbortSignal): Promise<number> {
  // Live WebM has no duration header. Decode to bounded PCM, rather than trusting
  // a suffix timestamp or cutting the input at the limit and accepting a prefix.
  try {
    const pcm = await runTool(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-xerror',
        '-f',
        family,
        '-i',
        filename,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-af',
        'aresample=async=1:first_pts=0',
        '-threads',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ],
      10_000,
      MAX_DURATION * 8000 * 2,
      'duration-probe',
      signal,
    );
    if (!pcm.length || pcm.length % 2 !== 0) fail('probe-invalid-metadata');
    return pcm.length / (8000 * 2);
  } catch (error) {
    if (error instanceof AudioFailure && error.message === 'duration-probe-output-limit') {
      fail('audio-duration-limit');
    }
    throw error;
  }
}

async function probe(filename: string, family: Family, signal?: AbortSignal): Promise<Media> {
  const bytes = await runTool(
    'ffprobe',
    [
      '-v',
      'error',
      '-f',
      family,
      '-show_entries',
      'format=format_name,duration:stream=codec_type,codec_name,channels,sample_rate,duration',
      '-of',
      'json',
      filename,
    ],
    10_000,
    64 * 1024,
    'probe',
    signal,
  );
  const media = parseProbe(bytes, family);
  if (media.duration === undefined) media.duration = await measureDuration(filename, family, signal);
  return media;
}

async function convert(input: string, family: Family, output: string, signal?: AbortSignal): Promise<Buffer> {
  const bytes = await runTool(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-xerror',
      '-f',
      family,
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-threads',
      '1',
      '-f',
      'mp3',
      'pipe:1',
    ],
    30_000,
    MAX_OUTPUT,
    'conversion',
    signal,
  );
  if (!bytes.length) fail('conversion-empty');
  // Validate the complete encoded result, never a truncated prefix.
  await fs.writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
  const media = await probe(output, 'mp3', signal);
  if (familyOf(bytes) !== 'mp3' || media.channels !== 2 || media.sampleRate !== 48000) {
    fail('conversion-invalid-output');
  }
  return bytes;
}

export async function prepareAudio(file: FileAttachment, options: Options = {}): Promise<PreparedAudio> {
  const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT;
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) throw new TypeError('Invalid audio output limit');
  options.signal?.throwIfAborted();
  if (!path.isAbsolute(file.path) || file.path.includes('\0')) {
    return { kind: 'file-reference', reason: 'audio-path-not-local' };
  }
  let workDir: string | undefined;
  let stage = 'audio-input';
  try {
    const bytes = await localBytes(file.path, MAX_INPUT, 'audio-input');
    const family = familyOf(bytes);
    stage = 'audio-temp';
    workDir = await fs.mkdtemp(path.join(options.tempDir ?? os.tmpdir(), 'nanoclaw-audio-'));
    const snapshot = path.join(workDir, 'input');
    await fs.writeFile(snapshot, bytes, { flag: 'wx', mode: 0o600 });
    const media = await probe(snapshot, family, options.signal);
    const direct =
      (family === 'mp3' || (family === 'wav' && media.codec === 'pcm_s16le')) &&
      media.channels <= 2 &&
      media.sampleRate <= 48000;
    const bound = Math.min(maxOutput, MAX_OUTPUT);
    if (direct) {
      if (bytes.length > bound) fail('audio-output-size-limit');
      return {
        kind: 'inline',
        file: { filename: file.filename, mime: family === 'wav' ? 'audio/wav' : 'audio/mpeg' },
        bytes,
        converted: false,
      };
    }
    const converted = await convert(snapshot, family, path.join(workDir, 'output.mp3'), options.signal);
    if (converted.length > bound) fail('audio-output-size-limit');
    return {
      kind: 'inline',
      file: { mime: 'audio/mpeg', filename: `${path.parse(file.filename).name}.mp3` },
      bytes: converted,
      converted: true,
    };
  } catch (error) {
    if (error instanceof AudioFailure) return { kind: 'file-reference', reason: error.message };
    if (EXPECTED_IO.has(ioCode(error) ?? '')) return { kind: 'file-reference', reason: `${stage}-unavailable` };
    if (error instanceof Error && error.name === 'AbortError') throw error;
    // Keep paths, tool diagnostics, and audio out of errors that callers may log.
    throw new Error('Unexpected audio preparation failure');
  } finally {
    if (workDir) {
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {
        throw new Error('Audio temporary file cleanup failed');
      }
    }
  }
}

export const audioTesting = { runTool, parseProbe };
