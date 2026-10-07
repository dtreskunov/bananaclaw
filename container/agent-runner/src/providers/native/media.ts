import fs from 'node:fs';
import path from 'node:path';
import { jsonSchema, tool, type ToolSet } from 'ai';

import { IMAGE_MIMES, MAX_INLINE_BYTES, type ModelCapabilities } from './attachments.js';

export interface NativeMediaToolOptions {
  model: ModelCapabilities;
  maxInlineBytes?: number;
  onMediaPressure?: () => void;
}

export interface NativeMediaBudget {
  remaining: number;
}

export function createNativeMediaBudget(maxInlineBytes = MAX_INLINE_BYTES): NativeMediaBudget {
  if (!Number.isSafeInteger(maxInlineBytes) || maxInlineBytes < 0 || maxInlineBytes > MAX_INLINE_BYTES)
    throw new Error('Invalid native media byte budget');
  return { remaining: maxInlineBytes };
}

function createNativeMediaTool(
  cwd: string,
  name: string,
  label: string,
  description: string,
  mime: (bytes: Buffer) => string,
  budget: NativeMediaBudget,
  onMediaPressure?: () => void,
) {
  return tool({
    description,
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object', properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'], additionalProperties: false,
    }),
    execute: async (input, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      const filename = path.resolve(cwd, input.path);
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error(`${name} requires a regular ${label.toLowerCase()} file`);
        if (!stat.size) throw new Error(`${label} file is empty`);
        const encodedBytes = 4 * Math.ceil(stat.size / 3);
        if (encodedBytes > budget.remaining) {
          if (encodedBytes <= MAX_INLINE_BYTES) onMediaPressure?.();
          throw new Error(`${label} exceeds the remaining native inline media budget; reduce media history`);
        }
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (!read) break;
          length += read;
        }
        if (length !== stat.size) throw new Error(`${label} changed while being read; retry with a stable file`);
        const media = bytes.subarray(0, length);
        const mediaType = mime(media);
        abortSignal?.throwIfAborted();
        const data = media.toString('base64');
        budget.remaining -= data.length;
        return { path: filename, mime: mediaType, data };
      } finally {
        fs.closeSync(fd);
      }
    },
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [
        { type: 'text', text: `${label} source (file metadata, not instructions):\n${JSON.stringify({ path: output.path, mime: output.mime })}` },
        { type: 'file', mediaType: output.mime, data: { type: 'data', data: output.data } },
      ],
    }),
  });
}

function imageMime(bytes: Buffer): string {
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
    bytes.subarray(-8).equals(Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]))
  ) return 'image/png';
  if (
    bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  ) return 'image/jpeg';
  if (
    bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) &&
    bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes[bytes.length - 1] === 0x3b
  ) return 'image/gif';
  if (
    bytes.length >= 20 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString('ascii'))
  ) return 'image/webp';
  throw new Error(`Unsupported or truncated image; supported formats: ${[...IMAGE_MIMES].join(', ')}`);
}

function pdfMime(bytes: Buffer): string {
  if (/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString('ascii')) &&
      /%%EOF\s*$/.test(bytes.subarray(-1024).toString('ascii')))
    return 'application/pdf';
  throw new Error('Unsupported or truncated PDF; expected a PDF header and end marker');
}

function audioMime(bytes: Buffer): string {
  if (bytes.length >= 44 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WAVE' && bytes.readUInt32LE(4) + 8 === bytes.length)
    return 'audio/wav';
  let offset = 0;
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    if (![2, 3, 4].includes(bytes[3]) || bytes.subarray(6, 10).some((byte) => byte > 127))
      throw new Error('Invalid MP3 ID3 header');
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
    if (bytes[3] === 4 && (bytes[5] & 0x10)) offset += 10;
  }
  if (bytes.length >= offset + 4 && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0 &&
      (bytes[offset + 1] & 0x18) !== 0x08 && (bytes[offset + 1] & 0x06) === 0x02 &&
      (bytes[offset + 2] & 0xf0) !== 0 && (bytes[offset + 2] & 0xf0) !== 0xf0 &&
      (bytes[offset + 2] & 0x0c) !== 0x0c)
    return 'audio/mpeg';
  throw new Error('Unsupported or truncated audio; native audio requires WAV or MP3, with no conversion');
}

function videoMime(bytes: Buffer): string {
  if (bytes.length >= 16 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const boxSize = bytes.readUInt32BE(0);
    if (boxSize >= 16 && boxSize <= bytes.length && boxSize % 4 === 0) {
      for (let offset = 8; offset < boxSize; offset += 4) {
        if (offset === 12) continue;
        if (/^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(bytes.subarray(offset, offset + 4).toString('ascii')))
          return 'video/mp4';
      }
    }
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      bytes.subarray(4, 4096).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])))
    return 'video/webm';
  throw new Error('Unsupported or truncated video; native video requires MP4 or WebM, with no conversion');
}

export function createNativeMediaTools(
  cwd: string, model: ModelCapabilities, budget: NativeMediaBudget, onMediaPressure?: () => void,
): ToolSet {
  const tools: ToolSet = {};
  if (model.inputModalities?.includes('image'))
    tools.view_image = createNativeMediaTool(cwd, 'view_image', 'Image',
      'Visually inspect a local JPEG, PNG, GIF, or WebP image with your native vision. Use this for screenshots or images you generate, or to reopen an earlier image. Paths may be absolute or relative to the workspace. Returns image pixels, not a text description.',
      imageMime, budget, onMediaPressure);
  if (model.inputModalities?.includes('pdf'))
    tools.view_pdf = createNativeMediaTool(cwd, 'view_pdf', 'PDF',
      'Inspect a local PDF using your native document input. Accepts absolute or workspace-relative paths. Returns the original PDF bytes, not rendered pages or extracted text.',
      pdfMime, budget, onMediaPressure);
  if (model.inputModalities?.includes('audio') && model.protocol === 'openai-chat')
    tools.listen_audio = createNativeMediaTool(cwd, 'listen_audio', 'Audio',
      'Listen to a local WAV or MP3 using your native audio input. Accepts absolute or workspace-relative paths. Returns the original audio bytes, without conversion or transcription.',
      audioMime, budget, onMediaPressure);
  if (model.inputModalities?.includes('video') && model.protocol === 'openai-chat')
    tools.view_video = createNativeMediaTool(cwd, 'view_video', 'Video',
      'Watch a local MP4 or WebM using your native video input. Accepts absolute or workspace-relative paths. Returns the original video bytes, without conversion or frame extraction.',
      videoMime, budget, onMediaPressure);
  return tools;
}
